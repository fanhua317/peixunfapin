import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type TrainingPluginConfig = {
  serviceUrl?: string;
  apiToken?: string | { value?: string };
  timeoutMs?: number;
};

export const DEFAULT_SERVICE_URL = "http://127.0.0.1:8787";

export function getPluginConfig(api: OpenClawPluginApi): TrainingPluginConfig {
  const entries = (api.config as { plugins?: { entries?: Record<string, { config?: TrainingPluginConfig }> } }).plugins?.entries;
  return entries?.["training-rag"]?.config || {};
}

export function getApiToken(config: TrainingPluginConfig): string | undefined {
  if (typeof config.apiToken === "string") return config.apiToken;
  if (config.apiToken && typeof config.apiToken.value === "string") return config.apiToken.value;
  return undefined;
}
