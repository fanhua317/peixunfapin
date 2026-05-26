import { loadMemoryStore, markMemoriesUsed, memoryEnabled, readConversationHistory } from "./store.mjs";

function tokenize(text) {
  return [...new Set(String(text || "")
    .toLowerCase()
    .match(/[a-z0-9_+-]+|[\u4e00-\u9fff]/g) || [])];
}

function categoryBoost(memory, message) {
  const text = String(message || "");
  const tags = new Set(memory.tags || []);
  if (tags.has("marketing") && /(软文|营销|推广|公众号|文案|产品介绍)/.test(text)) return 8;
  if (tags.has("training") && /(培训|学习|考试|题|及格|发布|安排)/.test(text)) return 8;
  if (tags.has("workflow") && /(重新输入|确认|发布|误判|意图)/.test(text)) return 6;
  if (tags.has("general") && !/(培训|软文|删除|发布|考试)/.test(text)) return 3;
  return 0;
}

function scoreMemory(memory, messageTokens, message) {
  const memoryTokens = tokenize(`${memory.key} ${memory.text} ${(memory.tags || []).join(" ")}`);
  const overlap = memoryTokens.filter((token) => messageTokens.includes(token)).length;
  return overlap + categoryBoost(memory, message) + Math.min(Number(memory.uses) || 0, 4) * 0.2;
}

export async function buildMemoryContext({ sessionId, message, memoryMode = "auto", historyLimit = 12, memoryLimit = 8 } = {}) {
  if (!memoryEnabled(memoryMode)) {
    return {
      enabled: false,
      sessionId,
      recentMessages: [],
      longTerm: [],
      used: [],
    };
  }
  const [store, recentMessages] = await Promise.all([
    loadMemoryStore(),
    readConversationHistory(sessionId, { limit: historyLimit }),
  ]);
  const messageTokens = tokenize(message);
  const longTerm = store.memories
    .filter((memory) => memory.status === "active")
    .map((memory) => ({ memory, score: scoreMemory(memory, messageTokens, message) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, memoryLimit)
    .map((item) => item.memory);
  await markMemoriesUsed(longTerm.map((memory) => memory.id));
  return {
    enabled: true,
    sessionId,
    recentMessages,
    longTerm,
    used: longTerm.map((memory) => ({
      id: memory.id,
      key: memory.key,
      type: memory.type,
      text: memory.text,
      tags: memory.tags || [],
    })),
  };
}

export async function listMemoryItems(status = "") {
  const store = await loadMemoryStore();
  return store.memories
    .filter((memory) => !status || memory.status === status)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}
