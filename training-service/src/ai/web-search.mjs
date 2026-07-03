import { cleanReadableText, uniqueStrings } from "./text-utils.mjs";

const DEFAULT_PROVIDER = "tavily";
const DEFAULT_BASE_URL = "https://api.tavily.com";
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MARKETING_MAX_RESULTS = 8;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_SEARCH_DEPTH = "basic";
const DEFAULT_MARKETING_SEARCH_DEPTH = "basic";
const QUERY_LIMIT = 400;

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value, limit) {
  const text = compactWhitespace(value);
  return text.length > limit ? text.slice(0, limit).trim() : text;
}

function cleanUrl(value) {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return "";
  try {
    return new URL(text).toString();
  } catch {
    return "";
  }
}

function searchEndpoint(baseUrl) {
  const trimmed = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return /\/search$/i.test(trimmed) ? trimmed : `${trimmed}/search`;
}

function configuredSearchDepth(value, fallback = DEFAULT_SEARCH_DEPTH) {
  const normalized = String(value || fallback).trim().toLowerCase();
  return ["advanced", "basic"].includes(normalized) ? normalized : fallback;
}

function resolveWebSearchConfig({ purpose = "llm_reference" } = {}) {
  const isMarketingArticle = purpose === "marketing_article";
  return {
    provider: String(process.env.TRAINING_WEB_SEARCH_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase(),
    apiKey: process.env.TRAINING_WEB_SEARCH_API_KEY || process.env.TAVILY_API_KEY || "",
    baseUrl: process.env.TRAINING_WEB_SEARCH_BASE_URL || DEFAULT_BASE_URL,
    maxResults: isMarketingArticle
      ? clampNumber(process.env.TRAINING_MARKETING_WEB_SEARCH_MAX_RESULTS, DEFAULT_MARKETING_MAX_RESULTS, 1, 10)
      : clampNumber(process.env.TRAINING_WEB_SEARCH_MAX_RESULTS, DEFAULT_MAX_RESULTS, 1, 10),
    timeoutMs: clampNumber(process.env.TRAINING_WEB_SEARCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 60_000),
    searchDepth: isMarketingArticle
      ? configuredSearchDepth(process.env.TRAINING_MARKETING_WEB_SEARCH_SEARCH_DEPTH, DEFAULT_MARKETING_SEARCH_DEPTH)
      : configuredSearchDepth(process.env.TRAINING_WEB_SEARCH_SEARCH_DEPTH, DEFAULT_SEARCH_DEPTH),
  };
}

export function normalizeWebSearchMode(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "enabled"].includes(text) ? "on" : "off";
}

export function buildKnowledgeWebSearchQuery({ question, knowledgeBase } = {}) {
  const kbHints = uniqueStrings([
    knowledgeBase?.name,
    knowledgeBase?.description,
    ...(knowledgeBase?.aliases || []),
  ])
    .filter(Boolean)
    .join(" ");
  const query = clipText(`${question || ""} ${kbHints}`, QUERY_LIMIT);
  return query || clipText(question, QUERY_LIMIT);
}

export function buildLlmReferenceWebSearchQuery({ query, purpose, knowledgeBase } = {}) {
  const kbHints = uniqueStrings([
    knowledgeBase?.name,
    knowledgeBase?.description,
    ...(knowledgeBase?.aliases || []),
  ])
    .filter(Boolean)
    .join(" ");
  const purposeHint = String(purpose || "").replace(/[_:-]+/g, " ");
  const text = clipText(`${query || ""} ${kbHints} ${purposeHint}`, QUERY_LIMIT);
  return text || clipText(query, QUERY_LIMIT);
}

