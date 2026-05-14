import { askOpenClaw } from "./general-chat.mjs";

const DEFAULT_PROVIDER = process.env.TRAINING_LLM_PROVIDER || "openclaw";

async function callOpenClawProvider(message, options) {
  return await askOpenClaw(message, options);
}

const PROVIDERS = {
  openclaw: callOpenClawProvider,
};

export function resolveLlmProvider(name) {
  const key = String(name || DEFAULT_PROVIDER || "openclaw").toLowerCase();
  return PROVIDERS[key] || PROVIDERS.openclaw;
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
