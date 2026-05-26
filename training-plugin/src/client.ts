import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_SERVICE_URL, getApiToken, getPluginConfig } from "./config";

export async function callTrainingService(api: OpenClawPluginApi, path: string, init: RequestInit = {}) {
  const config = getPluginConfig(api);
  const serviceUrl = (config.serviceUrl || process.env.TRAINING_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/$/, "");
  const timeoutMs = Number(config.timeoutMs || process.env.TRAINING_SERVICE_TIMEOUT_MS || 20_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const token = getApiToken(config) || process.env.TRAINING_SERVICE_TOKEN;
  try {
    const response = await fetch(`${serviceUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(payload?.error || `training-service HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}
