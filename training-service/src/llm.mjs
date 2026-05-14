import { askOpenClaw } from "./general-chat.mjs";
import { askOpenAiCompatibleLLM, getDirectLlmRuntimeConfig } from "./direct-llm.mjs";

const DEFAULT_PROVIDER = process.env.TRAINING_LLM_PROVIDER || "auto";

async function callOpenClawProvider(message, options) {
  return await askOpenClaw(message, options);
}

function hasDirectLlmConfig() {
  return getDirectLlmRuntimeConfig().apiKeyConfigured;
}

export function getLlmRuntimeConfig() {
  const requestedProvider = String(process.env.TRAINING_LLM_PROVIDER || DEFAULT_PROVIDER || "auto").toLowerCase();
  const direct = getDirectLlmRuntimeConfig();
  const directConfigured = direct.apiKeyConfigured;
  return {
    provider: requestedProvider,
    effectiveProvider: requestedProvider === "auto" ? (directConfigured ? "openai-compatible" : "openclaw") : requestedProvider,
    directConfigured,
    baseUrl: direct.baseUrl,
    model: direct.model,
    apiKeyConfigured: directConfigured,
  };
}

async function callOpenAiCompatibleProvider(message, options = {}) {
  return await askOpenAiCompatibleLLM(message, options);
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
