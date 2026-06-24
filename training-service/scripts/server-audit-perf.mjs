import {
  accessKeyFromArgs,
  asNumber,
  asNumberList,
  cleanBaseUrl,
  collectDiskStatus,
  defaultAuditOutDir,
  defaultProductionUrl,
  parseArgs,
  requestJson,
  resourceSnapshot,
  summarizeRequests,
  writeJsonArtifact,
} from "./server-audit/common.mjs";

const args = parseArgs();
const outDir = args.out || defaultAuditOutDir;
const baseUrl = cleanBaseUrl(args.baseUrl || args["base-url"] || defaultProductionUrl);
const accessKey = accessKeyFromArgs(args);
const durationMs = asNumber(args.durationMs || args["duration-ms"], 60_000);
const readLevels = asNumberList(args.readLevels || args["read-levels"], [1, 5, 10, 20, 50, 100, 200]);
const writeLevels = asNumberList(args.writeLevels || args["write-levels"], [1, 3, 5, 10, 20]);
const includeAgent = Boolean(args.includeAgent || args["include-agent"]);
const allowWrite = Boolean(args.allowWrite || args["allow-write"]);
const publicOnly = Boolean(args.publicOnly || args["public-only"]);
const maxErrorRate = asNumber(args.maxErrorRate || args["max-error-rate"], 0.1);
const maxP99Ms = asNumber(args.maxP99Ms || args["max-p99-ms"], 30_000);
const dataDir = args.dataDir || args["data-dir"] || process.env.TRAINING_DATA_DIR || "";

const readEndpoints = [
  { name: "auth_status", method: "GET", endpoint: "/api/auth/status" },
  { name: "health", method: "GET", endpoint: "/api/health" },
  { name: "knowledge_bases", method: "GET", endpoint: "/api/knowledge-bases" },
  { name: "imports", method: "GET", endpoint: "/api/imports" },
  { name: "jobs", method: "GET", endpoint: "/api/jobs" },
  { name: "agent_runs", method: "GET", endpoint: "/api/agent-runs?limit=50" },
];

const agentEndpoints = [
  {
    name: "agent_general_chat",
    method: "POST",
    endpoint: "/api/chat",
    body: () => ({
      sessionId: `audit-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message: "性能审计 mock 普通聊天，请用一句话回复。",
      forceGeneralChat: true,
    }),
  },
  {
    name: "agent_dispatch_status",
    method: "POST",
    endpoint: "/api/agent/dispatch",
    body: () => ({
      sessionId: `audit-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message: "查看培训完成情况",
    }),
  },
];

const writeEndpoints = [
  {
    name: "boss_chat_create_delete",
    method: "POST",
    endpoint: "/api/boss-chat/sessions",
    body: () => ({
      id: `audit-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: "性能审计临时会话",
      preview: "audit temporary session",
    }),
    cleanup: async (payload) => {
      const id = payload?.session?.id;
      if (!id) return null;
      return await requestJson(baseUrl, `/api/boss-chat/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        accessKey,
        timeoutMs: 15_000,
      });
    },
  },
];

function endpointSet(kind) {
  if (kind === "read" && publicOnly) return [readEndpoints[0]];
  if (kind === "read") return includeAgent ? [...readEndpoints, ...agentEndpoints] : readEndpoints;
  if (kind === "write") return writeEndpoints;
  return readEndpoints;
}

async function runOne(endpoint) {
  const body = typeof endpoint.body === "function" ? endpoint.body() : endpoint.body;
  const result = await requestJson(baseUrl, endpoint.endpoint, {
    method: endpoint.method,
    body,
    accessKey,
    timeoutMs: 30_000,
  });
  if (result.ok && endpoint.cleanup) {
    await endpoint.cleanup(result.payload);
  }
  return {
    endpoint: endpoint.name,
    method: endpoint.method,
    path: endpoint.endpoint,
    ok: result.ok,
    status: result.status,
    latencyMs: result.latencyMs,
    error: result.error || result.payload?.error || "",
  };
}

async function runLevel({ kind, concurrency, endpoints }) {
  const startedAt = Date.now();
  const results = [];
  let index = 0;
  let stopped = false;
  const samples = [resourceSnapshot(dataDir)];

  async function worker() {
    while (!stopped && Date.now() - startedAt < durationMs) {
      const endpoint = endpoints[index % endpoints.length];
      index += 1;
      results.push(await runOne(endpoint));
    }
  }

  const sampleTimer = setInterval(() => {
    samples.push(resourceSnapshot(dataDir));
  }, Math.max(1000, Math.min(10_000, durationMs / 4)));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  clearInterval(sampleTimer);
  samples.push(resourceSnapshot(dataDir));

  const elapsedMs = Date.now() - startedAt;
  const summary = summarizeRequests(results, elapsedMs);
  const stopReasons = [];
  if (summary.errorRate > maxErrorRate) stopReasons.push(`error_rate>${maxErrorRate}`);
  if (summary.p99Ms > maxP99Ms) stopReasons.push(`p99>${maxP99Ms}ms`);
  return {
    kind,
    concurrency,
    durationMs: elapsedMs,
    endpoints: endpoints.map((endpoint) => endpoint.name),
    summary,
    samples,
    stopReasons,
    sampleErrors: results.filter((item) => !item.ok).slice(0, 10),
  };
}

const levels = [];
let stoppedByRule = false;
for (const concurrency of readLevels) {
  const level = await runLevel({ kind: "read", concurrency, endpoints: endpointSet("read") });
  levels.push(level);
  console.log(`read c=${concurrency}: rps=${level.summary.rps} p99=${level.summary.p99Ms} errorRate=${level.summary.errorRate}`);
  if (level.stopReasons.length) {
    stoppedByRule = true;
    break;
  }
}

if (allowWrite && !stoppedByRule) {
  for (const concurrency of writeLevels) {
    const level = await runLevel({ kind: "write", concurrency, endpoints: endpointSet("write") });
    levels.push(level);
    console.log(`write c=${concurrency}: rps=${level.summary.rps} p99=${level.summary.p99Ms} errorRate=${level.summary.errorRate}`);
    if (level.stopReasons.length) {
      stoppedByRule = true;
      break;
    }
  }
}

const audit = {
  kind: "juzhou-server-audit-perf",
  createdAt: new Date().toISOString(),
  baseUrl,
  durationMs,
  readLevels,
  writeLevels: allowWrite ? writeLevels : [],
  includeAgent,
  allowWrite,
  publicOnly,
  stopPolicy: {
    maxErrorRate,
    maxP99Ms,
    diskFreeFloorBytes: 2 * 1024 * 1024 * 1024,
    memoryUsageCeiling: 0.9,
  },
  disk: dataDir ? await collectDiskStatus(dataDir) : null,
  stoppedByRule,
  levels,
};

const path = await writeJsonArtifact(outDir, "perf", audit);
console.log(JSON.stringify({ ok: true, path, stoppedByRule, levels: levels.map((level) => ({ kind: level.kind, concurrency: level.concurrency, summary: level.summary, stopReasons: level.stopReasons })) }, null, 2));
