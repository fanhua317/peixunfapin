import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-boss-chat-eval-"));

process.env.TRAINING_DATA_DIR = tempDir;
process.env.TRAINING_STORAGE = "sqlite";
process.env.TRAINING_AUTH_DISABLED = "1";
process.env.TRAINING_HEALTH_TIMEOUT_MS = process.env.TRAINING_HEALTH_TIMEOUT_MS || "200";

const {
  BOSS_ACCOUNT_ID,
  appendBossChatMessages,
  bossChatPath,
  createBossChatSession,
  getBossChatSession,
  listBossChatSessions,
} = await import("../src/boss-chat/store.mjs");
const { createApp } = await import("../src/http/app.mjs");
const { loadMemoryStore, upsertMemory } = await import("../src/memory/store.mjs");
const { dataDir, loadState, mutateState } = await import("../src/store.mjs");
const {
  closeTrainingDatabase,
  openTrainingDatabase,
  SQLITE_SCHEMA_VERSION,
} = await import("../src/sqlite-store.mjs");

const results = [];
let server = null;
let baseUrl = "";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function oldIso(daysAgo = 31) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

async function startServer() {
  server = http.createServer(createApp({ host: "127.0.0.1", port: 0 }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server = null;
  baseUrl = "";
}

async function request(pathname, options = {}) {
  const body = options.body && typeof options.body === "object"
    ? JSON.stringify(options.body)
    : options.body;
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { accept: "application/json", "content-type": "application/json", ...(options.headers || {}) },
    ...options,
    body,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${pathname} failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function requestExpectError(pathname, options = {}, expectedStatus = 404) {
  const body = options.body && typeof options.body === "object"
    ? JSON.stringify(options.body)
    : options.body;
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { accept: "application/json", "content-type": "application/json", ...(options.headers || {}) },
    ...options,
    body,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (response.status !== expectedStatus) {
    throw new Error(`expected ${expectedStatus} from ${pathname}, got ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function seedBusinessData() {
  const timestamp = new Date().toISOString();
  await mutateState((state) => {
    state.tasks.push({
      id: "task-boss-chat-eval",
      title: "Boss chat persistence protected task",
      status: "published",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    state.invites.push({
      id: "invite-boss-chat-eval",
      taskId: "task-boss-chat-eval",
      token: "boss-chat-eval-token",
      employeeName: "王小明",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    state.quizzes.push({
      id: "quiz-boss-chat-eval",
      taskId: "task-boss-chat-eval",
      questions: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
  await upsertMemory({
    id: "mem-boss-chat-eval",
    type: "preference",
    key: "eval.bossChatProtected",
    scope: "boss",
    status: "active",
    text: "Boss chat eval protected memory",
    value: { protected: true },
    source: "eval",
    confidence: 1,
  });
}

function insertExpiredSqliteSession() {
  const db = openTrainingDatabase(dataDir);
  const timestamp = oldIso();
  const session = {
    id: "boss-chat-expired-sqlite",
    accountId: BOSS_ACCOUNT_ID,
    title: "过期会话",
    preview: "这条会话应该被 30 天保留策略清理",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastMessageAt: timestamp,
    deletedAt: null,
    messageCount: 1,
  };
  const message = {
    id: "msg-boss-chat-expired-sqlite",
    sessionId: session.id,
    accountId: BOSS_ACCOUNT_ID,
    role: "user",
    content: "过期消息",
    action: "user_message",
    payload: null,
    metadata: {},
    createdAt: timestamp,
  };
  db.prepare(`
    INSERT INTO boss_chat_sessions (
      id, accountId, title, preview, status, createdAt, updatedAt,
      lastMessageAt, deletedAt, messageCount, json
    ) VALUES (
      @id, @accountId, @title, @preview, @status, @createdAt, @updatedAt,
      @lastMessageAt, @deletedAt, @messageCount, @json
    )
  `).run({ ...session, json: JSON.stringify(session) });
  db.prepare(`
    INSERT INTO boss_chat_messages (
      id, sessionId, accountId, role, action, createdAt, rowOrder, json
    ) VALUES (
      @id, @sessionId, @accountId, @role, @action, @createdAt, 0, @json
    )
  `).run({ ...message, json: JSON.stringify(message) });
}

async function assertBusinessDataSurvived() {
  const state = await loadState();
  const memory = await loadMemoryStore();
  assert(state.tasks.some((item) => item.id === "task-boss-chat-eval"), "task should survive chat session deletion");
  assert(state.invites.some((item) => item.id === "invite-boss-chat-eval"), "invite should survive chat session deletion");
  assert(state.quizzes.some((item) => item.id === "quiz-boss-chat-eval"), "quiz should survive chat session deletion");
  assert(memory.memories.some((item) => item.id === "mem-boss-chat-eval"), "memory should survive chat session deletion");
}

try {
  await seedBusinessData();
  await startServer();

  const health = await request("/api/health");
  assert(health.stateOk, `expected healthy state, got ${JSON.stringify(health)}`);
  assert(SQLITE_SCHEMA_VERSION === 5, `expected code schema version 5, got ${SQLITE_SCHEMA_VERSION}`);
  const schemaVersion = openTrainingDatabase(dataDir)
    .prepare("SELECT value FROM app_meta WHERE key = ?")
    .get("schemaVersion")?.value;
  assert(String(schemaVersion) === "5", `expected sqlite schemaVersion meta 5, got ${schemaVersion}`);
  results.push({ name: "sqlite schema version 5", ok: true });

  const sessionId = "boss-chat-eval-http";
  const created = await request("/api/boss-chat/sessions", {
    method: "POST",
    body: { id: sessionId, title: "老板端历史评测", preview: "评测创建" },
  });
  assert(created.session.id === sessionId, "created session id mismatch");
  assert(created.session.accountId === BOSS_ACCOUNT_ID, "created session should use boss-default account");
  assert(Array.isArray(created.messages) && created.messages.length === 0, "new session should have no messages");
  const list = await request("/api/boss-chat/sessions?limit=20");
  assert(list.accountId === BOSS_ACCOUNT_ID, "list should expose boss-default account");
  assert(list.sessions.some((session) => session.id === sessionId), "created session missing from list");
  results.push({ name: "create and list sessions", ok: true });

  const dispatch = await request("/api/agent/dispatch", {
    method: "POST",
    body: {
      sessionId,
      message: "以后软文默认短一点，偏公众号",
    },
  });
  assert(dispatch.action === "memory_saved", `expected deterministic memory action, got ${dispatch.action}`);
  const read = await request(`/api/boss-chat/sessions/${encodeURIComponent(sessionId)}`);
  assert(read.session.messageCount === 2, `expected appended user+assistant messages, got ${read.session.messageCount}`);
  assert(read.messages[0]?.role === "user" && read.messages[1]?.role === "assistant", "expected user then assistant messages");
  assert(read.messages[1]?.action === "memory_saved", "assistant message should capture action payload");
  results.push({ name: "append and read persisted turn", ok: true });

  const importResult = await request("/api/boss-chat/import-local", {
    method: "POST",
    body: {
      sessions: [{
        id: "legacy-local-unsafe",
        title: "旧本地记录",
        html: '<div>老板：你好</div><script>alert("x")</script><img src=x onerror=alert(1)><p>助手：安全回复</p>',
      }],
    },
  });
  assert(importResult.imported === 1, `expected one imported local session, got ${JSON.stringify(importResult)}`);
  const imported = await request("/api/boss-chat/sessions/legacy-local-unsafe");
  const transcript = imported.messages[0]?.content || "";
  assert(imported.messages[0]?.action === "local_transcript", "imported message should be local_transcript");
  assert(transcript.includes("老板：你好") && transcript.includes("助手：安全回复"), "safe transcript should preserve visible text");
  assert(!/script|alert|onerror|<img|<div|<p/i.test(transcript), `unsafe markup leaked into transcript: ${transcript}`);
  results.push({ name: "localStorage import as safe transcript", ok: true });

  insertExpiredSqliteSession();
  const afterPrune = await request("/api/boss-chat/sessions?limit=100");
  assert(!afterPrune.sessions.some((session) => session.id === "boss-chat-expired-sqlite"), "expired session should not be listed");
  const db = openTrainingDatabase(dataDir);
  assert(!db.prepare("SELECT id FROM boss_chat_sessions WHERE id = ?").get("boss-chat-expired-sqlite"), "expired sqlite session should be deleted");
  assert(!db.prepare("SELECT id FROM boss_chat_messages WHERE sessionId = ?").get("boss-chat-expired-sqlite"), "expired sqlite messages should be deleted");
  results.push({ name: "30 day sqlite retention cleanup", ok: true });

  const deleted = await request(`/api/boss-chat/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  assert(deleted.ok && deleted.session.status === "deleted", "delete should mark session deleted");
  await requestExpectError(`/api/boss-chat/sessions/${encodeURIComponent(sessionId)}`, {}, 404);
  await assertBusinessDataSurvived();
  results.push({ name: "delete session preserves tasks invites quizzes memories", ok: true });

  await stopServer();
  closeTrainingDatabase();
  process.env.TRAINING_STORAGE = "json";
  await rm(bossChatPath, { force: true });

  const jsonSession = await createBossChatSession({ id: "boss-chat-json-eval", title: "JSON 模式会话" });
  await appendBossChatMessages(jsonSession.id, [
    { role: "user", content: "JSON 模式追加消息", action: "user_message" },
    {
      role: "assistant",
      content: "JSON 模式回复",
      action: "chat",
      payload: { action: "chat", answer: "JSON 模式回复" },
    },
  ]);
  const jsonRead = await getBossChatSession(jsonSession.id);
  const jsonList = await listBossChatSessions({ limit: 10 });
  const jsonStore = JSON.parse(await readFile(bossChatPath, "utf8"));
  assert(jsonRead.messages.length === 2, "json mode should persist messages");
  assert(jsonList.some((session) => session.id === jsonSession.id), "json mode should list session");
  assert(jsonStore.meta?.version === 1, "json fallback file should keep meta.version 1");
  assert(jsonStore.sessions.some((session) => session.id === jsonSession.id), "json fallback file should contain session");
  assert(jsonStore.messages.some((message) => message.sessionId === jsonSession.id), "json fallback file should contain messages");
  results.push({ name: "json fallback store", ok: true });

  await writeFile(bossChatPath, `${JSON.stringify({
    meta: { version: 1, createdAt: oldIso(1), updatedAt: oldIso(1) },
    sessions: [{
      id: "boss-chat-json-fresh",
      accountId: BOSS_ACCOUNT_ID,
      title: "新 JSON 会话",
      preview: "保留",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      deletedAt: null,
      messageCount: 0,
    }, {
      id: "boss-chat-json-expired",
      accountId: BOSS_ACCOUNT_ID,
      title: "过期 JSON 会话",
      preview: "应被过滤",
      status: "active",
      createdAt: oldIso(),
      updatedAt: oldIso(),
      lastMessageAt: oldIso(),
      deletedAt: null,
      messageCount: 1,
    }],
    messages: [{
      id: "msg-boss-chat-json-expired",
      sessionId: "boss-chat-json-expired",
      accountId: BOSS_ACCOUNT_ID,
      role: "user",
      content: "过期 JSON 消息",
      action: "user_message",
      payload: null,
      metadata: {},
      createdAt: oldIso(),
    }],
  }, null, 2)}\n`, "utf8");
  const jsonPrunedList = await listBossChatSessions({ limit: 10 });
  assert(jsonPrunedList.some((session) => session.id === "boss-chat-json-fresh"), "fresh json session should remain visible");
  assert(!jsonPrunedList.some((session) => session.id === "boss-chat-json-expired"), "expired json session should be hidden by retention");
  results.push({ name: "30 day json retention filter", ok: true });

  console.log(JSON.stringify({
    ok: true,
    dataDir,
    total: results.length,
    results,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    results,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await stopServer();
  closeTrainingDatabase();
  await rm(tempDir, { recursive: true, force: true });
}
