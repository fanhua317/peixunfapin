import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-streaming-eval-"));
const port = 18897;
const baseUrl = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/api/agent/stream`;
let mockServer = null;
let mockUrl = "";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamAnswer(res, scenario) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  if (scenario === "length") {
    writeSse(res, { choices: [{ delta: { content: "answer hit token limit" } }] });
    writeSse(res, { choices: [{ delta: {}, finish_reason: "length" }] });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  if (scenario === "early-close") {
    writeSse(res, { choices: [{ delta: { content: "partial before upstream close" } }] });
    res.end();
    return;
  }
  writeSse(res, { choices: [{ delta: { content: "hello " } }] });
  writeSse(res, { choices: [{ delta: { content: "world" } }] });
  writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

async function startMockServer() {
  mockServer = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || !String(req.url || "").endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const body = await readJsonBody(req);
      const prompt = (body.messages || []).map((message) => message.content || "").join("\n");
      const scenario = /length stream/i.test(prompt)
        ? "length"
        : /early close stream/i.test(prompt)
          ? "early-close"
          : "normal";
      if (body.stream) {
        streamAnswer(res, scenario);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-streaming-eval",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "non-stream fallback" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
  const address = mockServer.address();
  mockUrl = `http://127.0.0.1:${address.port}/v1`;
}

async function stopMockServer() {
  if (!mockServer) return;
  await new Promise((resolve, reject) => {
    mockServer.close((error) => (error ? reject(error) : resolve()));
  });
  mockServer = null;
}

async function request(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { "content-type": "application/json" },
  });
  const payload = await response.json();
  return { ok: response.ok, status: response.status, payload };
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const result = await request("/api/health");
      if (result.ok) return;
    } catch {
      // Keep polling while the service starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("training-service did not become healthy");
}

async function streamRequest(message) {
  const events = [];
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`stream request timed out: ${message}`)), 10_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        sessionId: `stream-eval-${message.replace(/\W+/g, "-")}`,
        memoryMode: "off",
        message,
      }));
    });
    ws.addEventListener("message", (event) => {
      events.push(JSON.parse(String(event.data)));
    });
    ws.addEventListener("error", () => reject(new Error(`websocket error: ${message}`)));
    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  return events;
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
    TRAINING_AUTH_DISABLED: "1",
    TRAINING_DATA_DIR: tempDataDir,
    TRAINING_STORAGE: "json",
    TRAINING_LLM_PROVIDER: "openai-compatible",
    TRAINING_LLM_BASE_URL: mockUrl,
    TRAINING_LLM_API_KEY: "streaming-eval-key",
    TRAINING_LLM_MODEL: "streaming-eval-mock",
    TRAINING_LLM_INTENT_ROUTER: "0",
    TRAINING_LLM_TIMEOUT_MS: "5000",
    TRAINING_GENERAL_CHAT_TIMEOUT_MS: "5000",
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
  await waitForHealth();

  const normal = await streamRequest("normal stream");
  const normalDone = normal.find((event) => event.type === "done");
  assert(normal.some((event) => event.type === "delta"), "normal stream should emit delta events");
  assert(normalDone?.payload?.answer === "hello world", `normal stream answer mismatch: ${JSON.stringify(normal)}`);
  assert(normalDone.payload.finishReason === "stop", "normal stream should preserve finishReason=stop");
  assert(normalDone.payload.truncated !== true, "normal stream should not be truncated");
  results.push({ id: "normal-done", ok: true, events: normal.map((event) => event.type) });

  const length = await streamRequest("length stream");
  const lengthDone = length.find((event) => event.type === "done");
  assert(lengthDone?.payload?.answer === "answer hit token limit", `length stream answer mismatch: ${JSON.stringify(length)}`);
  assert(lengthDone.payload.finishReason === "length", "length stream should preserve finishReason=length");
  assert(lengthDone.payload.truncated === true, "length stream should set truncated=true");
  results.push({ id: "finish-reason-length", ok: true, events: length.map((event) => event.type) });

  const early = await streamRequest("early close stream");
  assert(early.some((event) => event.type === "delta"), "early close stream should emit partial delta first");
  const earlyError = early.find((event) => event.type === "error");
  assert(earlyError?.error === "LLM API stream ended before completion marker", `early close should emit explicit stream error: ${JSON.stringify(early)}`);
  assert(!early.some((event) => event.type === "done"), "early close stream must not emit done");
  results.push({ id: "upstream-early-close", ok: true, events: early.map((event) => event.type) });

  console.log(JSON.stringify({ ok: true, tempDataDir, mockUrl, total: results.length, results }, null, 2));
} catch (error) {
  console.error(error);
  console.log(JSON.stringify({ ok: false, results }, null, 2));
  process.exitCode = 1;
} finally {
  await stopChild();
  await stopMockServer();
  await rm(tempDataDir, { recursive: true, force: true });
}
