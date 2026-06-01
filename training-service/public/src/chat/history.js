import { chatSessionId, createChatSessionId, setChatSessionId } from "./session.js";
import { escapeHtml, formatDate } from "../ui.js";

const HISTORY_KEY = "juzhouTrainingChatHistory:v1";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 80;

let beforeSelectSession = null;
let onSelectSession = null;

function nowIso() {
  return new Date().toISOString();
}

function compact(value, limit = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function readStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}");
    return {
      activeSessionId: parsed.activeSessionId || "",
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return { activeSessionId: "", sessions: [] };
  }
}

function writeStore(store) {
  const cutoff = Date.now() - RETENTION_MS;
  const sessions = (store.sessions || [])
    .filter((session) => {
      const updated = Date.parse(session.updatedAt || session.createdAt || "");
      return Number.isFinite(updated) && updated >= cutoff;
    })
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
    .slice(0, MAX_SESSIONS);
  const activeSessionId = sessions.some((session) => session.id === store.activeSessionId)
    ? store.activeSessionId
    : sessions[0]?.id || "";
  localStorage.setItem(HISTORY_KEY, JSON.stringify({ activeSessionId, sessions }));
  return { activeSessionId, sessions };
}

function createSession(initialHtml) {
  const timestamp = nowIso();
  return {
    id: createChatSessionId(),
    title: "新聊天",
    preview: "还没有消息",
    html: initialHtml || "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function getSession(store, sessionId) {
  return store.sessions.find((session) => session.id === sessionId) || null;
}

function upsertSession(store, session) {
  const sessions = store.sessions.filter((item) => item.id !== session.id);
  sessions.unshift(session);
  return writeStore({ ...store, activeSessionId: session.id, sessions });
}

function renderHistoryList() {
  const panel = document.querySelector("#chatHistoryPanel");
  const list = document.querySelector("#chatHistoryList");
  if (!panel || !list || panel.hidden) return;
  const store = readStore();
  const active = store.activeSessionId || chatSessionId;
  list.innerHTML = store.sessions.length
    ? store.sessions.map((session) => `
      <button type="button" class="chat-history-item ${session.id === active ? "active" : ""}" data-chat-session="${escapeHtml(session.id)}">
        <span class="chat-history-title">${escapeHtml(session.title || "新聊天")}</span>
        <span class="chat-history-preview">${escapeHtml(session.preview || "")}</span>
        <span class="chat-history-time">${escapeHtml(formatDate(session.updatedAt))}</span>
        <span class="chat-history-delete" role="button" tabindex="0" title="删除这条记录" aria-label="删除这条记录" data-chat-delete="${escapeHtml(session.id)}">×</span>
      </button>
    `).join("")
    : `<p class="muted">暂无聊天记录。</p>`;
}

function selectSession(sessionId) {
  beforeSelectSession?.();
  const store = readStore();
  const session = getSession(store, sessionId);
  if (!session) return;
  writeStore({ ...store, activeSessionId: session.id });
  setChatSessionId(session.id);
  renderHistoryList();
  onSelectSession?.(session);
}

function deleteSession(sessionId, initialHtml) {
  beforeSelectSession?.();
  const store = readStore();
  const sessions = store.sessions.filter((session) => session.id !== sessionId);
  let activeSessionId = store.activeSessionId;
  if (activeSessionId === sessionId) activeSessionId = sessions[0]?.id || "";
  let nextStore = writeStore({ activeSessionId, sessions });
  if (!nextStore.activeSessionId) {
    const session = createSession(initialHtml);
    nextStore = upsertSession(nextStore, session);
  }
  const active = getSession(nextStore, nextStore.activeSessionId);
  if (active) {
    setChatSessionId(active.id);
    onSelectSession?.(active);
  }
  renderHistoryList();
}

export function persistCurrentChatHistory({ html, title, preview } = {}) {
  const store = readStore();
  const existing = getSession(store, chatSessionId);
  const timestamp = nowIso();
  const session = {
    ...(existing || { id: chatSessionId, createdAt: timestamp }),
    title: compact(title || existing?.title || "新聊天", 32),
    preview: compact(preview || existing?.preview || "", 72),
    html: html ?? existing?.html ?? "",
    updatedAt: timestamp,
  };
  upsertSession(store, session);
  renderHistoryList();
}

export function mountChatHistory({ initialHtml = "", beforeSelect, onSelect } = {}) {
  beforeSelectSession = beforeSelect || null;
  onSelectSession = onSelect || null;
  const panel = document.querySelector("#chatHistoryPanel");
  const newButton = document.querySelector("#newChatBtn");
  if (!panel || !newButton) return null;

  panel.hidden = false;
  let store = writeStore(readStore());
  let active = getSession(store, store.activeSessionId);
  if (!active) {
    active = createSession(initialHtml);
    store = upsertSession(store, active);
  }
  setChatSessionId(active.id);

  newButton.addEventListener("click", () => {
    beforeSelectSession?.();
    const session = createSession(initialHtml);
    upsertSession(readStore(), session);
    setChatSessionId(session.id);
    renderHistoryList();
    onSelectSession?.(session);
  });

  panel.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-chat-delete]");
    if (deleteButton) {
      event.preventDefault();
      event.stopPropagation();
      deleteSession(deleteButton.dataset.chatDelete, initialHtml);
      return;
    }
    const item = event.target.closest("[data-chat-session]");
    if (item) selectSession(item.dataset.chatSession);
  });

  renderHistoryList();
  return active;
}
