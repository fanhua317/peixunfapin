import { api } from "../api.js";
import { chatSessionId, createChatSessionId, setChatSessionId } from "./session.js";
import { escapeHtml, formatDate } from "../ui.js";

const LEGACY_HISTORY_KEY = "juzhouTrainingChatHistory:v1";
const LEGACY_IMPORT_MARK_KEY = "juzhouTrainingChatHistoryImported:v1";
const MAX_SESSIONS = 80;

let beforeSelectSession = null;
let onSelectSession = null;
let eventsWired = false;
let historyState = {
  activeSessionId: chatSessionId,
  error: "",
  importMessage: "",
  loading: false,
  sessions: [],
  syncing: false,
};

function nowIso() {
  return new Date().toISOString();
}

function compact(value, limit = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function normalizeDate(value, fallback = nowIso()) {
  return Number.isFinite(Date.parse(value || "")) ? value : fallback;
}

function readLegacyStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_HISTORY_KEY) || "{}");
    return {
      activeSessionId: parsed.activeSessionId || "",
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return { activeSessionId: "", sessions: [] };
  }
}

function hasLegacyHistory() {
  return readLegacyStore().sessions.length > 0;
}

function shouldOfferLegacyImport() {
  return hasLegacyHistory() && !localStorage.getItem(LEGACY_IMPORT_MARK_KEY);
}

function markLegacyImport(value) {
  localStorage.setItem(LEGACY_IMPORT_MARK_KEY, value);
}

function bubbleHtmlWithoutActions(bubble) {
  const clone = bubble?.cloneNode(true);
  clone?.querySelectorAll(".message-actions").forEach((item) => item.remove());
  return clone?.innerHTML?.trim() || "";
}

function messagesFromLegacyHtml(html) {
  if (!html) return [];
  const template = document.createElement("template");
  template.innerHTML = html;
  return [...template.content.querySelectorAll(".message")]
    .map((article) => {
      const bubble = article.querySelector(".bubble");
      if (!bubble) return null;
      if (article.classList.contains("user-message")) {
        return {
          role: "user",
          text: compact(bubble.textContent || "", 2000),
        };
      }
      return {
        role: "assistant",
        html: bubbleHtmlWithoutActions(bubble),
      };
    })
    .filter(Boolean);
}

function normalizeAssistantMessage(message, base) {
  const payload = message.payload && typeof message.payload === "object" ? message.payload : null;
  const action = payload?.action || message.action || "";
  if (payload) {
    if (action === "local_transcript") {
      return {
        ...base,
        result: {
          action: "chat_answer",
          answer: payload.transcript || message.content || "",
        },
      };
    }
    return {
      ...base,
      result: {
        ...payload,
        action: payload.action || action || "assistant_result",
        answer: payload.answer ?? message.content ?? payload.answer,
      },
      draftStatus: message.draftStatus || payload.draftStatus || "",
    };
  }
  return {
    ...base,
    html: message.html ?? `<p>${escapeHtml(message.content ?? "")}</p>`,
  };
}

