import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir, makeId } from "../store.mjs";
import { isSqliteStorage, loadSqliteMemoryStore, saveSqliteMemoryStore } from "../sqlite-store.mjs";

const nowIso = () => new Date().toISOString();

export const memoryPath = path.join(dataDir, "memory.json");
export const conversationHistoryPath = path.join(dataDir, "conversation-history.jsonl");

export function defaultMemoryStore() {
  return {
    meta: {
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    memories: [],
    sessions: {},
  };
}

function compactText(value, limit = 600) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function normalizeSessionId(value) {
  const text = String(value || "").trim();
  if (!text) return "boss-default";
  return text.replace(/[^\w:.-]/g, "-").slice(0, 96) || "boss-default";
}

export function normalizeMemoryMode(value) {
  return ["off", "0", "false", "no"].includes(String(value || "").trim().toLowerCase()) ? "off" : "auto";
}

export function memoryEnabled(memoryMode) {
  return normalizeMemoryMode(memoryMode) !== "off";
}

function normalizeMemory(memory) {
  const value = memory && typeof memory === "object" ? memory : {};
  value.id = String(value.id || makeId("mem"));
  value.type = String(value.type || "preference");
  value.key = String(value.key || "general.preference");
  value.scope = String(value.scope || "boss");
  value.status = ["active", "pending", "archived"].includes(value.status) ? value.status : "pending";
  value.text = compactText(value.text || value.value?.label || "");
  value.value = value.value && typeof value.value === "object" ? value.value : { raw: String(value.value || "") };
  value.tags = Array.isArray(value.tags) ? value.tags.map(String).filter(Boolean).slice(0, 12) : [];
  value.source = String(value.source || "rule");
  value.confidence = Math.max(0, Math.min(1, Number(value.confidence) || 0.8));
  value.createdAt = value.createdAt || nowIso();
  value.updatedAt = value.updatedAt || value.createdAt;
  value.lastUsedAt = value.lastUsedAt || null;
  value.uses = Number(value.uses) || 0;
  value.evidence = Array.isArray(value.evidence)
    ? value.evidence.map((item) => ({
        text: compactText(item?.text || item, 240),
        createdAt: item?.createdAt || value.createdAt,
      })).filter((item) => item.text).slice(-10)
    : [];
  return value;
}

export function normalizeStore(store) {
  const value = store && typeof store === "object" ? store : defaultMemoryStore();
  value.meta = value.meta && typeof value.meta === "object" ? value.meta : {};
  value.meta.version = 1;
  value.meta.createdAt = value.meta.createdAt || nowIso();
  value.meta.updatedAt = value.meta.updatedAt || value.meta.createdAt;
  value.memories = Array.isArray(value.memories) ? value.memories.map(normalizeMemory) : [];
  value.sessions = value.sessions && typeof value.sessions === "object" ? value.sessions : {};
  return value;
}

export async function ensureMemoryDir() {
  await mkdir(dataDir, { recursive: true });
}

export async function loadMemoryStore() {
  await ensureMemoryDir();
  if (isSqliteStorage()) {
    return normalizeStore(loadSqliteMemoryStore(dataDir, { memoryPath, defaultMemoryStore }));
  }
  try {
    const raw = await readFile(memoryPath, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    const store = defaultMemoryStore();
    await saveMemoryStore(store);
    return store;
  }
}

export async function saveMemoryStore(store) {
  await ensureMemoryDir();
  const value = normalizeStore(store);
  value.meta.updatedAt = nowIso();
  if (isSqliteStorage()) {
    return saveSqliteMemoryStore(dataDir, value);
  }
  await writeFile(memoryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return value;
}

export async function mutateMemoryStore(mutator) {
  const store = await loadMemoryStore();
  const result = await mutator(store);
  await saveMemoryStore(store);
  return result;
}

function sameMemory(left, right) {
  return left.scope === right.scope && left.type === right.type && left.key === right.key && left.status !== "archived";
}

export async function upsertMemory(candidate) {
  const normalized = normalizeMemory({
    ...candidate,
    id: candidate.id || makeId("mem"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  return await mutateMemoryStore((store) => {
    const existing = store.memories.find((item) => sameMemory(item, normalized));
    if (!existing) {
      store.memories.push(normalized);
      return normalized;
    }
    existing.value = normalized.value;
    existing.text = normalized.text;
    existing.tags = [...new Set([...(existing.tags || []), ...(normalized.tags || [])])].slice(0, 12);
    existing.status = normalized.status === "active" ? "active" : existing.status;
    existing.confidence = Math.max(Number(existing.confidence) || 0, Number(normalized.confidence) || 0);
    existing.updatedAt = nowIso();
    existing.evidence = [
      ...(existing.evidence || []),
      ...(normalized.evidence || []),
    ].slice(-10);
    return existing;
  });
}

export async function upsertMemories(candidates = []) {
  const saved = [];
  for (const candidate of candidates) {
    saved.push(await upsertMemory(candidate));
  }
  return saved;
}

export async function updateMemory(id, patch = {}) {
  return await mutateMemoryStore((store) => {
    const memory = store.memories.find((item) => item.id === id);
    if (!memory) return null;
    if (patch.status && ["active", "pending", "archived"].includes(patch.status)) memory.status = patch.status;
    if (patch.text) memory.text = compactText(patch.text);
    if (patch.value && typeof patch.value === "object") memory.value = { ...memory.value, ...patch.value };
    memory.updatedAt = nowIso();
    return memory;
  });
}

export async function deleteMemory(id) {
  return await mutateMemoryStore((store) => {
    const before = store.memories.length;
    store.memories = store.memories.filter((item) => item.id !== id);
    return before - store.memories.length;
  });
}

export async function clearMemories() {
  return await mutateMemoryStore((store) => {
    const deleted = store.memories.length;
    store.memories = [];
    store.sessions = {};
    return { deleted };
  });
}

export async function markMemoriesUsed(ids = []) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return;
  await mutateMemoryStore((store) => {
    for (const memory of store.memories) {
      if (!uniqueIds.includes(memory.id)) continue;
      memory.lastUsedAt = nowIso();
      memory.uses = (Number(memory.uses) || 0) + 1;
    }
  });
}

export async function appendConversationEntries(entries = []) {
  const normalized = entries.map((entry) => ({
    id: entry.id || makeId("turn"),
    sessionId: normalizeSessionId(entry.sessionId),
    role: entry.role === "assistant" ? "assistant" : "user",
    content: compactText(entry.content, 1800),
    action: entry.action || "",
    createdAt: entry.createdAt || nowIso(),
  })).filter((entry) => entry.content);
  if (!normalized.length) return [];
  await ensureMemoryDir();
  await appendFile(conversationHistoryPath, normalized.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return normalized;
}

export async function readConversationHistory(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const limit = Number(options.limit) || 12;
  try {
    const raw = await readFile(conversationHistoryPath, "utf8");
    return raw.split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && entry.sessionId === normalizedSessionId)
      .slice(-limit);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    return [];
  }
}

export function summarizeAssistantResult(result = {}) {
  const action = result.action || "";
  if (action === "draft") {
    return `已生成培训草稿：${result.draft?.title || "培训任务"}，对象 ${result.draft?.employees?.length || 0} 人，题目 ${result.draft?.quizCount || "-"} 道，通过分数 ${result.draft?.passScore || "-"} 分。`;
  }
  if (action === "status") return `已返回培训进度，共 ${result.tasks?.length || 0} 个任务。`;
  if (action === "delete_records") return `已处理删除培训记录，删除任务 ${result.deleted?.tasks || 0} 个。`;
  if (action === "marketing_article") {
    return result.article?.insufficient
      ? `软文生成失败：${result.article?.summary || "资料不足"}`
      : `已生成营销软文：${result.article?.title || "营销软文"}`;
  }
  if (action === "memory_saved") return `已保存 ${result.memory?.saved?.length || 0} 条记忆。`;
  if (action === "memory_list") return `已列出 ${result.memories?.length || 0} 条记忆。`;
  if (action === "memory_confirm") return "已请求用户确认是否保存或清空记忆。";
  if (action === "chat") return compactText(result.answer || result.error || "已处理普通聊天。");
  return compactText(result.answer || result.message || action || "已处理。");
}

export async function recordConversationTurn({ sessionId, memoryMode, message, result }) {
  if (!memoryEnabled(memoryMode)) return [];
  return await appendConversationEntries([
    { sessionId, role: "user", content: message, action: "user_message" },
    { sessionId, role: "assistant", content: summarizeAssistantResult(result), action: result?.action || "assistant_result" },
  ]);
}
