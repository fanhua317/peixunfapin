import { createEmbeddingClient } from "./embedding.mjs";
import { loadLocalVectorIndex, searchLocalVectorIndex } from "./local-vector-index.mjs";
import { buildKbFilter, createQdrantClient, QDRANT_DEFAULT_COLLECTION } from "./qdrant.mjs";
import { isUsableTrainingChunk } from "./quality.mjs";

const CJK_RE = /[\u3400-\u9fff]/g;

const HYBRID_ENABLED = !["0", "false", "off", "no"].includes(String(process.env.TRAINING_HYBRID_RETRIEVAL || "").toLowerCase());
const SEMANTIC_WEIGHT = Number(process.env.TRAINING_SEMANTIC_WEIGHT || 0.7);
const KEYWORD_WEIGHT = Number(process.env.TRAINING_KEYWORD_WEIGHT || 0.3);
const HYBRID_COLLECTION = process.env.QDRANT_COLLECTION || QDRANT_DEFAULT_COLLECTION;
const SEMANTIC_RETRY_MS = Number(process.env.TRAINING_SEMANTIC_RETRY_MS || 60_000);
const SEMANTIC_BACKEND = String(process.env.TRAINING_VECTOR_BACKEND || process.env.TRAINING_SEMANTIC_BACKEND || "auto").toLowerCase();

let cachedQdrant = null;
let cachedEmbedding = null;
let qdrantHealthy = HYBRID_ENABLED;
let cachedLocalIndex = null;
let cachedLocalIndexPath = "";
let lastSemanticFailureAt = 0;

function getQdrant() {
  if (!cachedQdrant) cachedQdrant = createQdrantClient();
  return cachedQdrant;
}

function getEmbedding() {
  if (!cachedEmbedding) {
    cachedEmbedding = createEmbeddingClient({
      timeoutMs: Number(process.env.TRAINING_RAG_EMBEDDING_TIMEOUT_MS || process.env.EMBEDDING_QUERY_TIMEOUT_MS || 8_000),
      batchSize: 1,
    });
  }
  return cachedEmbedding;
}

function backendEnabled(name) {
  if (!SEMANTIC_BACKEND || SEMANTIC_BACKEND === "auto") return true;
  return SEMANTIC_BACKEND.split(/[,;|]/).map((part) => part.trim()).includes(name);
}

function canTrySemanticSearch() {
  if (!HYBRID_ENABLED) return false;
  if (backendEnabled("local")) return true;
  if (qdrantHealthy) return true;
  return Date.now() - lastSemanticFailureAt > SEMANTIC_RETRY_MS;
}

function markSemanticFailure() {
  qdrantHealthy = false;
  lastSemanticFailureAt = Date.now();
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(value) {
  const text = normalizeText(value);
  const latin = text.match(/[a-z0-9]+/g) || [];
  const cjk = text.match(CJK_RE) || [];
  const cjkBigrams = [];
  for (let index = 0; index < cjk.length - 1; index += 1) {
    cjkBigrams.push(`${cjk[index]}${cjk[index + 1]}`);
  }
  return [...latin, ...cjk, ...cjkBigrams].filter(Boolean);
}

function scoreChunk(queryTokens, chunk) {
  const haystack = normalizeText(`${chunk.content} ${chunk.sourceRef || ""}`);
  let score = 0;
  for (const token of queryTokens) {
    if (!token) continue;
    if (haystack.includes(token)) {
      score += token.length > 1 ? 2 : 1;
    }
  }
  return score;
}

export function searchChunks(state, { knowledgeBaseId, query, limit = 5 }) {
  const queryTokens = tokenize(query);
  const chunks = state.chunks
    .filter((chunk) => !knowledgeBaseId || chunk.knowledgeBaseId === knowledgeBaseId)
    .filter(isUsableTrainingChunk)
    .map((chunk) => ({
      ...chunk,
      score: scoreChunk(queryTokens, chunk),
      keywordScore: scoreChunk(queryTokens, chunk),
      retrieval: "keyword",
    }))
    .filter((chunk) => chunk.score > 0 || !queryTokens.length)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)));

  return chunks;
}

