import { askOpenAiCompatibleLLM, getDirectLlmRuntimeConfig } from "../direct-llm.mjs";
import { getBossChatSession } from "../boss-chat/store.mjs";

const TRANSLATION_MODEL = process.env.TRAINING_TRANSLATION_MODEL || process.env.TRAINING_LLM_MODEL;
const TRANSLATION_TIMEOUT_MS = Number(process.env.TRAINING_TRANSLATION_TIMEOUT_MS || process.env.TRAINING_LLM_TIMEOUT_MS || 120_000);
const MAX_SOURCE_CHARS = Number(process.env.TRAINING_TRANSLATION_MAX_SOURCE_CHARS || 30000);
const MIN_SUFFIX_SOURCE_CHARS = 2;

function compact(value, limit = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function cleanText(value) {
  return String(value || "")
    .replace(/^[“"'「『]|[”"'」』]$/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n")
    .trim();
}

function looksChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function limitSource(value) {
  return cleanText(value);
}

function isSourceTooLong(value) {
  return cleanText(value).length > MAX_SOURCE_CHARS;
}

function normalizeTargetLanguage(value) {
  const text = String(value || "")
    .replace(/^(成|为|到|to|into)\s*/i, "")
    .replace(/[：:，,。.!！?？\s]+$/g, "")
    .trim();
  if (!text || /^(一下|文本|内容|这段|这个|翻译)$/i.test(text)) return "";
  return text;
}

function defaultTargetLanguage(sourceText) {
  return looksChinese(sourceText) ? "英文" : "中文";
}

function extractColonRequest(text) {
  const value = String(text || "").trim();
  const patterns = [
    /^(?:请)?(?:把|将)?\s*(?:这段|以下|下面的)?\s*翻译(?:一下)?(?:成|为|到)?\s*([^：:\n]*)\s*[：:]\s*([\s\S]+)$/i,
    /^translate\s+(?:to|into)\s+([^：:\n]+)\s*[：:]\s*([\s\S]+)$/i,
    /^(?:翻译|translation)\s*[：:]\s*([\s\S]+)$/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    if (pattern === patterns[2]) {
      return { targetLanguage: "", sourceText: cleanText(match[1]) };
    }
    return {
      targetLanguage: normalizeTargetLanguage(match[1]),
      sourceText: cleanText(match[2]),
    };
  }
  return null;
}

function extractInlineRequest(text) {
  const value = String(text || "").trim();
  const quoted = value.match(/^(?:请)?(?:把|将)?\s*[“"「『]([\s\S]+?)[”"」』]\s*翻译(?:成|为|到)?\s*([^\s，,。.!！?？]+)\s*$/i);
  if (quoted) {
    return { sourceText: cleanText(quoted[1]), targetLanguage: normalizeTargetLanguage(quoted[2]) };
  }
  const cn = value.match(/^(?:请)?(?:把|将)\s*([\s\S]+?)\s*翻译(?:成|为|到)\s*([^\s，,。.!！?？]+)\s*$/i);
  if (cn) {
    return { sourceText: cleanText(cn[1]), targetLanguage: normalizeTargetLanguage(cn[2]) };
  }
  const en = value.match(/^translate\s+([\s\S]+?)\s+(?:to|into)\s+([^\n:：]+)$/i);
  if (en) {
    return { sourceText: cleanText(en[1]), targetLanguage: normalizeTargetLanguage(en[2]) };
  }
  return null;
}

function extractSuffixRequest(text) {
  const value = String(text || "").trim();
  const cn = value.match(/^([\s\S]+?)\s*(?:请)?(?:帮我|麻烦)?翻译(?:一下)?(?:成|为|到)\s*([^\s：:，,。.!！?？]+)\s*$/i);
  if (cn) {
    const sourceText = cleanText(cn[1]);
    const targetLanguage = normalizeTargetLanguage(cn[2]);
    if (
      sourceText.length >= MIN_SUFFIX_SOURCE_CHARS
      && targetLanguage
      && !/^(请|帮我|麻烦|帮忙|可以|能不能|能否)$/i.test(sourceText)
    ) {
      return { sourceText, targetLanguage };
    }
  }

  const en = value.match(/^([\s\S]+?)\s+translate\s+(?:to|into)\s+([^\n:：]+)$/i);
  if (en) {
    const sourceText = cleanText(en[1]);
    const targetLanguage = normalizeTargetLanguage(en[2]);
    if (sourceText.length >= MIN_SUFFIX_SOURCE_CHARS && targetLanguage) {
      return { sourceText, targetLanguage };
    }
  }

  return null;
}

function extractBareTarget(text) {
  const value = String(text || "").trim();
  const cn = value.match(/^(?:请)?翻译(?:一下)?(?:成|为|到)?\s*([^\s：:，,。.!！?？]+)\s*$/i)
    || value.match(/^(?:请)?译(?:成|为|到)\s*([^\s：:，,。.!！?？]+)\s*$/i);
  if (cn) return { sourceText: "", targetLanguage: normalizeTargetLanguage(cn[1]) };
  const en = value.match(/^translate\s+(?:to|into)\s+([^\n:：]+)$/i);
  if (en) return { sourceText: "", targetLanguage: normalizeTargetLanguage(en[1]) };
  return null;
}

export function parseTranslationRequest(message) {
  const text = String(message || "").trim();
  const parsed = extractColonRequest(text) || extractInlineRequest(text) || extractSuffixRequest(text) || extractBareTarget(text);
  if (!parsed) return { sourceText: "", targetLanguage: "", matched: false };
  const sourceText = limitSource(parsed.sourceText);
  const targetLanguage = normalizeTargetLanguage(parsed.targetLanguage) || (sourceText ? defaultTargetLanguage(sourceText) : "");
  return {
    matched: true,
    sourceText,
    targetLanguage,
  };
}

function contentFromPayload(payload = {}) {
  const action = payload?.action || "";
  if (action === "translation") return payload.translatedText || "";
  if (action === "chat") return payload.answer || "";
  if (action === "knowledge_answer") return payload.answer || "";
  if (action === "marketing_article") return payload.article?.article || payload.article?.summary || "";
  if (action === "local_transcript") return payload.transcript || "";
  return "";
}

function isTranslatableCandidate(text) {
  const value = cleanText(text);
  if (value.length < 2) return false;
  if (/^(翻译|translate\b|译成|译为)/i.test(value)) return false;
  if (/我可以帮你做什么|发布销售新人培训|查询培训进度/.test(value)) return false;
  if (/^(已保存记忆|记忆已更新|培训已发布|请确认培训安排)$/.test(value)) return false;
  return true;
}

export async function findRecentTranslatableText(sessionId) {
  if (!sessionId) return "";
  const result = await getBossChatSession(sessionId);
  const messages = result?.messages || [];
  for (const message of [...messages].reverse()) {
    const payload = message.payload && typeof message.payload === "object" ? message.payload : null;
    const text = payload ? contentFromPayload(payload) : message.content;
    if (isTranslatableCandidate(text)) return limitSource(text);
  }
  return "";
}

export function getTranslationRuntimeConfig() {
  const direct = getDirectLlmRuntimeConfig({ model: TRANSLATION_MODEL });
  return {
    ...direct,
    requiredProvider: "openai-compatible",
  };
}

function assertTranslationConfigured() {
  const config = getTranslationRuntimeConfig();
  if (!config.apiKeyConfigured) {
    throw new Error("翻译需要可用的大模型 API Key：请配置 TRAINING_LLM_API_KEY、DEEPSEEK_API_KEY 或 OPENAI_API_KEY 后重试。");
  }
  return config;
}

function translationSystemPrompt(targetLanguage) {
  return [
    "你是专业翻译助手，只负责文本翻译。",
    `把用户提供的原文忠实翻译成${targetLanguage}。`,
    "必须覆盖原文的全部内容，不能只翻译开头，不能概括或省略后续段落。",
    "不要扩写，不要解释，不要加入产品知识，不要添加标题。",
    "保留原文中的数字、型号、单位、专有名词和换行结构；必要时仅做符合目标语言习惯的轻微调整。",
    "只输出译文。",
  ].join("\n");
}

export async function translateText(message, options = {}) {
  const parsed = parseTranslationRequest(message);
  let sourceText = parsed.sourceText;
  let targetLanguage = parsed.targetLanguage;
  if (!sourceText) sourceText = await findRecentTranslatableText(options.sessionId);
  if (!targetLanguage && sourceText) targetLanguage = defaultTargetLanguage(sourceText);

  if (isSourceTooLong(sourceText)) {
    return {
      action: "translation_request",
      sourceText: "",
      targetLanguage: targetLanguage || "",
      message: `这段文本约 ${sourceText.length} 字，超过当前翻译上限 ${MAX_SOURCE_CHARS} 字。请分段发送，或提高 TRAINING_TRANSLATION_MAX_SOURCE_CHARS 后再试。`,
      route: "translation",
      source: "translation-parser",
      sourceTooLong: true,
      sourceLength: sourceText.length,
      maxSourceChars: MAX_SOURCE_CHARS,
    };
  }

  if (!sourceText || !targetLanguage) {
    return {
      action: "translation_request",
      sourceText: sourceText || "",
      targetLanguage: targetLanguage || "",
      message: targetLanguage
        ? `请提供要翻译成${targetLanguage}的原文。`
        : "请提供要翻译的内容和目标语言。",
      route: "translation",
      source: "translation-parser",
    };
  }

  const config = assertTranslationConfigured();
  const result = await askOpenAiCompatibleLLM(sourceText, {
    system: translationSystemPrompt(targetLanguage),
    thinking: "low",
    model: config.model,
    timeoutMs: TRANSLATION_TIMEOUT_MS,
    temperature: 0.2,
  });
  return {
    action: "translation",
    sourceText,
    targetLanguage,
    translatedText: cleanText(result.answer),
    model: result.model,
    provider: result.provider,
    source: "llm-api",
    route: "translation",
    usage: result.usage,
  };
}

export function summarizeTranslationPayload(payload = {}) {
  return {
    action: payload.action,
    targetLanguage: payload.targetLanguage || "",
    hasSource: Boolean(payload.sourceText),
    hasTranslation: Boolean(payload.translatedText),
    sourcePreview: compact(payload.sourceText, 120),
    translationPreview: compact(payload.translatedText || payload.message || payload.error, 160),
    model: payload.model || "",
  };
}
