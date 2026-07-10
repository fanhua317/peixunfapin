import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_SERVICE_URL, getApiToken, getPluginConfig } from "./config";

export async function callTrainingService(api: OpenClawPluginApi, path: string, init: RequestInit = {}) {
  const config = getPluginConfig(api);
  const serviceUrl = (config.serviceUrl || process.env.TRAINING_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/$/, "");
  const configuredTimeout = Number(config.timeoutMs || process.env.TRAINING_SERVICE_TIMEOUT_MS || 20_000);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(100, Math.min(configuredTimeout, 300_000)) : 20_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const token = getApiToken(config) || process.env.TRAINING_SERVICE_TOKEN;
  try {
    const response = await fetch(`${serviceUrl}${path}`, {
      ...init,
      signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        const preview = text.replace(/\s+/g, " ").trim().slice(0, 240);
        throw new Error(`training-service returned non-JSON response for ${path} (HTTP ${response.status}): ${preview || "empty response"}`);
      }
    }
    if (!response.ok) {
      const detail = payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error || "")
        : "";
      throw new Error(`training-service HTTP ${response.status} for ${path}${detail ? `: ${detail}` : ""}`);
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`training-service request timed out after ${timeoutMs}ms: ${path}`, { cause: error });
    }
    throw error;
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