function normalizeMessage(message) {
  if (!message || typeof message !== "object") return null;
  const role = message.role === "user" ? "user" : "assistant";
  const base = {
    id: message.id || `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    createdAt: normalizeDate(message.createdAt),
  };
  if (role === "user") {
    return {
      ...base,
      text: String(message.text ?? message.content ?? ""),
    };
  }
  if (message.result && typeof message.result === "object") {
    return {
      ...base,
      result: message.result,
      draftStatus: message.draftStatus || message.result.draftStatus || "",
    };
  }
  return normalizeAssistantMessage(message, base);
}

function normalizeMessages(messages, html = "") {
  const normalized = Array.isArray(messages)
    ? messages.map(normalizeMessage).filter(Boolean)
    : [];
  return normalized.length ? normalized : messagesFromLegacyHtml(html);
}

function inferMessagePreview(message) {
  if (!message) return "";
  if (message.role === "user") return message.text || "";
  if (message.result?.action === "draft") return `培训草稿：${message.result.draft?.title || ""}`;
  if (message.result?.action === "publish_result" || message.result?.action === "publish") return "培训已发布";
  if (message.result?.answer) return message.result.answer;
  if (message.html) {
    const template = document.createElement("template");
    template.innerHTML = message.html;
    return template.content.textContent || "";
  }
  return "";
}

function inferSessionPreview(messages) {
  return compact(inferMessagePreview(messages.at(-1)) || "还没有消息", 72);
}

function normalizeSession(session = {}) {
  const timestamp = nowIso();
  const messages = normalizeMessages(session.messages, session.html);
  const id = String(session.id || session.sessionId || createChatSessionId());
  return {
    id,
    title: compact(session.title || messages.find((message) => message.role === "user")?.text || "新聊天", 32),
    preview: compact(session.preview || inferSessionPreview(messages), 72),
    messages,
    createdAt: normalizeDate(session.createdAt, timestamp),
    updatedAt: normalizeDate(session.updatedAt || session.lastMessageAt, timestamp),
  };
}

function createSession(messages = []) {
  const timestamp = nowIso();
  return normalizeSession({
    id: createChatSessionId(),
    title: "新聊天",
    preview: "还没有消息",
    messages,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function normalizeSessionsPayload(payload) {
  const rawSessions = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.sessions)
      ? payload.sessions
      : [];
  return rawSessions.map(normalizeSession);
}

function normalizeSessionPayload(payload) {
  if (payload?.session) {
    return normalizeSession({
      ...payload.session,
      messages: payload.messages,
    });
  }
  return normalizeSession(payload);
}

function sortSessions(sessions) {
  return [...sessions]
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
    .slice(0, MAX_SESSIONS);
}

function getSession(sessionId) {
  return historyState.sessions.find((session) => session.id === sessionId) || null;
}

function chooseActiveSessionId(preferredId, sessions = historyState.sessions) {
  if (sessions.some((session) => session.id === preferredId)) return preferredId;
  if (sessions.some((session) => session.id === chatSessionId)) return chatSessionId;
  return sessions[0]?.id || "";
}

function setSessions(sessions, activeSessionId = historyState.activeSessionId) {
  const sorted = sortSessions(sessions);
  historyState = {
    ...historyState,
    activeSessionId: chooseActiveSessionId(activeSessionId, sorted),
    sessions: sorted,
  };
  return historyState;
}

function upsertSession(session, activeSessionId = session.id) {
  const sessions = historyState.sessions.filter((item) => item.id !== session.id);
  sessions.unshift(session);
  setSessions(sessions, activeSessionId);
  return session;
}

function removeSession(sessionId) {
  setSessions(historyState.sessions.filter((session) => session.id !== sessionId), historyState.activeSessionId);
}

function renderHistoryList() {
  const panel = document.querySelector("#chatHistoryPanel");
  const list = document.querySelector("#chatHistoryList");
  if (!panel || !list || panel.hidden) return;
  const active = historyState.activeSessionId || chatSessionId;
  const legacyImport = shouldOfferLegacyImport()
    ? `<div class="chat-history-import">
        <strong>发现本机旧聊天记录</strong>
        <p>旧记录仍在本机，确认后才会导入到服务端。</p>
        <div class="chat-history-import-actions">
          <button type="button" data-chat-import-local>导入</button>
          <button type="button" class="secondary" data-chat-dismiss-import>不再提示</button>
        </div>
      </div>`
    : "";
  const status = [
    historyState.loading ? `<p class="chat-history-status">正在加载聊天记录...</p>` : "",
    historyState.syncing ? `<p class="chat-history-status">正在同步...</p>` : "",
    historyState.importMessage ? `<p class="chat-history-status">${escapeHtml(historyState.importMessage)}</p>` : "",
    historyState.error ? `<p class="chat-history-error">${escapeHtml(historyState.error)}</p>` : "",
  ].filter(Boolean).join("");
  const sessions = historyState.sessions.length
    ? historyState.sessions.map((session) => `
      <button type="button" class="chat-history-item ${session.id === active ? "active" : ""}" data-chat-session="${escapeHtml(session.id)}">
        <span class="chat-history-title">${escapeHtml(session.title || "新聊天")}</span>
        <span class="chat-history-preview">${escapeHtml(session.preview || "")}</span>
        <span class="chat-history-time">${escapeHtml(formatDate(session.updatedAt))}</span>
        <span class="chat-history-delete" role="button" tabindex="0" title="删除这条记录" aria-label="删除这条记录" data-chat-delete="${escapeHtml(session.id)}">×</span>
      </button>
    `).join("")
    : `<p class="muted">暂无聊天记录。</p>`;
  list.innerHTML = `${legacyImport}${status}${sessions}`;
}

async function fetchSessions() {
  historyState = { ...historyState, loading: true, error: "" };
  renderHistoryList();
  try {
    const payload = await api(`/api/boss-chat/sessions?limit=${MAX_SESSIONS}`);
    const sessions = normalizeSessionsPayload(payload);
    setSessions(sessions, payload?.activeSessionId || chatSessionId);
    historyState = { ...historyState, loading: false, error: "" };
  } catch (error) {
    historyState = {
      ...historyState,
      loading: false,
      error: `聊天历史服务暂不可用：${error.message}`,
    };
  }
  renderHistoryList();
}

async function loadSession(sessionId) {
  const payload = await api(`/api/boss-chat/sessions/${encodeURIComponent(sessionId)}`);
  const session = normalizeSessionPayload(payload);
  upsertSession(session, session.id);
  return session;
}

async function createRemoteSession(messages = []) {
  const draft = createSession(messages);
  const payload = await api("/api/boss-chat/sessions", {
    method: "POST",
    body: JSON.stringify(draft),
  });
  const session = normalizeSessionPayload(payload);
  upsertSession(session, session.id);
  return session;
}

async function createOrFallbackSession(messages = []) {
  try {
    const session = await createRemoteSession(messages);
    historyState = { ...historyState, error: "" };
    return session;
  } catch (error) {
    const session = createSession(messages);
    upsertSession(session, session.id);
    historyState = {
      ...historyState,
      error: `聊天历史服务暂不可用：${error.message}`,
    };
    return session;
  } finally {
    renderHistoryList();
  }
}

async function patchRemoteSession(session) {
  const payload = await api(`/api/boss-chat/sessions/${encodeURIComponent(session.id)}`, {
    method: "PATCH",
    body: JSON.stringify(session),
  });
  return normalizeSessionPayload(payload?.session ? { ...payload, messages: session.messages } : payload);
}

async function selectSession(sessionId) {
  await beforeSelectSession?.();
  const existing = getSession(sessionId);
  let session = existing;
  try {
    session = await loadSession(sessionId);
    historyState = { ...historyState, error: "" };
  } catch (error) {
    historyState = {
      ...historyState,
      error: `无法读取这条聊天记录：${error.message}`,
    };
  }
  if (!session) {
    renderHistoryList();
    return;
  }
  historyState = { ...historyState, activeSessionId: session.id };
  setChatSessionId(session.id);
  renderHistoryList();
  onSelectSession?.(session);
}

async function createAndSelectSession() {
  await beforeSelectSession?.();
  const session = await createOrFallbackSession([]);
  historyState = { ...historyState, activeSessionId: session.id };
  setChatSessionId(session.id);
  renderHistoryList();
  onSelectSession?.(session);
}

async function deleteSession(sessionId) {
  await beforeSelectSession?.();
  try {
    await api(`/api/boss-chat/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    historyState = { ...historyState, error: "" };
  } catch (error) {
    historyState = {
      ...historyState,
      error: `删除失败：${error.message}`,
    };
    renderHistoryList();
    return;
  }
  removeSession(sessionId);
  let activeSessionId = historyState.activeSessionId;
  if (activeSessionId === sessionId) activeSessionId = historyState.sessions[0]?.id || "";
  historyState = { ...historyState, activeSessionId };
  let active = activeSessionId ? getSession(activeSessionId) : null;
  if (active?.id) {
    try {
      active = await loadSession(active.id);
    } catch {
      // Keep the summary already in memory so the user is not stranded.
    }
  } else {
    active = await createOrFallbackSession([]);
  }
  historyState = { ...historyState, activeSessionId: active.id };
  setChatSessionId(active.id);
  renderHistoryList();
  onSelectSession?.(active);
}

