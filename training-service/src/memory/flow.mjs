import { createIntentConfirmationToken } from "../intent-confirmation.mjs";
import {
  classifyMemoryCommand,
  extractMemoryCandidates,
  isMemoryOnlyInstruction,
  listMemoryItems,
  memoryResponseMeta,
  recordConversationTurn,
  upsertMemories,
} from "./index.mjs";

function publicMemory(memory) {
  return {
    id: memory.id,
    type: memory.type,
    key: memory.key,
    status: memory.status,
    text: memory.text,
    value: memory.value,
    tags: memory.tags || [],
    confidence: memory.confidence,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastUsedAt: memory.lastUsedAt,
    uses: memory.uses || 0,
  };
}

export function publicMemories(memories = []) {
  return memories.map(publicMemory);
}

export function memoryClearConfirmPayload() {
  const confirmation = createIntentConfirmationToken("clear_memory", "clear_memory");
  return {
    action: "memory_confirm",
    confirmation: {
      type: "clear",
      skill: "clear_memory",
      token: confirmation.token,
      expiresAt: confirmation.expiresAt,
      title: "确认清空记忆？",
      description: "清空会删除本地保存的长期偏好、工作流经验和会话摘要；业务数据、知识库、培训任务不受影响。",
      risk: "high",
    },
  };
}

export function memoryCandidateConfirmPayload(memory) {
  const confirmation = createIntentConfirmationToken(memory.id, "confirm_memory");
  return {
    type: "candidate",
    memory: publicMemory(memory),
    token: confirmation.token,
    expiresAt: confirmation.expiresAt,
    title: "保存这条记忆？",
    description: memory.text,
  };
}

function memoryPayload(saved = []) {
  const active = saved.filter((memory) => memory.status === "active");
  const pending = saved.filter((memory) => memory.status === "pending");
  if (pending.length && !active.length) {
    return {
      action: "memory_confirm",
      memory: {
        candidates: pending.map(memoryCandidateConfirmPayload),
      },
      confirmation: pending.length === 1 ? memoryCandidateConfirmPayload(pending[0]) : undefined,
    };
  }
  return {
    action: "memory_saved",
    message: active.length ? `已保存 ${active.length} 条记忆。` : "没有新的记忆需要保存。",
    memory: {
      saved: publicMemories(active),
      candidates: pending.map(memoryCandidateConfirmPayload),
    },
  };
}

export async function processMemoryInstruction(message, options = {}) {
  if (options.memoryMode === "off") return null;
  const command = classifyMemoryCommand(message);
  if (command?.type === "list") {
    const memories = await listMemoryItems();
    return {
      action: "memory_list",
      memories: publicMemories(memories),
    };
  }
  if (command?.type === "clear") {
    return memoryClearConfirmPayload();
  }
  const candidates = extractMemoryCandidates(message);
  if (!candidates.length || !isMemoryOnlyInstruction(message)) return null;
  const saved = await upsertMemories(candidates);
  return memoryPayload(saved);
}

export async function applyMemoryAfterTurn({ message, payload, memoryContext, sessionId, memoryMode }) {
  const memory = memoryResponseMeta(memoryContext);
  if (memoryMode !== "off") {
    const candidates = extractMemoryCandidates(message);
    if (candidates.length && !isMemoryOnlyInstruction(message)) {
      const saved = await upsertMemories(candidates);
      const active = saved.filter((item) => item.status === "active");
      const pending = saved.filter((item) => item.status === "pending");
      if (active.length) memory.saved = publicMemories(active);
      if (pending.length) memory.candidates = pending.map(memoryCandidateConfirmPayload);
    }
  }
  const result = Object.keys(memory).length
    ? { ...payload, memory: { ...(payload.memory || {}), ...memory } }
    : payload;
  await recordConversationTurn({ sessionId, memoryMode, message, result });
  return result;
}
