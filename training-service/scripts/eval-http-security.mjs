import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-http-security-"));
const port = 18896;
const baseUrl = `http://127.0.0.1:${port}`;
const accessKey = "http-security-eval-key";
let mockServer;
let child;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function startMockLlm() {
  mockServer = http.createServer(async (req, res) => {
    const body = await readJson(req);
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "你好，我可以协助处理培训任务。" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: JSON.stringify({
            answer: "电机培训应先核对额定功率、绝缘等级和防护等级，再结合实际负载、环境温度与维护周期执行点检；若现场条件与资料不一致，应停止推断并联系技术负责人确认。",
            keyPoints: ["核对铭牌参数", "结合工况点检"],
            caveats: [],
            sourceRefs: ["guide.md#intro"],
            webSourceRefs: [],
          }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${mockServer.address().port}/v1`;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // Static HTML/text responses stay as text.
  }
  return { status: response.status, payload, headers: response.headers };
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await request("/api/auth/status");
      if (response.status === 200) return;
    } catch {
      // Keep polling while the child starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("training service failed to start");
}

function maskedTextFrame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([header, mask, masked]);
}

function oversizedFrameHeader() {
  const header = Buffer.alloc(14);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(1024 * 1024 + 1), 2);
  randomBytes(4).copy(header, 10);
  return header;
}

function parseCloseCode(buffer) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    let header = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) return null;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) return null;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      header = 10;
    }
    if (offset + header + length > buffer.length) return null;
    if (opcode === 0x8) return length >= 2 ? buffer.readUInt16BE(offset + header) : 1005;
    offset += header + length;
  }
  return null;
}

async function websocketRoundTrip(frame, origin = baseUrl) {
  return await new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/agent/stream",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
        "x-training-access-key": accessKey,
        origin,
      },
    });
    const timeout = setTimeout(() => reject(new Error("websocket round trip timed out")), 12_000);
    request.on("upgrade", (_response, socket, head) => {
      let received = Buffer.from(head || Buffer.alloc(0));
      socket.on("data", (chunk) => { received = Buffer.concat([received, chunk]); });
      socket.on("end", () => {
        clearTimeout(timeout);
        resolve({ status: 101, closeCode: parseCloseCode(received), received });
      });
      socket.on("error", reject);
      socket.write(frame);
    });
    request.on("response", (response) => {
      clearTimeout(timeout);
      response.resume();
      resolve({ status: response.statusCode, closeCode: null, received: Buffer.alloc(0) });
    });
    request.on("error", reject);
    request.end();
  });
}

const now = Date.now();
const state = {
  meta: { version: 1, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
  knowledgeBases: [{ id: "kb-http", name: "HTTP 安全评测", status: "ready", createdAt: new Date(now).toISOString() }],
  documents: [{ id: "doc-http", knowledgeBaseId: "kb-http", title: "guide.md", sourcePath: "guide.md", status: "ready" }],
  chunkParents: [],
  chunks: [{ id: "chunk-http", knowledgeBaseId: "kb-http", documentId: "doc-http", content: "电机点检需要核对额定功率、绝缘等级、防护等级、负载和环境温度。", searchText: "电机点检 额定功率 绝缘等级 防护等级", sourceRef: "guide.md#intro", sourcePath: "guide.md", status: "ready" }],
  employees: [],
  tasks: [{ id: "task-http", title: "电机培训", knowledgeBaseId: "kb-http", knowledgeBaseName: "HTTP 安全评测", deadline: new Date(now + 86_400_000).toISOString(), quizCount: 1, passScore: 80, status: "published", createdAt: new Date(now).toISOString() }],
  invites: [
    { id: "invite-valid", taskId: "task-http", employeeName: "员工甲", token: "valid-invite-token", status: "created", expiresAt: new Date(now + 86_400_000).toISOString() },
    { id: "invite-expired", taskId: "task-http", employeeName: "员工乙", token: "expired-invite-token", status: "created", expiresAt: new Date(now - 86_400_000).toISOString() },
  ],
  quizzes: [{ id: "quiz-http", taskId: "task-http", questions: [{ id: "question-http", prompt: "点检先做什么？", options: ["核对参数", "忽略工况"], correctAnswer: "核对参数", explanation: "应先核对参数。", sourceRef: "guide.md#intro" }] }],
  attempts: [],
  contentDrafts: [],
  events: [],
};

try {
  await writeFile(path.join(tempDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const mockUrl = await startMockLlm();
  child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      TRAINING_DATA_DIR: tempDir,
      TRAINING_STORAGE: "json",
      TRAINING_ACCESS_KEY: accessKey,
      TRAINING_AUTH_DISABLED: "0",
      TRAINING_LLM_PROVIDER: "openai-compatible",
      TRAINING_LLM_BASE_URL: mockUrl,
      TRAINING_LLM_API_KEY: "http-eval-llm-key",
      TRAINING_LLM_MODEL: "http-eval-model",
      TRAINING_LLM_INTENT_ROUTER: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitForHealth();

  assert((await request("/api/tasks")).status === 401, "boss route should require access key");
  const invite = await request("/api/invites/valid-invite-token");
  assert(invite.status === 200 && invite.payload.invite.token === "valid-invite-token", "valid invite should open without boss key");
  const answer = await request("/api/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "valid-invite-token", question: "电机点检要注意什么？" }) });
  assert(answer.status === 200 && answer.payload.answer, "invite answer flow failed");
  const quiz = await request("/api/quiz/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "valid-invite-token" }) });
  assert(quiz.status === 200 && quiz.payload.quiz.id === "quiz-http", "invite quiz generation failed");
  const submit = await request("/api/quiz/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "valid-invite-token", answers: { "question-http": "核对参数" } }) });
  assert(submit.status === 200 && submit.payload.attempt.score === 100, "invite quiz submission failed");
  assert((await request("/api/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "invalid-token", question: "test" }) })).status === 401, "invalid invite token accepted");
  assert((await request("/api/quiz/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "expired-invite-token" }) })).status === 401, "expired invite token accepted");
  assert((await request("/api/quiz/generate", { method: "POST", headers: { "content-type": "application/json", "x-training-access-key": accessKey }, body: JSON.stringify({ taskId: "task-http" }) })).status === 200, "authenticated taskId quiz call lost compatibility");

  assert((await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status === 400, "malformed JSON should return 400");
  assert((await request("/api/auth/status", { headers: { cookie: "training_access=%" } })).status === 200, "malformed cookie should not crash");
  assert((await request("/api/memory/%", { headers: { "x-training-access-key": accessKey } })).status === 400, "malformed URI should return 400");
  assert((await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "x".repeat(1024 * 1024 + 64) }) })).status === 413, "oversized JSON should return 413");
  assert((await request("/missing.js")).status === 404, "missing static asset should return 404");
  const spa = await request("/imports");
  assert(spa.status === 200 && String(spa.payload).includes("<!doctype html>"), "extensionless SPA route should fall back to index");

  const wsNormal = await websocketRoundTrip(maskedTextFrame(JSON.stringify({ message: "你好", sessionId: "http-security", memoryMode: "off" })));
  assert(wsNormal.status === 101 && wsNormal.closeCode === 1000, `normal websocket failed: ${wsNormal.closeCode}`);
  const wsOversized = await websocketRoundTrip(oversizedFrameHeader());
  assert(wsOversized.closeCode === 1009, `oversized websocket should close 1009: ${wsOversized.closeCode}`);
  const wsUnmasked = await websocketRoundTrip(Buffer.from([0x81, 0x02, 0x7b, 0x7d]));
  assert(wsUnmasked.closeCode === 1002, `unmasked websocket should close 1002: ${wsUnmasked.closeCode}`);
  const badOrigin = await websocketRoundTrip(maskedTextFrame("{}"), "https://evil.example");
  assert(badOrigin.status === 403, `cross-origin websocket should return 403: ${badOrigin.status}`);

  await writeFile(path.join(tempDir, "state.json"), "{broken", "utf8");
  const internal = await request("/api/tasks", { headers: { "x-training-access-key": accessKey } });
  assert(internal.status === 500 && internal.payload.error === "internal server error", "500 response exposed internal details");
  assert(!JSON.stringify(internal.payload).includes(tempDir), "500 response exposed internal path");

  console.log(JSON.stringify({ ok: true, inviteFlow: true, httpLimits: true, staticRouting: true, websocket: { normal: 1000, oversized: 1009, unmasked: 1002, crossOrigin: 403 }, serverErrors: stderr ? "captured" : "none" }, null, 2));
} finally {
  if (child) {
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill();
      setTimeout(resolve, 1500);
    });
  }
  if (mockServer) await new Promise((resolve) => mockServer.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}
