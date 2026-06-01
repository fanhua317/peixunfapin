const CHAT_SESSION_KEY = "juzhouTrainingChatSessionId";

export function createChatSessionId() {
  return `boss-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export let chatSessionId = (() => {
  const existing = localStorage.getItem(CHAT_SESSION_KEY);
  if (existing) return existing;
  const value = createChatSessionId();
  localStorage.setItem(CHAT_SESSION_KEY, value);
  return value;
})();

export function setChatSessionId(value) {
  chatSessionId = value || createChatSessionId();
  localStorage.setItem(CHAT_SESSION_KEY, chatSessionId);
  return chatSessionId;
}

export function agentBody(payload = {}) {
  return JSON.stringify({
    sessionId: chatSessionId,
    memoryMode: "auto",
    ...payload,
  });
}

export function agentStreamUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/agent/stream`;
}