function legacySessionForImport(session) {
  const normalized = normalizeSession(session);
  return {
    ...normalized,
    html: session.html || "",
    legacyId: session.id || "",
  };
}

export async function importLegacyChatHistory() {
  const legacy = readLegacyStore();
  if (!legacy.sessions.length) {
    markLegacyImport("empty");
    historyState = { ...historyState, importMessage: "没有可导入的旧记录。" };
    renderHistoryList();
    return;
  }
  historyState = { ...historyState, importMessage: "正在导入旧记录...", error: "" };
  renderHistoryList();
  try {
    const payload = await api("/api/boss-chat/import-local", {
      method: "POST",
      body: JSON.stringify({
        activeSessionId: legacy.activeSessionId || "",
        sessions: legacy.sessions.map(legacySessionForImport),
      }),
    });
    markLegacyImport("imported");
    localStorage.removeItem(LEGACY_HISTORY_KEY);
    await fetchSessions();
    const activeId = chooseActiveSessionId(payload?.activeSessionId || legacy.activeSessionId || payload?.sessionIds?.[0]);
    const active = activeId ? await loadSession(activeId) : historyState.sessions[0] || await createOrFallbackSession([]);
    historyState = {
      ...historyState,
      activeSessionId: active.id,
      error: "",
      importMessage: "旧记录已导入。",
    };
    setChatSessionId(active.id);
    renderHistoryList();
    onSelectSession?.(active);
    return payload;
  } catch (error) {
    historyState = {
      ...historyState,
      error: `旧记录导入失败：${error.message}`,
      importMessage: "",
    };
    renderHistoryList();
  }
}

