import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-observability-eval-"));
const accessKey = "observability-eval-access-key";
const port = 18898;
const baseUrl = `http://127.0.0.1:${port}`;
let mockServer = null;
let mockUrl = "";
let otlpRequests = 0;
const otlpPayloads = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function startMockServer() {
  mockServer = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && String(req.url || "") === "/v1/traces") {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        otlpPayloads.push(Buffer.concat(chunks));
        otlpRequests += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.method !== "POST" || !String(req.url || "").endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const body = await readJsonBody(req);
      if (body.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "stream " } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "可观测性 mock 回答" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_cache_hit_tokens: 2,
        },
      }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", () => {
      mockServer.off("error", reject);
      resolve();
    });
  });
  mockUrl = `http://127.0.0.1:${mockServer.address().port}/v1`;
}

async function stopMockServer() {
  if (!mockServer) return;
  await new Promise((resolve, reject) => mockServer.close((error) => (error ? reject(error) : resolve())));
  mockServer = null;
}

async function request(pathname, { method = "GET", body, authenticated = true } = {}) {
  const headers = {
    ...(body ? { "content-type": "application/json" } : {}),
    ...(authenticated ? { "x-training-access-key": accessKey } : {}),
  };
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  return { ok: response.ok, status: response.status, payload };
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const result = await request("/api/health");
      if (result.ok) return result.payload;
    } catch {
      // Keep polling while the child starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("training-service did not become healthy");
}

async function waitForObservedRun() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const runsResult = await request("/api/agent-runs?limit=10&skill=answer_general_chat");
    const run = runsResult.payload.runs?.find((item) => item.summary?.observability?.version === 1);
    if (run) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Agent Run observability was not persisted in time");
}

await writeFile(path.join(tempDataDir, "state.json"), `${JSON.stringify({
  meta: { version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  knowledgeBases: [],
  documents: [],
  chunkParents: [],
  chunks: [],
  employees: [],
  tasks: [],
  invites: [],
  quizzes: [],
  attempts: [],
  contentDrafts: [],
  events: [],
}, null, 2)}\n`, "utf8");

await startMockServer();

const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    TRAINING_ACCESS_KEY: accessKey,
    TRAINING_AUTH_DISABLED: "0",
    TRAINING_DATA_DIR: tempDataDir,
    TRAINING_STORAGE: "json",
    TRAINING_LLM_PROVIDER: "openai-compatible",
    TRAINING_LLM_BASE_URL: mockUrl,
    TRAINING_LLM_API_KEY: "observability-eval-llm-key",
    TRAINING_LLM_MODEL: "observability-eval-model",
    TRAINING_LLM_INTENT_ROUTER: "0",
    TRAINING_LLM_INPUT_COST_PER_MILLION: "1",
    TRAINING_LLM_CACHED_INPUT_COST_PER_MILLION: "0.5",
    TRAINING_LLM_OUTPUT_COST_PER_MILLION: "2",
    TRAINING_LLM_COST_CURRENCY: "USD",
    TRAINING_LLM_PRICE_SOURCE_DATE: "2026-07-10",
    TRAINING_OTEL_ENABLED: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

let childStopped = false;
async function stopChild() {
  if (childStopped) return;
  childStopped = true;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
    setTimeout(resolve, 1500);
  });
}

const results = [];