function normalizeRange(values) {
  if (!values.length) return { min: 0, max: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { min, max };
}

function normalizeScore(value, range) {
  if (range.max === range.min) return value > 0 ? 1 : 0;
  return (value - range.min) / (range.max - range.min);
}

function chunkLookupBy(state, key) {
  const map = new Map();
  for (const chunk of state.chunks || []) {
    if (chunk && chunk[key]) map.set(String(chunk[key]), chunk);
  }
  return map;
}

async function semanticSearch(state, { knowledgeBaseId, query, limit }) {
  if (!canTrySemanticSearch()) return [];
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];
  const embedding = getEmbedding();
  let vector;
  try {
    vector = await embedding.embedOne(trimmed);
  } catch (error) {
    markSemanticFailure();
    return [];
  }
  if (!Array.isArray(vector)) {
    return [];
  }

  if (backendEnabled("local")) {
    try {
      const indexPath = process.env.TRAINING_LOCAL_VECTOR_INDEX_PATH || process.env.TRAINING_VECTOR_INDEX_PATH || "";
      if (!cachedLocalIndex || cachedLocalIndexPath !== indexPath) {
        cachedLocalIndex = await loadLocalVectorIndex();
        cachedLocalIndexPath = indexPath;
      }
      const localMatches = searchLocalVectorIndex(state, cachedLocalIndex, { knowledgeBaseId, vector, limit });
      if (localMatches.length) return localMatches;
    } catch {
      cachedLocalIndex = null;
      cachedLocalIndexPath = "";
    }
  }

  if (!backendEnabled("qdrant")) return [];

  const qdrant = getQdrant();
  let raw;
  try {
    raw = await qdrant.search({
      collection: HYBRID_COLLECTION,
      vector,
      limit: Math.max(limit, 5),
      filter: buildKbFilter(knowledgeBaseId),
    });
  } catch (error) {
    markSemanticFailure();
    return [];
  }
  qdrantHealthy = true;
  const byChunkId = chunkLookupBy(state, "id");
  const byContentHash = chunkLookupBy(state, "contentHash");
  const matches = [];
  for (const point of raw || []) {
    const payload = point?.payload || {};
    const localChunk = byChunkId.get(String(payload.chunkId || ""))
      || byContentHash.get(String(payload.contentHash || ""))
      || null;
    const match = {
      chunkId: payload.chunkId || (localChunk ? localChunk.id : null),
      id: payload.chunkId || (localChunk ? localChunk.id : null),
      documentId: payload.documentId || localChunk?.documentId || null,
      knowledgeBaseId: payload.knowledgeBaseId || localChunk?.knowledgeBaseId || null,
      content: localChunk?.content || payload.content || "",
      sourceRef: payload.sourceRef || localChunk?.sourceRef || "",
      heading: payload.heading || localChunk?.heading || "",
      sectionPath: payload.sectionPath || localChunk?.sectionPath || [],
      page: payload.page ?? localChunk?.page ?? null,
      semanticScore: typeof point.score === "number" ? point.score : 0,
      retrieval: "semantic",
    };
    if (isUsableTrainingChunk(match)) matches.push(match);
  }
  return matches;
}

export async function searchChunksHybrid(state, { knowledgeBaseId, query, limit = 8 }) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 20));
  const keywordMatches = searchChunks(state, { knowledgeBaseId, query, limit: safeLimit });
  const semanticMatches = HYBRID_ENABLED ? await semanticSearch(state, { knowledgeBaseId, query, limit: safeLimit }) : [];
  const merged = new Map();
  const keywordRange = normalizeRange(keywordMatches.map((chunk) => chunk.score || 0));
  for (const chunk of keywordMatches) {
    if (!chunk.id) continue;
    merged.set(chunk.id, {
      ...chunk,
      keywordScore: chunk.score || 0,
      keywordNormalized: normalizeScore(chunk.score || 0, keywordRange),
      semanticScore: 0,
      semanticNormalized: 0,
      retrieval: "keyword",
    });
  }
  const semanticRange = normalizeRange(semanticMatches.map((match) => match.semanticScore || 0));
  for (const match of semanticMatches) {
    const id = match.chunkId;
    if (!id) continue;
    const existing = merged.get(id);
    const localChunk = state.chunks.find((chunk) => chunk.id === id);
    const base = existing || {
      ...(localChunk || {}),
      id,
      knowledgeBaseId: match.knowledgeBaseId,
      documentId: match.documentId,
      content: localChunk?.content || match.content,
      sourceRef: match.sourceRef,
      heading: match.heading,
      sectionPath: match.sectionPath,
      page: match.page,
      keywordScore: 0,
      keywordNormalized: 0,
    };
    const semanticNormalized = normalizeScore(match.semanticScore || 0, semanticRange);
    merged.set(id, {
      ...base,
      semanticScore: match.semanticScore || 0,
      semanticNormalized,
      retrieval: existing ? "hybrid" : "semantic",
    });
  }
  const ranked = [...merged.values()]
    .filter((chunk) => chunk.content)
    .filter(isUsableTrainingChunk)
    .map((chunk) => ({
      ...chunk,
      score: SEMANTIC_WEIGHT * (chunk.semanticNormalized || 0) + KEYWORD_WEIGHT * (chunk.keywordNormalized || 0),
    }))
    .sort((left, right) => right.score - left.score);
  return ranked.slice(0, safeLimit);
}

export function isHybridSearchEnabled() {
  return HYBRID_ENABLED && qdrantHealthy;
}

export function buildAnswer(state, { knowledgeBaseId, question }) {
  const matches = searchChunks(state, { knowledgeBaseId, query: question, limit: 4 });
  if (!matches.length) {
    return {
      answer: "当前知识库中没有找到足够相关的资料。建议补充或检查清洗后的资料内容。",
      sources: [],
      confidence: "low",
    };
  }

  const sourceLines = matches.map((match, index) => `${index + 1}. ${match.sourceRef}: ${match.content}`);
  return {
    answer: `根据当前培训资料，建议这样回答：\n\n${matches[0].content}\n\n可参考来源：\n${sourceLines.join("\n")}`,
    sources: matches.map((match) => ({
      chunkId: match.id,
      documentId: match.documentId,
      sourceRef: match.sourceRef,
      score: match.score,
    })),
    confidence: matches[0].score >= 4 ? "medium" : "low",
  };
}

export function summarizeKnowledgeBase(state, knowledgeBaseId) {
  const chunks = state.chunks.filter((chunk) => chunk.knowledgeBaseId === knowledgeBaseId).filter(isUsableTrainingChunk);
  const summary = chunks
    .slice(0, 3)
    .map((chunk) => `- ${chunk.content}`)
    .join("\n");
  return summary || "该知识库暂无可用内容。";
}