export function dismissLegacyChatImport() {
  markLegacyImport("skipped");
  historyState = { ...historyState, importMessage: "已保留旧记录在本机，不再提示导入。" };
  renderHistoryList();
}

function wireHistoryEvents(newButton, panel) {
  if (eventsWired) return;
  eventsWired = true;
  newButton.addEventListener("click", () => {
    createAndSelectSession();
  });

  panel.addEventListener("click", (event) => {
    const importButton = event.target.closest("[data-chat-import-local]");
    if (importButton) {
      importLegacyChatHistory();
      return;
    }
    const dismissButton = event.target.closest("[data-chat-dismiss-import]");
    if (dismissButton) {
      dismissLegacyChatImport();
      return;
    }
    const deleteButton = event.target.closest("[data-chat-delete]");
    if (deleteButton) {
      event.preventDefault();
      event.stopPropagation();
      deleteSession(deleteButton.dataset.chatDelete);
      return;
    }
    const item = event.target.closest("[data-chat-session]");
    if (item) selectSession(item.dataset.chatSession);
  });

  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const deleteButton = event.target.closest("[data-chat-delete]");
    if (!deleteButton) return;
    event.preventDefault();
    deleteSession(deleteButton.dataset.chatDelete);
  });
}

export async function persistCurrentChatHistory({ messages = [], title, preview } = {}) {
  const existing = getSession(chatSessionId);
  const timestamp = nowIso();
  const session = normalizeSession({
    ...(existing || { id: chatSessionId, createdAt: timestamp }),
    title: compact(title || existing?.title || "新聊天", 32),
    preview: compact(preview || existing?.preview || "还没有消息", 72),
    messages,
    updatedAt: timestamp,
  });
  upsertSession(session, session.id);
  historyState = { ...historyState, activeSessionId: session.id, syncing: true, error: "" };
  renderHistoryList();
  try {
    const saved = await patchRemoteSession(session);
    upsertSession(saved, saved.id);
    historyState = { ...historyState, activeSessionId: saved.id, syncing: false, error: "" };
    if (saved.id !== chatSessionId) setChatSessionId(saved.id);
  } catch (error) {
    historyState = {
      ...historyState,
      activeSessionId: session.id,
      syncing: false,
      error: `聊天历史同步失败：${error.message}`,
    };
  }
  renderHistoryList();
}

export async function mountChatHistory({ beforeSelect, onSelect } = {}) {
  beforeSelectSession = beforeSelect || null;
  onSelectSession = onSelect || null;
  const panel = document.querySelector("#chatHistoryPanel");
  const newButton = document.querySelector("#newChatBtn");
  if (!panel || !newButton) return null;

  panel.hidden = false;
  wireHistoryEvents(newButton, panel);
  await fetchSessions();
  let active = null;
  const activeId = chooseActiveSessionId(chatSessionId);
  if (activeId) {
    try {
      active = await loadSession(activeId);
    } catch (error) {
      active = getSession(activeId);
      historyState = {
        ...historyState,
        error: active ? historyState.error : `无法读取当前聊天记录：${error.message}`,
      };
    }
  }
  if (!active) active = await createOrFallbackSession([]);
  historyState = { ...historyState, activeSessionId: active.id };
  setChatSessionId(active.id);
  renderHistoryList();
  return active;
}
