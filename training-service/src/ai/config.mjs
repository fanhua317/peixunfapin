const DEFAULT_FLASH_MODEL = process.env.OPENCLAW_FLASH_MODEL || process.env.OPENCLAW_AI_MODEL || "deepseek/deepseek-v4-flash";
const DEFAULT_TRAINING_MODEL = process.env.OPENCLAW_TRAINING_MODEL || DEFAULT_FLASH_MODEL;

export const TRAINING_AI_SESSION_KEY = process.env.OPENCLAW_TRAINING_SESSION_KEY || "agent:main:training-service";
export const MAX_CONTEXT_CHARS = Number(process.env.TRAINING_AI_CONTEXT_CHARS || 12_000);
export const ANSWER_CONTEXT_LIMIT = Number(process.env.TRAINING_ANSWER_CONTEXT_LIMIT || 8);
export const LOW_VALUE_CONTEXT_RE = /(?:未能(?:从.*)?(?:抽取|提取).*?(?:文本|可复制文本)|无法(?:抽取|提取).*?(?:文本|可复制文本)|未抽取到(?:可复制)?文本|OCR\s*占位|图片型\s*PDF\s*占位|来源文件[:：]|页数[:：]|目录|封面|未识别文本|鏈兘|鎶藉彇|澶嶅埗鏂囨湰|鎵弿)/i;
export const PARAM_QUERY_RE = /(参数|范围|功率|机座|级数|能效|型号|尺寸|电压|电流|效率|YE\d|IE\d|kw|kW|pole|poles)/i;
export const PARAM_CHUNK_RE = /(机座范围|功率范围|级数|能效|机壳|列\s*2|Motor Model|Output\s*Power|standard\s*Eff)/i;
export const PROCESS_QUERY_RE = /(工艺|铸铝|品质|质量|检测|销售|话术|客户|介绍|附加损耗|转子|定子|冲剪|铁损|断条)/i;
export const FACTUAL_SOURCE_LIMIT = 8;

export const AI_PROFILE = {
  intent: {
    thinking: process.env.OPENCLAW_INTENT_THINKING || process.env.OPENCLAW_TRAINING_INTENT_THINKING || "minimal",
    model: process.env.OPENCLAW_INTENT_MODEL || process.env.OPENCLAW_TRAINING_INTENT_MODEL || DEFAULT_TRAINING_MODEL,
    timeoutMs: Number(process.env.OPENCLAW_INTENT_TIMEOUT_MS || process.env.OPENCLAW_TRAINING_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 45_000),
  },
  material: {
    thinking: process.env.OPENCLAW_MATERIAL_THINKING || process.env.OPENCLAW_TRAINING_MATERIAL_THINKING || "low",
    model: process.env.OPENCLAW_MATERIAL_MODEL || process.env.OPENCLAW_TRAINING_MATERIAL_MODEL || DEFAULT_TRAINING_MODEL,
    timeoutMs: Number(process.env.OPENCLAW_MATERIAL_TIMEOUT_MS || process.env.OPENCLAW_TRAINING_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 150_000),
  },
  quiz: {
    thinking: process.env.OPENCLAW_QUIZ_THINKING || process.env.OPENCLAW_TRAINING_QUIZ_THINKING || "medium",
    model: process.env.OPENCLAW_QUIZ_MODEL || process.env.OPENCLAW_TRAINING_QUIZ_MODEL || DEFAULT_TRAINING_MODEL,
    timeoutMs: Number(process.env.OPENCLAW_QUIZ_TIMEOUT_MS || process.env.OPENCLAW_TRAINING_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 180_000),
  },
  answer: {
    thinking: process.env.OPENCLAW_ANSWER_THINKING || process.env.OPENCLAW_TRAINING_ANSWER_THINKING || "medium",
    model: process.env.OPENCLAW_ANSWER_MODEL || process.env.OPENCLAW_TRAINING_ANSWER_MODEL || DEFAULT_TRAINING_MODEL,
    timeoutMs: Number(process.env.OPENCLAW_ANSWER_TIMEOUT_MS || process.env.OPENCLAW_TRAINING_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 120_000),
  },
  marketingArticle: {
    thinking: process.env.OPENCLAW_MARKETING_ARTICLE_THINKING || process.env.OPENCLAW_TRAINING_MARKETING_THINKING || "medium",
    model: process.env.OPENCLAW_MARKETING_ARTICLE_MODEL || process.env.OPENCLAW_TRAINING_MARKETING_MODEL || DEFAULT_TRAINING_MODEL,
    timeoutMs: Number(process.env.OPENCLAW_MARKETING_ARTICLE_TIMEOUT_MS || process.env.OPENCLAW_TRAINING_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 180_000),
  },
  repair: {
    thinking: process.env.OPENCLAW_REPAIR_THINKING || process.env.OPENCLAW_TRAINING_REPAIR_THINKING || "minimal",
    model: process.env.OPENCLAW_REPAIR_MODEL || process.env.OPENCLAW_TRAINING_REPAIR_MODEL || DEFAULT_TRAINING_MODEL,
    timeoutMs: Number(process.env.OPENCLAW_REPAIR_TIMEOUT_MS || process.env.OPENCLAW_TRAINING_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 90_000),
  },
};