try {
  const health = await waitForHealth();
  assert(health.openTelemetry?.status === "disabled", "OpenTelemetry must be default-off");
  assert(health.openTelemetryOk === null, "disabled OpenTelemetry health must not be reported as failure");
  results.push({ id: "otel-default-off", ok: true });

  const unauthorized = await request("/api/observability/summary?hours=24", { authenticated: false });
  assert(unauthorized.status === 401, "observability summary must require boss authentication");
  results.push({ id: "authenticated-summary", ok: true });

  const chat = await request("/api/chat", {
    method: "POST",
    body: {
      sessionId: "observability-eval-session",
      memoryMode: "off",
      forceGeneralChat: true,
      message: "请返回一个 mock 回答",
    },
  });
  assert(chat.ok && chat.payload.answer === "可观测性 mock 回答", "mock chat failed");

  const run = await waitForObservedRun();
  const observed = run?.summary?.observability;
  assert(observed?.version === 1, "Agent Run must persist observability version 1");
  assert(observed.llm.calls === 1 && observed.llm.totalTokens === 15, `LLM token usage mismatch: ${JSON.stringify(observed.llm)}`);
  assert(observed.llm.cachedInputTokens === 2 && observed.llm.estimatedCalls === 0, "LLM cache/estimate metadata mismatch");
  assert(observed.llm.cost.amount === 0.000019, `LLM cost mismatch: ${observed.llm.cost.amount}`);
  assert(observed.tools.calls === 1 && observed.tools.successRate === 1, "tool success metrics mismatch");
  assert(!JSON.stringify(observed).includes("请返回一个 mock 回答"), "observability must not persist prompt content");
  results.push({ id: "run-summary", ok: true, runId: run.id });

  const summaryResult = await request("/api/observability/summary?hours=24&skill=answer_general_chat");
  const summary = summaryResult.payload;
  assert(summaryResult.ok && summary.runs.observed === 1, "summary observed run count mismatch");
  assert(summary.llm.totalTokens === 15 && summary.llm.costByCurrency.USD === 0.000019, "summary LLM aggregation mismatch");
  assert(summary.tools.successRate === 1, "summary tool success rate mismatch");
  assert(summary.retrieval.evidenceHitRate === null, "missing retrieval data must remain null");
  assert(/not offline ground-truth Hit@K/.test(summary.retrieval.metricDefinition), "online retrieval metric definition missing");
  results.push({ id: "summary-aggregation", ok: true });

  const {
    getCurrentObservabilitySnapshot,
    isSuccessfulRerankerStatus,
    recordRetrievalObservation,
    withAgentRunObservability,
  } = await import("../src/observability/context.mjs");
  assert(isSuccessfulRerankerStatus("ready") && !isSuccessfulRerankerStatus("fallback"), "reranker span status classification mismatch");
  let retrievalSnapshot = null;
  await withAgentRunObservability({ runId: "retrieval-eval", transport: "test", route: "eval" }, async () => {
    recordRetrievalObservation({
      mode: "hybrid+reranker",
      candidateCount: 20,
      evidenceCount: 3,
      retrievalLatencyMs: 45,
      rerankerLatencyMs: 18,
      rerankerStatus: "ok",
    });
    retrievalSnapshot = getCurrentObservabilitySnapshot();
  });
  assert(retrievalSnapshot.retrieval.calls === 1, "retrieval observation call mismatch");
  assert(retrievalSnapshot.retrieval.evidenceHitRate === 1, "retrieval evidence hit mismatch");
  assert(retrievalSnapshot.retrieval.rerankerLatencyMs.p95 === 18, "reranker latency mismatch");
  results.push({ id: "retrieval-hook", ok: true });

  process.env.TRAINING_LLM_BASE_URL = mockUrl;
  process.env.TRAINING_LLM_API_KEY = "observability-stream-eval-key";
  process.env.TRAINING_LLM_MODEL = "observability-stream-eval-model";
  const { streamOpenAiCompatibleLLM } = await import("../src/direct-llm.mjs");
  let streamingSnapshot = null;
  let streamedAnswer = "";
  await withAgentRunObservability({ runId: "streaming-eval", transport: "test", route: "eval" }, async () => {
    for await (const event of streamOpenAiCompatibleLLM("streaming observability check")) {
      streamedAnswer += event.delta || "";
    }
    streamingSnapshot = getCurrentObservabilitySnapshot();
  });
  assert(streamedAnswer === "stream answer", `stream answer mismatch: ${streamedAnswer}`);
  assert(streamingSnapshot.llm.ttftMs.count === 1 && streamingSnapshot.llm.ttftMs.p95 >= 20, "streaming TTFT was not recorded");
  assert(streamingSnapshot.llm.estimatedCalls === 1, "streaming usage without provider tokens must be marked estimated");
  results.push({ id: "streaming-ttft-estimate", ok: true, ttftMs: streamingSnapshot.llm.ttftMs.p95 });

  process.env.TRAINING_OTEL_ENABLED = "1";
  process.env.TRAINING_OTEL_OTLP_ENDPOINT = `${mockUrl.replace(/\/v1$/, "")}/v1/traces`;
  const {
    getOpenTelemetryStatus,
    initializeOpenTelemetry,
    sanitizeTelemetryEndpointForStatus,
    shutdownOpenTelemetry,
    withTelemetrySpan,
  } = await import("../src/observability/telemetry.mjs");
  assert(sanitizeTelemetryEndpointForStatus("user:secret-password@host") === "[configured-invalid-url]", "telemetry status must reject non-HTTP endpoints without echoing credentials");
  await initializeOpenTelemetry();
  assert(getOpenTelemetryStatus().status === "ready", "OpenTelemetry OTLP exporter did not initialize");
  await withAgentRunObservability({ runId: "otel-eval", transport: "test", route: "eval" }, async () => {
    recordRetrievalObservation({ mode: "bm25", evidenceCount: 1, retrievalLatencyMs: 3 });
  });
  const sensitiveErrorText = "Bearer must-not-export D:\\private\\prompt.txt";
  try {
    await withTelemetrySpan("redaction.eval", {}, async () => {
      throw new Error(sensitiveErrorText);
    });
  } catch {
    // Expected: the application still receives the original error.
  }
  await shutdownOpenTelemetry();
  assert(otlpRequests > 0, "OpenTelemetry exporter did not send an OTLP request");
  const exportedText = Buffer.concat(otlpPayloads).toString("utf8");
  assert(!exportedText.includes("must-not-export") && !exportedText.includes("private\\prompt.txt"), "OpenTelemetry payload leaked raw exception content");
  results.push({ id: "otel-otlp-export", ok: true, requests: otlpRequests });

  console.log(JSON.stringify({ ok: true, total: results.length, results }, null, 2));
} catch (error) {
  console.error(error);
  console.log(JSON.stringify({ ok: false, results }, null, 2));
  process.exitCode = 1;
} finally {
  await stopChild();
  await stopMockServer();
  await rm(tempDataDir, { recursive: true, force: true });
}
