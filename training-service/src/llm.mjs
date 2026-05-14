import { askOpenClaw } from "./general-chat.mjs";

const DEFAULT_PROVIDER = process.env.TRAINING_LLM_PROVIDER || "auto";
const DEFAULT_TIMEOUT_MS = Number(process.env.TRAINING_LLM_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 120_000);
const DEFAULT_TEMPERATURE = Number(process.env.TRAINING_LLM_TEMPERATURE || 0.2);
const DEFAULT_MAX_TOKENS = Number(process.env.TRAINING_LLM_MAX_TOKENS || 4096);

async function callOpenClawProvider(message, options) {
  return await askOpenClaw(message, options);
}

function resolveDirectApiKey() {
  return process.env.TRAINING_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "";
}

function resolveDirectBaseUrl() {
  if (process.env.TRAINING_LLM_BASE_URL) return process.env.TRAINING_LLM_BASE_URL;
  if (process.env.OPENAI_BASE_URL) return process.env.OPENAI_BASE_URL;
  if (process.env.DEEPSEEK_BASE_URL) return process.env.DEEPSEEK_BASE_URL;
  return process.env.OPENAI_API_KEY && !process.env.DEEPSEEK_API_KEY
    ? "https://api.openai.com/v1"
    : "https://api.deepseek.com/v1";
}

function resolveDirectModel(options = {}) {
  const configured = process.env.TRAINING_LLM_MODEL || process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL;
  if (configured) return configured;
  const candidate = String(options.model || "").trim();
  if (candidate && !candidate.includes("/")) return candidate;
  return process.env.OPENAI_API_KEY && !process.env.DEEPSEEK_API_KEY ? "gpt-4.1-mini" : "deepseek-chat";
}

function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

function hasDirectLlmConfig() {
  return Boolean(resolveDirectApiKey());
}

export function getLlmRuntimeConfig() {
  const requestedProvider = String(process.env.TRAINING_LLM_PROVIDER || DEFAULT_PROVIDER || "auto").toLowerCase();
  const directConfigured = hasDirectLlmConfig();
  return {
    provider: requestedProvider,
    effectiveProvider: requestedProvider === "auto" ? (directConfigured ? "openai-compatible" : "openclaw") : requestedProvider,
    directConfigured,
    baseUrl: resolveDirectBaseUrl(),
    model: resolveDirectModel(),
    apiKeyConfigured: directConfigured,
  };
}

async function callOpenAiCompatibleProvider(message, options = {}) {
  const apiKey = resolveDirectApiKey();
  if (!apiKey) {
    throw new Error("TRAINING_LLM_API_KEY, DEEPSEEK_API_KEY, or OPENAI_API_KEY is required for direct LLM calls");
  }
  const model = resolveDirectModel(options);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const body = {
    model,
    messages: [{ role: "user", content: String(message || "") }],
    temperature: Number(options.temperature ?? DEFAULT_TEMPERATURE),
    stream: false,
  };
  if (DEFAULT_MAX_TOKENS > 0) body.max_tokens = DEFAULT_MAX_TOKENS;

  try {
    const response = await fetch(chatCompletionsUrl(resolveDirectBaseUrl()), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || text || response.statusText;
      throw new Error(`LLM API request failed: ${detail}`);
    }
    const answer = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || "";
    if (!answer) throw new Error("LLM API returned no assistant content");
    return {
      answer,
      source: "llm-api",
      provider: "openai-compatible",
      model,
      thinking: options.thinking || options.thinkingLevel,
      usage: payload?.usage,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callAutoProvider(message, options = {}) {
  if (hasDirectLlmConfig()) {
    return await callOpenAiCompatibleProvider(message, options);
  }
  return await callOpenClawProvider(message, options);
}

const PROVIDERS = {
  auto: callAutoProvider,
  openclaw: callOpenClawProvider,
  "openai-compatible": callOpenAiCompatibleProvider,
  openai: callOpenAiCompatibleProvider,
  deepseek: callOpenAiCompatibleProvider,
  direct: callOpenAiCompatibleProvider,
};

export function resolveLlmProvider(name) {
  const key = String(name || DEFAULT_PROVIDER || "auto").toLowerCase();
  return PROVIDERS[key] || PROVIDERS.auto;
}

export async function askLLM(message, options = {}) {
  const provider = resolveLlmProvider(options.provider);
  return await provider(message, options);
}

export function registerLlmProvider(name, handler) {
  if (!name || typeof handler !== "function") return;
  PROVIDERS[String(name).toLowerCase()] = handler;
}

export { DEFAULT_PROVIDER };