function normalizeTavilyResults(results = []) {
  const seen = new Set();
  const sources = [];
  for (const item of Array.isArray(results) ? results : []) {
    const url = cleanUrl(item?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = clipText(item?.title || url, 180);
    const preview = cleanReadableText(item?.content || item?.raw_content || "", 520);
    if (!title && !preview) continue;
    const index = sources.length + 1;
    sources.push({
      title,
      url,
      contentPreview: preview,
      sourceRef: `web:${index} ${title || url}`,
      score: Number(item?.score || 0) || 0,
      publishedDate: item?.published_date || item?.publishedDate || "",
      retrieval: "tavily",
    });
  }
  return sources;
}

export function normalizeWebSourceRefs(rawRefs, webSources = []) {
  const allowed = uniqueStrings((webSources || []).map((source) => source.sourceRef)).slice(0, 8);
  const requested = uniqueStrings(rawRefs);
  const matched = requested
    .map((ref) => allowed.find((allowedRef) => allowedRef === ref || allowedRef.includes(ref) || ref.includes(allowedRef)))
    .filter(Boolean);
  return matched.length ? uniqueStrings(matched).slice(0, 8) : allowed;
}

export function renderWebSearchContext(webSources = []) {
  return (webSources || [])
    .map((source) => [
      `[${source.sourceRef}]`,
      `Title: ${source.title || ""}`,
      `URL: ${source.url || ""}`,
      source.publishedDate ? `Published: ${source.publishedDate}` : "",
      `Summary: ${source.contentPreview || ""}`,
    ].filter(Boolean).join("\n"))
    .join("\n\n---\n\n");
}

export function webSearchResultFields(webSearch = {}, rawRefs = []) {
  const sources = Array.isArray(webSearch.sources) ? webSearch.sources : [];
  const refs = normalizeWebSourceRefs(rawRefs?.length ? rawRefs : webSearch.sourceRefs || [], sources);
  return {
    webSearchMode: webSearch.mode || "off",
    webSearchStatus: webSearch.status || "disabled",
    webSources: sources.filter((source) => refs.includes(source.sourceRef)),
    webSourceRefs: refs,
    warnings: uniqueStrings(webSearch.warnings || []),
  };
}

async function callTavilySearch({ query, config, signal }) {
  const response = await fetch(searchEndpoint(config.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: config.searchDepth,
      max_results: config.maxResults,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      topic: "general",
    }),
    signal,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
  }
  if (!response.ok) {
    const detail = payload?.error || payload?.detail || payload?.message || text || response.statusText;
    throw new Error(`Tavily search failed: ${detail}`);
  }
  return payload || {};
}

export async function searchWebForLlmReference({ query, webSearchMode, purpose = "llm_reference", knowledgeBase } = {}) {
  const mode = normalizeWebSearchMode(webSearchMode);
  if (mode !== "on") {
    return {
      mode,
      status: "disabled",
      query: "",
      sources: [],
      sourceRefs: [],
      warnings: [],
    };
  }

  const config = resolveWebSearchConfig({ purpose });
  if (config.provider !== "tavily") {
    return {
      mode,
      status: "unconfigured",
      query: "",
      sources: [],
      sourceRefs: [],
      warnings: [`unsupported_web_search_provider:${config.provider || "unknown"}`],
    };
  }
  if (!config.apiKey) {
    return {
      mode,
      status: "unconfigured",
      query: "",
      sources: [],
      sourceRefs: [],
      warnings: ["web_search_unconfigured"],
    };
  }

  const searchQuery = buildLlmReferenceWebSearchQuery({ query, purpose, knowledgeBase });
  if (!searchQuery) {
    return {
      mode,
      status: "empty",
      query: "",
      sources: [],
      sourceRefs: [],
      warnings: ["web_search_empty_query"],
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const payload = await callTavilySearch({ query: searchQuery, config, signal: controller.signal });
    const sources = normalizeTavilyResults(payload.results);
    const sourceRefs = normalizeWebSourceRefs([], sources);
    return {
      mode,
      status: sources.length ? "ok" : "empty",
      provider: "tavily",
      query: searchQuery,
      sources,
      sourceRefs,
      warnings: sources.length ? [] : ["web_search_empty"],
      responseTimeMs: Date.now() - startedAt,
      requestId: payload.request_id || payload.requestId || "",
      usage: payload.usage || null,
    };
  } catch (error) {
    return {
      mode,
      status: "failed",
      provider: "tavily",
      query: searchQuery,
      sources: [],
      sourceRefs: [],
      warnings: ["web_search_failed"],
      error: error instanceof Error ? error.message : String(error),
      responseTimeMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchWebForKnowledgeAnswer({ question, knowledgeBase, webSearchMode } = {}) {
  return await searchWebForLlmReference({
    query: buildKnowledgeWebSearchQuery({ question, knowledgeBase }),
    knowledgeBase,
    webSearchMode,
    purpose: "knowledge_answer",
  });
}
