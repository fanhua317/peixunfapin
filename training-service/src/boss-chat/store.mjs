import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir, makeId } from "../store.mjs";
import { isSqliteStorage, openTrainingDatabase } from "../sqlite-store.mjs";

export const BOSS_ACCOUNT_ID = "boss-default";
export const BOSS_CHAT_RETENTION_DAYS = 30;
export const bossChatPath = path.join(dataDir, "boss-chat-sessions.json");

const MAX_CONTENT_CHARS = 12000;
const MAX_PAYLOAD_CHARS = 80000;
const MAX_IMPORT_TRANSCRIPT_CHARS = 12000;

const nowIso = () => new Date().toISOString();

function cutoffIso() {
  return new Date(Date.now() - BOSS_CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function compactText(value, limit = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function limitText(value, limit = MAX_CONTENT_CHARS) {
  const text = String(value || "").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function safeJsonValue(value, maxChars = MAX_PAYLOAD_CHARS) {
  if (value === undefined) return null;
  try {
    const raw = JSON.stringify(value);
    if (!raw) return null;
    if (raw.length <= maxChars) return JSON.parse(raw);
    return {
      action: value?.action || "truncated",
      truncated: true,
      preview: compactText(raw, 800),
    };
  } catch {
    return {
      action: "unserializable",
      preview: compactText(String(value), 800),
    };
  }
}

function normalizeSessionId(value) {
  const text = String(value || "").trim();
  return text.replace(/[^\w:.-]/g, "-").slice(0, 96);
}

export function makeBossChatSessionId(value) {
  return normalizeSessionId(value) || makeId("boss-chat");
}

function defaultStore() {
  return {
    meta: {
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    sessions: [],
    messages: [],
  };
}

function normalizeSession(session = {}) {
  const timestamp = session.createdAt || nowIso();
  return {
    id: makeBossChatSessionId(session.id),
    accountId: String(session.accountId || BOSS_ACCOUNT_ID),
    title: compactText(session.title || "新聊天", 48),
    preview: compactText(session.preview || "还没有消息", 120),
    status: session.status === "deleted" || session.status === "archived" ? session.status : "active",
    createdAt: timestamp,
    updatedAt: session.updatedAt || session.lastMessageAt || timestamp,
    lastMessageAt: session.lastMessageAt || session.updatedAt || timestamp,
    deletedAt: session.deletedAt || null,
    messageCount: Number(session.messageCount) || 0,
  };
}

function normalizeMessage(message = {}) {
  const role = message.role === "assistant" ? "assistant" : "user";
  const payload = safeJsonValue(message.payload);
  const action = String(message.action || payload?.action || (role === "user" ? "user_message" : "assistant_result"));
  return {
    id: String(message.id || makeId("msg")),
    sessionId: makeBossChatSessionId(message.sessionId),
    accountId: String(message.accountId || BOSS_ACCOUNT_ID),
    role,
    content: limitText(message.content),
    action,
    payload,
    metadata: safeJsonValue(message.metadata || {}, 12000) || {},
    createdAt: message.createdAt || nowIso(),
  };
}

function normalizeStore(store = {}) {
  const value = store && typeof store === "object" ? store : defaultStore();
  value.meta = value.meta && typeof value.meta === "object" ? value.meta : {};
  value.meta.version = 1;
  value.meta.createdAt = value.meta.createdAt || nowIso();
  value.meta.updatedAt = value.meta.updatedAt || value.meta.createdAt;
  value.sessions = Array.isArray(value.sessions) ? value.sessions.map(normalizeSession) : [];
  value.messages = Array.isArray(value.messages) ? value.messages.map(normalizeMessage) : [];
  return value;
}

async function ensureDir() {
  await mkdir(dataDir, { recursive: true });
}

function isExpiredSession(session) {
  const value = session.lastMessageAt || session.updatedAt || session.createdAt || "";
  const time = Date.parse(value);
  return Number.isFinite(time) && time < Date.parse(cutoffIso());
}

function pruneStore(store) {
  const sessions = store.sessions.filter((session) => !isExpiredSession(session));
  const activeIds = new Set(sessions.map((session) => session.id));
  return {
    ...store,
    sessions,
    messages: store.messages.filter((message) => activeIds.has(message.sessionId)),
  };
}

async function loadJsonStore() {
  await ensureDir();
  try {
    return pruneStore(normalizeStore(JSON.parse(await readFile(bossChatPath, "utf8"))));
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    const store = defaultStore();
    await saveJsonStore(store);
    return store;
  }
}

async function saveJsonStore(store) {
  await ensureDir();
  const value = pruneStore(normalizeStore(store));
  value.meta.updatedAt = nowIso();
  await writeFile(bossChatPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return value;
}

function db() {
  return openTrainingDatabase(dataDir);
}

function pruneSqlite() {
  const database = db();
  const cutoff = cutoffIso();
  const expired = database.prepare(`
    SELECT id FROM boss_chat_sessions
    WHERE COALESCE(lastMessageAt, updatedAt, createdAt) < ?
  `).all(cutoff).map((row) => row.id);
  if (!expired.length) return;
  const deleteMessages = database.prepare("DELETE FROM boss_chat_messages WHERE sessionId = ?");
  const deleteSession = database.prepare("DELETE FROM boss_chat_sessions WHERE id = ?");
  database.transaction(() => {
    for (const id of expired) {
      deleteMessages.run(id);
      deleteSession.run(id);
    }
  })();
}

function writeSqliteSession(session) {
  const database = db();
  const value = normalizeSession(session);
  database.prepare(`
    INSERT INTO boss_chat_sessions (
      id, accountId, title, preview, status, createdAt, updatedAt,
      lastMessageAt, deletedAt, messageCount, json
    ) VALUES (
      @id, @accountId, @title, @preview, @status, @createdAt, @updatedAt,
      @lastMessageAt, @deletedAt, @messageCount, @json
    )
    ON CONFLICT(id) DO UPDATE SET
      accountId = excluded.accountId,
      title = excluded.title,
      preview = excluded.preview,
      status = excluded.status,
      updatedAt = excluded.updatedAt,
      lastMessageAt = excluded.lastMessageAt,
      deletedAt = excluded.deletedAt,
      messageCount = excluded.messageCount,
      json = excluded.json
  `).run({ ...value, json: JSON.stringify(value) });
  return value;
}

function readSqliteSession(sessionId) {
  const row = db().prepare("SELECT json FROM boss_chat_sessions WHERE id = ?").get(makeBossChatSessionId(sessionId));
  return row ? normalizeSession(JSON.parse(row.json)) : null;
}

function writeSqliteMessage(message) {
  const database = db();
  const value = normalizeMessage(message);
  const rowOrder = database.prepare("SELECT COUNT(*) AS count FROM boss_chat_messages WHERE sessionId = ?").get(value.sessionId)?.count || 0;
  database.prepare(`
    INSERT INTO boss_chat_messages (
      id, sessionId, accountId, role, action, createdAt, rowOrder, json
    ) VALUES (
      @id, @sessionId, @accountId, @role, @action, @createdAt, @rowOrder, @json
    )
  `).run({ ...value, rowOrder, json: JSON.stringify(value) });
  return value;
}

function readSqliteMessages(sessionId) {
  return db().prepare(`
    SELECT json FROM boss_chat_messages
    WHERE sessionId = ?
    ORDER BY rowOrder ASC, createdAt ASC, id ASC
  `).all(makeBossChatSessionId(sessionId)).map((row) => normalizeMessage(JSON.parse(row.json)));
}

function assistantContentFromPayload(payload = {}) {
  const action = payload?.action || "";
  if (action === "draft") return `已生成培训草稿：${payload.draft?.title || "培训任务"}`;
  if (action === "marketing_article") {
    return payload.article?.insufficient
      ? `软文生成失败：${payload.article?.summary || "资料不足"}`
      : `已生成营销软文：${payload.article?.title || "营销软文"}`;
  }
  if (action === "knowledge_answer") return compactText(payload.answer || payload.error || "已完成知识库答疑", 600);
  if (action === "status") return `已返回培训进度，共 ${payload.tasks?.length || 0} 个任务。`;
  if (action === "delete_records") return `已删除培训任务 ${payload.deleted?.tasks || 0} 个。`;
  if (action === "publish") return `培训已发布：${payload.task?.title || "培训任务"}，邀请 ${payload.invites?.length || 0} 个。`;
  if (action === "memory_saved") return `已保存 ${payload.memory?.saved?.length || 0} 条记忆。`;
  if (action === "memory_list") return `已列出 ${payload.memories?.length || 0} 条记忆。`;
  if (action === "memory_confirm") return "等待确认记忆操作。";
  if (action === "intent_confirm") return "等待确认执行操作。";
  if (action === "chat") return compactText(payload.answer || payload.error || "已处理普通聊天。", 600);
  if (action === "local_transcript") return compactText(payload.transcript || "旧聊天记录", 600);
  return compactText(payload.answer || payload.message || action || "已处理。", 600);
}

function sessionMetaFromMessages(session, messages = []) {
  const userMessages = messages.filter((message) => message.role === "user");
  const lastMessage = messages.at(-1);
  const title = session.title && session.title !== "新聊天"
    ? session.title
    : compactText(userMessages[0]?.content || session.title || "新聊天", 48);
  const preview = compactText(lastMessage?.content || session.preview || "还没有消息", 120);
  const lastMessageAt = lastMessage?.createdAt || session.lastMessageAt || session.updatedAt || nowIso();
  return {
    ...session,
    title,
    preview,
    lastMessageAt,
    updatedAt: lastMessageAt,
    messageCount: messages.length,
  };
}

export async function createBossChatSession({ id, title, preview, accountId = BOSS_ACCOUNT_ID } = {}) {
  const session = normalizeSession({
    id: id || makeId("boss-chat"),
    accountId,
    title: title || "新聊天",
    preview: preview || "还没有消息",
    status: "active",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  if (isSqliteStorage()) {
    pruneSqlite();
    return writeSqliteSession(session);
  }
  const store = await loadJsonStore();
  store.sessions = store.sessions.filter((item) => item.id !== session.id);
  store.sessions.unshift(session);
  await saveJsonStore(store);
  return session;
}

export async function listBossChatSessions({ accountId = BOSS_ACCOUNT_ID, limit = 80 } = {}) {
  const max = Math.max(1, Math.min(500, Number(limit) || 80));
  if (isSqliteStorage()) {
    pruneSqlite();
    return db().prepare(`
      SELECT json FROM boss_chat_sessions
      WHERE accountId = ? AND status != 'deleted'
      ORDER BY updatedAt DESC, id DESC
      LIMIT ?
    `).all(accountId, max).map((row) => normalizeSession(JSON.parse(row.json)));
  }
  const store = await loadJsonStore();
  return store.sessions
    .filter((session) => session.accountId === accountId && session.status !== "deleted")
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, max);
}

export async function getBossChatSession(sessionId, { accountId = BOSS_ACCOUNT_ID } = {}) {
  const id = makeBossChatSessionId(sessionId);
  if (isSqliteStorage()) {
    pruneSqlite();
    const session = readSqliteSession(id);
    if (!session || session.accountId !== accountId || session.status === "deleted") return null;
    return { session, messages: readSqliteMessages(id) };
  }
  const store = await loadJsonStore();
  const session = store.sessions.find((item) => item.id === id && item.accountId === accountId && item.status !== "deleted");
  if (!session) return null;
  return {
    session,
    messages: store.messages.filter((message) => message.sessionId === id).sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)),
  };
}

export async function updateBossChatSession(sessionId, patch = {}, { accountId = BOSS_ACCOUNT_ID } = {}) {
  const existing = await getBossChatSession(sessionId, { accountId });
  if (!existing) return null;
  const updated = normalizeSession({
    ...existing.session,
    title: patch.title ?? existing.session.title,
    preview: patch.preview ?? existing.session.preview,
    status: patch.status ?? existing.session.status,
    updatedAt: nowIso(),
    deletedAt: patch.status === "deleted" ? nowIso() : existing.session.deletedAt,
  });
  if (isSqliteStorage()) {
    return writeSqliteSession(updated);
  }
  const store = await loadJsonStore();
  store.sessions = store.sessions.map((session) => (session.id === updated.id ? updated : session));
  await saveJsonStore(store);
  return updated;
}

export async function deleteBossChatSession(sessionId, { accountId = BOSS_ACCOUNT_ID } = {}) {
  return await updateBossChatSession(sessionId, { status: "deleted" }, { accountId });
}

async function ensureSession(sessionId, options = {}) {
  const id = makeBossChatSessionId(sessionId);
  const existing = await getBossChatSession(id, { accountId: options.accountId || BOSS_ACCOUNT_ID });
  if (existing) return existing.session;
  return await createBossChatSession({ id, accountId: options.accountId || BOSS_ACCOUNT_ID, title: options.title });
}

export async function appendBossChatMessages(sessionId, messages = [], options = {}) {
  const accountId = options.accountId || BOSS_ACCOUNT_ID;
  const session = await ensureSession(sessionId, { accountId, title: options.title });
  const normalized = messages
    .map((message) => normalizeMessage({ ...message, sessionId: session.id, accountId }))
    .filter((message) => message.content || message.payload);
  if (!normalized.length) return { session, messages: [] };

  if (isSqliteStorage()) {
    const database = db();
    database.transaction(() => {
      normalized.forEach((message) => writeSqliteMessage(message));
      const allMessages = readSqliteMessages(session.id);
      writeSqliteSession(sessionMetaFromMessages(session, allMessages));
    })();
    return await getBossChatSession(session.id, { accountId });
  }

  const store = await loadJsonStore();
  const sessionIndex = store.sessions.findIndex((item) => item.id === session.id);
  const baseSession = sessionIndex >= 0 ? store.sessions[sessionIndex] : session;
  store.messages.push(...normalized);
  const allMessages = store.messages.filter((message) => message.sessionId === session.id);
  const updatedSession = sessionMetaFromMessages(baseSession, allMessages);
  if (sessionIndex >= 0) store.sessions[sessionIndex] = updatedSession;
  else store.sessions.unshift(updatedSession);
  await saveJsonStore(store);
  return { session: updatedSession, messages: allMessages };
}

export async function appendBossChatTurn({ sessionId, message, payload, runId, accountId = BOSS_ACCOUNT_ID } = {}) {
  const entries = [];
  if (message) {
    entries.push({
      role: "user",
      content: message,
      action: "user_message",
      metadata: runId ? { runId } : {},
    });
  }
  if (payload) {
    entries.push({
      role: "assistant",
      content: assistantContentFromPayload(payload),
      action: payload.action || "assistant_result",
      payload,
      metadata: runId ? { runId } : {},
    });
  }
  if (!entries.length) return null;
  return await appendBossChatMessages(sessionId, entries, { accountId });
}

function htmlToSafeText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|article|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function importLocalBossChatSessions(sessions = [], { accountId = BOSS_ACCOUNT_ID } = {}) {
  const imported = [];
  for (const raw of Array.isArray(sessions) ? sessions.slice(0, 80) : []) {
    const transcript = limitText(htmlToSafeText(raw.html || raw.transcript || raw.preview || ""), MAX_IMPORT_TRANSCRIPT_CHARS);
    if (!transcript) continue;
    const session = await createBossChatSession({
      id: makeBossChatSessionId(raw.id || makeId("boss-chat")),
      accountId,
      title: raw.title || "导入的旧聊天",
      preview: raw.preview || transcript,
    });
    await appendBossChatMessages(session.id, [{
      role: "assistant",
      action: "local_transcript",
      content: transcript,
      payload: {
        action: "local_transcript",
        transcript,
        importedFrom: "localStorage",
      },
      createdAt: raw.updatedAt || raw.createdAt || nowIso(),
    }], { accountId });
    imported.push(session.id);
  }
  return { imported: imported.length, sessionIds: imported };
}
