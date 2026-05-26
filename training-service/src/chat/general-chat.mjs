import { askOpenAiCompatibleLLM, getDirectLlmRuntimeConfig, streamOpenAiCompatibleLLM } from "../direct-llm.mjs";
import { renderMemorySystemSection } from "../memory/index.mjs";

const GENERAL_CHAT_MODEL = process.env.TRAINING_GENERAL_CHAT_MODEL || process.env.TRAINING_LLM_MODEL;
const GENERAL_CHAT_TIMEOUT_MS = Number(process.env.TRAINING_GENERAL_CHAT_TIMEOUT_MS || process.env.TRAINING_LLM_TIMEOUT_MS || 120_000);

function resolveThinking(text) {
  return /(分析|方案|对比|比较|为什么|如何|怎么|策略|设计|优化|权衡|规划|推理|复杂|详细|深度|长文|报告)/.test(String(text || ""))
    ? "medium"
    : "low";
}

function generalChatSystemPrompt(memoryContext = {}) {
  const memorySection = renderMemorySystemSection(memoryContext);
  return [
    "你是苏州钜洲工业有限公司培训系统里的大模型聊天助手。",
    "普通问候、解释、闲聊和开放问题都按自然对话回答。",
    "如果用户明确要求发布培训、查询培训进度、生成员工学习链接、考试或报表，不要假装已经执行；提醒用户这类操作会交给系统内的培训技能处理。",
    memorySection,
    "回答要简洁、自然、中文优先。",
  ].filter(Boolean).join("\n");
}

export function getGeneralChatRuntimeConfig() {
  const direct = getDirectLlmRuntimeConfig({ model: GENERAL_CHAT_MODEL });
  return {
    ...direct,
    requiredProvider: "openai-compatible",
  };
}

function assertGeneralChatConfigured() {
  const config = getGeneralChatRuntimeConfig();
  if (!config.apiKeyConfigured) {
    throw new Error("普通聊天需要配置大模型 API Key：请设置 TRAINING_LLM_API_KEY、DEEPSEEK_API_KEY 或 OPENAI_API_KEY 后重启 training-service。培训发布、邀请、考试等技能仍可继续使用。");
  }
  return config;
}

export async function answerGeneralChat(message, options = {}) {
  const text = String(message || "").trim();
  if (!text) {
    return { answer: "请先输入你的问题。", source: "llm-api" };
  }
  const config = assertGeneralChatConfigured();
  const result = await askOpenAiCompatibleLLM(text, {
    system: generalChatSystemPrompt(options.memoryContext),
    thinking: resolveThinking(text),
    model: config.model,
    timeoutMs: GENERAL_CHAT_TIMEOUT_MS,
  });
  return {
    ...result,
    source: "llm-api",
    route: "general_chat",
  };
}

export async function streamGeneralChat(message, { onDelta, signal, memoryContext } = {}) {
  const text = String(message || "").trim();
  if (!text) {
    return { answer: "请先输入你的问题。", source: "llm-api", route: "general_chat" };
  }
  const config = assertGeneralChatConfigured();
  let answer = "";
  for await (const event of streamOpenAiCompatibleLLM(text, {
    system: generalChatSystemPrompt(memoryContext),
    thinking: resolveThinking(text),
    model: config.model,
    timeoutMs: GENERAL_CHAT_TIMEOUT_MS,
    signal,
  })) {
    answer += event.delta;
    if (onDelta) onDelta(event.delta, event);
  }
  if (!answer) throw new Error("LLM API returned no assistant content");
  return {
    answer,
    source: "llm-api",
    route: "general_chat",
    provider: "openai-compatible",
    model: config.model,
  };
}
