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
  updateBossChatSession,
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

function recentIso(minutesAgo = 0) {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

function assertSessionOrder(sessions, expectedIds, message) {
  const ids = sessions.map((session) => session.id);
  const positions = expectedIds.map((id) => ids.indexOf(id));
  assert(positions.every((position) => position >= 0), `${message}: missing ids in ${ids.join(",")}`);
  for (let index = 1; index < positions.length; index += 1) {
    assert(positions[index - 1] < positions[index], `${message}: expected ${expectedIds.join(" before ")}, got ${ids.join(",")}`);
  }
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
  const pollutedTimestamp = recentIso(0);
  const session = {
    id: "boss-chat-expired-sqlite",
    accountId: BOSS_ACCOUNT_ID,
    title: "过期会话",
    preview: "这条会话应该被 30 天保留策略清理",
    status: "active",
    createdAt: timestamp,
    updatedAt: pollutedTimestamp,
    lastMessageAt: pollutedTimestamp,
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

function corruptSqliteSessionTime(sessionId, patch = {}) {
  const db = openTrainingDatabase(dataDir);
  const row = db.prepare("SELECT json FROM boss_chat_sessions WHERE id = ?").get(sessionId);
  assert(row, `cannot corrupt missing sqlite session ${sessionId}`);
  const session = { ...JSON.parse(row.json), ...patch };
  db.prepare(`
    UPDATE boss_chat_sessions
    SET updatedAt = @updatedAt,
        lastMessageAt = @lastMessageAt,
        json = @json
    WHERE id = @id
  `).run({
    id: sessionId,
    updatedAt: session.updatedAt,
    lastMessageAt: session.lastMessageAt,
    json: JSON.stringify(session),
  });
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

  await createBossChatSession({ id: "boss-chat-sort-a", title: "Sort A", preview: "created first" });
  await createBossChatSession({ id: "boss-chat-sort-b", title: "Sort B", preview: "created second" });
  const sqliteAOlderAt = recentIso(20);
  const sqliteBNewerAt = recentIso(10);
  await appendBossChatMessages("boss-chat-sort-a", [{
    role: "user",
    content: "A older last message",
    action: "user_message",
    createdAt: sqliteAOlderAt,
  }]);
  await appendBossChatMessages("boss-chat-sort-b", [{
    role: "user",
    content: "B newer last message",
    action: "user_message",
    createdAt: sqliteBNewerAt,
  }]);
  const sortedByLastMessage = await request("/api/boss-chat/sessions?limit=20");
  assertSessionOrder(sortedByLastMessage.sessions, ["boss-chat-sort-b", "boss-chat-sort-a"], "sessions should sort by lastMessageAt");
  const sqliteAInitial = sortedByLastMessage.sessions.find((session) => session.id === "boss-chat-sort-a");
  assert(sqliteAInitial?.lastMessageAt === sqliteAOlderAt, `initial sqlite lastMessageAt should come from message, got ${sqliteAInitial?.lastMessageAt}`);

  await request("/api/boss-chat/sessions/boss-chat-sort-a");
  const afterSortGet = await request("/api/boss-chat/sessions?limit=20");
  assertSessionOrder(afterSortGet.sessions, ["boss-chat-sort-b", "boss-chat-sort-a"], "GET session should not change lastMessageAt ordering");
  const sqliteAAfterGet = afterSortGet.sessions.find((session) => session.id === "boss-chat-sort-a");
  assert(sqliteAAfterGet?.lastMessageAt === sqliteAOlderAt, `GET should not change sqlite lastMessageAt, got ${sqliteAAfterGet?.lastMessageAt}`);

  await request("/api/boss-chat/sessions/boss-chat-sort-a", {
    method: "PATCH",
    body: { title: "Sort A renamed", preview: "metadata changed only" },
  });
  const afterSortPatch = await request("/api/boss-chat/sessions?limit=20");
  assertSessionOrder(afterSortPatch.sessions, ["boss-chat-sort-b", "boss-chat-sort-a"], "PATCH title/preview should not change lastMessageAt ordering");
  const sqliteAAfterPatch = afterSortPatch.sessions.find((session) => session.id === "boss-chat-sort-a");
  assert(sqliteAAfterPatch?.lastMessageAt === sqliteAOlderAt, `PATCH should not change sqlite lastMessageAt, got ${sqliteAAfterPatch?.lastMessageAt}`);

  corruptSqliteSessionTime("boss-chat-sort-a", { updatedAt: recentIso(0), lastMessageAt: sqliteAOlderAt });
  const afterUpdatedAtCorrupt = await request("/api/boss-chat/sessions?limit=20");
  assertSessionOrder(afterUpdatedAtCorrupt.sessions, ["boss-chat-sort-b", "boss-chat-sort-a"], "corrupted updatedAt should not change lastMessageAt ordering");

  corruptSqliteSessionTime("boss-chat-sort-a", { updatedAt: recentIso(0), lastMessageAt: recentIso(0) });
  const afterLastMessageCorrupt = await request("/api/boss-chat/sessions?limit=20");
  assertSessionOrder(afterLastMessageCorrupt.sessions, ["boss-chat-sort-b", "boss-chat-sort-a"], "corrupted sqlite lastMessageAt should be repaired from messages before sorting");
  const repairedSqliteA = afterLastMessageCorrupt.sessions.find((session) => session.id === "boss-chat-sort-a");
  assert(repairedSqliteA?.lastMessageAt === sqliteAOlderAt, `sqlite repair should restore lastMessageAt from messages, got ${repairedSqliteA?.lastMessageAt}`);

  await appendBossChatMessages("boss-chat-sort-a", [{
    role: "assistant",
    content: "A latest message",
    action: "chat",
    createdAt: recentIso(1),
  }]);
  const afterSortAppend = await request("/api/boss-chat/sessions?limit=20");
  assertSessionOrder(afterSortAppend.sessions, ["boss-chat-sort-a", "boss-chat-sort-b"], "appending a newer message should move session first");
  results.push({ name: "sqlite list sorts by lastMessageAt not metadata updatedAt", ok: true });

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

  await createBossChatSession({ id: "boss-chat-json-sort-a", title: "JSON Sort A", preview: "created first" });
  await createBossChatSession({ id: "boss-chat-json-sort-b", title: "JSON Sort B", preview: "created second" });
  const jsonAOlderAt = recentIso(20);
  const jsonBNewerAt = recentIso(10);
  await appendBossChatMessages("boss-chat-json-sort-a", [{
    role: "user",
    content: "JSON A older last message",
    action: "user_message",
    createdAt: jsonAOlderAt,
  }]);
  await appendBossChatMessages("boss-chat-json-sort-b", [{
    role: "user",
    content: "JSON B newer last message",
    action: "user_message",
    createdAt: jsonBNewerAt,
  }]);
  const jsonSortedByLastMessage = await listBossChatSessions({ limit: 20 });
  assertSessionOrder(jsonSortedByLastMessage, ["boss-chat-json-sort-b", "boss-chat-json-sort-a"], "json sessions should sort by lastMessageAt");
  const jsonAInitial = jsonSortedByLastMessage.find((session) => session.id === "boss-chat-json-sort-a");
  assert(jsonAInitial?.lastMessageAt === jsonAOlderAt, `initial json lastMessageAt should come from message, got ${jsonAInitial?.lastMessageAt}`);
  await updateBossChatSession("boss-chat-json-sort-a", { title: "JSON Sort A renamed", preview: "metadata changed only" });
  const jsonAfterPatch = await listBossChatSessions({ limit: 20 });
  assertSessionOrder(jsonAfterPatch, ["boss-chat-json-sort-b", "boss-chat-json-sort-a"], "json PATCH title/preview should not change lastMessageAt ordering");
  const jsonAAfterPatch = jsonAfterPatch.find((session) => session.id === "boss-chat-json-sort-a");
  assert(jsonAAfterPatch?.lastMessageAt === jsonAOlderAt, `json PATCH should not change lastMessageAt, got ${jsonAAfterPatch?.lastMessageAt}`);
  const pollutedJsonStore = JSON.parse(await readFile(bossChatPath, "utf8"));
  pollutedJsonStore.sessions = pollutedJsonStore.sessions.map((session) => (
    session.id === "boss-chat-json-sort-a"
      ? { ...session, updatedAt: recentIso(0), lastMessageAt: recentIso(0) }
      : session
  ));
  await writeFile(bossChatPath, `${JSON.stringify(pollutedJsonStore, null, 2)}\n`, "utf8");
  const jsonAfterPollutedLastMessage = await listBossChatSessions({ limit: 20 });
  assertSessionOrder(jsonAfterPollutedLastMessage, ["boss-chat-json-sort-b", "boss-chat-json-sort-a"], "json polluted lastMessageAt should be repaired from messages before sorting");
  const repairedJsonA = jsonAfterPollutedLastMessage.find((session) => session.id === "boss-chat-json-sort-a");
  assert(repairedJsonA?.lastMessageAt === jsonAOlderAt, `json repair should restore lastMessageAt from messages, got ${repairedJsonA?.lastMessageAt}`);
  results.push({ name: "json list sorts by lastMessageAt after metadata patch", ok: true });

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
