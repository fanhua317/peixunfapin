const DEFAULT_TIMEOUT_MS = Number(process.env.TRAINING_RERANKER_TIMEOUT_MS || 15_000);
const DEFAULT_CANDIDATES = Number(process.env.TRAINING_RERANKER_CANDIDATES || 20);
const DEFAULT_WEIGHT = Number(process.env.TRAINING_RERANKER_WEIGHT || 0.75);
const MAX_DOCUMENTS = 50;
const MAX_DOCUMENT_CHARS = 4_000;

function enabledValue(value) {
  return ["1", "true", "on", "yes"].includes(String(value || "").trim().toLowerCase());
}

function rerankerBaseUrl() {
  const raw = String(process.env.TRAINING_RERANKER_URL || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return "";
    // Authentication belongs in the Bearer header. Never retain URL credentials,
    // query tokens, or fragments in requests, health output, or error messages.
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function authHeaders() {
  const token = String(process.env.TRAINING_RERANKER_API_KEY || "").trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function buildUrl(pathname) {
  const baseUrl = rerankerBaseUrl();
  return `${baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function compactError(error) {
  return `reranker unavailable (${rerankerFailureCode(error)})`;
}

function rerankerFailureCode(error) {
  const name = String(error?.name || "").toLowerCase();
  const text = error instanceof Error ? error.message : String(error || "");
  if (name === "aborterror" || /timeout|timed out|aborted/i.test(text)) return "timeout";
  if (/\((?:401|403)\)/.test(text)) return "authentication_failed";
  if (/\(4\d\d\)/.test(text)) return "request_rejected";
  if (/\(5\d\d\)/.test(text)) return "service_error";
  if (/non-json/i.test(text)) return "invalid_response";
  if (/no usable results|returned no usable/i.test(text)) return "empty_response";
  if (/fetch failed|econn|socket|network|unavailable/i.test(text)) return "unavailable";
  return "request_failed";
}

async function fetchJson(pathname, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildUrl(pathname), {
      method: options.method || "GET",
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...authHeaders(),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`reranker returned non-JSON response (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`reranker request failed (${response.status}): ${payload?.error || payload?.detail || response.statusText}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export function getRerankerRuntimeConfig() {
  const url = rerankerBaseUrl();
  const apiKeyConfigured = Boolean(String(process.env.TRAINING_RERANKER_API_KEY || "").trim());
  const configured = Boolean(url && apiKeyConfigured);
  // Keep the optional dependency off until an operator explicitly enables the
  // A/B-accepted route. Merely placing credentials in an env file is not consent
  // to change production retrieval behavior.
  const enabled = enabledValue(process.env.TRAINING_RERANKER_ENABLED);
  return {
    enabled,
    configured,
    provider: String(process.env.TRAINING_RERANKER_PROVIDER || "http").trim().toLowerCase(),
    url,
    model: String(process.env.TRAINING_RERANKER_MODEL || "BAAI/bge-reranker-v2-m3").trim(),
    timeoutMs: Math.max(500, DEFAULT_TIMEOUT_MS),
    candidates: Math.max(1, Math.min(DEFAULT_CANDIDATES || 20, MAX_DOCUMENTS)),
    weight: Math.max(0, Math.min(Number.isFinite(DEFAULT_WEIGHT) ? DEFAULT_WEIGHT : 0.75, 1)),
    apiKeyConfigured,
  };
}

export async function checkRerankerRuntime() {
  const config = getRerankerRuntimeConfig();
  if (!config.enabled) return { ...config, ok: false, status: "disabled" };
  if (!config.configured) return { ...config, ok: false, status: "unconfigured" };
  const startedAt = Date.now();
  try {
    const payload = await fetchJson("/health", { timeoutMs: Math.min(config.timeoutMs, 3_000) });
    return {
      ...config,
      ok: payload?.ok !== false,
      status: payload?.status || (payload?.ok === false ? "unavailable" : "ready"),
      model: payload?.model || config.model,
      device: payload?.device || "",
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ...config,
      ok: false,
      status: "unavailable",
      latencyMs: Date.now() - startedAt,
      error: compactError(error),
    };
  }
}

export async function rerankDocuments(query, documents, options = {}) {
  const config = getRerankerRuntimeConfig();
  if (!config.enabled) return { ok: false, status: "disabled", results: [], model: config.model, latencyMs: 0 };
  if (!config.configured) return { ok: false, status: "unconfigured", results: [], model: config.model, latencyMs: 0 };
  const safeDocuments = (documents || [])
    .filter((document) => document && document.id && String(document.text || "").trim())
    .slice(0, MAX_DOCUMENTS)
    .map((document) => ({
      id: String(document.id),
      text: String(document.text || "").slice(0, MAX_DOCUMENT_CHARS),
    }));
  if (!safeDocuments.length) return { ok: false, status: "empty", results: [], model: config.model, latencyMs: 0 };
  const topK = Math.max(1, Math.min(Number(options.topK) || safeDocuments.length, safeDocuments.length));
  const startedAt = Date.now();
  try {
    const payload = await fetchJson("/rerank", {
      method: "POST",
      timeoutMs: Number(options.timeoutMs || config.timeoutMs),
      body: { query: String(query || ""), documents: safeDocuments, topK },
    });
    const knownIds = new Set(safeDocuments.map((document) => document.id));
    const results = (payload?.results || [])
      .map((result, index) => ({
        id: String(result?.id || ""),
        index: Number.isFinite(Number(result?.index)) ? Number(result.index) : index,
        score: Number(result?.score),
      }))
      .filter((result) => knownIds.has(result.id) && Number.isFinite(result.score));
    if (!results.length) throw new Error("reranker returned no usable results");
    return {
      ok: true,
      status: "ready",
      model: payload?.model || config.model,
      latencyMs: Number(payload?.latencyMs) || Date.now() - startedAt,
      results,
    };
  } catch (error) {
    const reasonCode = rerankerFailureCode(error);
    return {
      ok: false,
      status: "fallback",
      reasonCode,
      model: config.model,
      latencyMs: Date.now() - startedAt,
      results: [],
      error: compactError(error),
    };
  }
}

export const RERANKER_MAX_DOCUMENTS = MAX_DOCUMENTS;
