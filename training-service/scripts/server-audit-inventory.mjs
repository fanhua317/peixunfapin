import os from "node:os";
import {
  accessKeyFromArgs,
  cleanBaseUrl,
  collectDiskStatus,
  collectStateStats,
  defaultAuditOutDir,
  defaultDataDir,
  defaultProductionUrl,
  parseArgs,
  requestJson,
  resourceSnapshot,
  runCommand,
  writeJsonArtifact,
} from "./server-audit/common.mjs";

const args = parseArgs();
const outDir = args.out || defaultAuditOutDir;
const baseUrl = cleanBaseUrl(args.baseUrl || args["base-url"] || defaultProductionUrl);
const dataDir = args.dataDir || args["data-dir"] || defaultDataDir;
const accessKey = accessKeyFromArgs(args);

async function gitInfo() {
  const commit = await runCommand("git", ["rev-parse", "--short", "HEAD"], { timeoutMs: 10_000 });
  const status = await runCommand("git", ["status", "--short", "--branch"], { timeoutMs: 10_000 });
  return {
    commit: commit.ok ? commit.stdout.trim() : "",
    status: status.stdout.trim(),
  };
}

async function nodeInfo() {
  const npm = await runCommand("npm", ["--version"], { timeoutMs: 10_000 });
  return {
    node: process.version,
    npm: npm.ok ? npm.stdout.trim() : "",
  };
}

async function scheduledTasks() {
  if (process.platform !== "win32") return { supported: false };
  const result = await runCommand("powershell", [
    "-NoProfile",
    "-Command",
    "Get-ScheduledTask -TaskName JuzhouAgentTraining,JuzhouAgentTrainingWatchdog,JuzhouAgentTrainingBackup -ErrorAction SilentlyContinue | Select TaskName,State | ConvertTo-Json -Compress",
  ], { timeoutMs: 15_000 });
  if (!result.ok) return { supported: true, error: result.stderr || result.stdout };
  try {
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
    return { supported: true, tasks: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    return { supported: true, raw: result.stdout.trim() };
  }
}

async function probeApi() {
  const endpoints = [
    { name: "auth_status", endpoint: "/api/auth/status" },
    { name: "health", endpoint: "/api/health" },
    { name: "knowledge_bases", endpoint: "/api/knowledge-bases" },
    { name: "jobs", endpoint: "/api/jobs" },
    { name: "agent_runs", endpoint: "/api/agent-runs?limit=50" },
  ];
  const probes = [];
  for (const item of endpoints) {
    const result = await requestJson(baseUrl, item.endpoint, { accessKey, timeoutMs: 12_000 });
    probes.push({
      name: item.name,
      endpoint: item.endpoint,
      ok: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      note: result.status === 401 ? "auth_required" : "",
      payloadSummary: result.ok ? summarizePayload(result.payload) : undefined,
      error: result.error || result.payload?.error || "",
    });
  }
  return probes;
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  return {
    keys: Object.keys(payload).slice(0, 20),
    counts: Object.fromEntries(Object.entries(payload)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, value.length])),
    enabled: payload.enabled,
    authenticated: payload.authenticated,
    retrievalMode: payload.retrievalMode,
    llmConfigured: payload.llmConfigured,
  };
}

const inventory = {
  kind: "juzhou-server-audit-inventory",
  createdAt: new Date().toISOString(),
  baseUrl,
  dataDir,
  host: {
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
  },
  git: await gitInfo(),
  runtime: await nodeInfo(),
  resource: resourceSnapshot(dataDir),
  disk: await collectDiskStatus(dataDir),
  data: await collectStateStats(dataDir),
  scheduledTasks: await scheduledTasks(),
  apiProbes: await probeApi(),
};

const path = await writeJsonArtifact(outDir, "inventory", inventory);
console.log(JSON.stringify({ ok: true, path, summary: inventory }, null, 2));
