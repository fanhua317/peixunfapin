import { createEmbeddingClient } from "./embedding.mjs";
import { loadLocalVectorIndex, searchLocalVectorIndex } from "./local-vector-index.mjs";
import { buildKbFilter, createQdrantClient, QDRANT_DEFAULT_COLLECTION } from "./qdrant.mjs";
import { isUsableTrainingChunk } from "./quality.mjs";

const CJK_RE = /[\u3400-\u9fff]/g;

const HYBRID_ENABLED = !["0", "false", "off", "no"].includes(String(process.env.TRAINING_HYBRID_RETRIEVAL || "").toLowerCase());
const SEMANTIC_WEIGHT = Number(process.env.TRAINING_SEMANTIC_WEIGHT || 0.55);
const BM25_WEIGHT = Number(process.env.TRAINING_BM25_WEIGHT || process.env.TRAINING_KEYWORD_WEIGHT || 0.45);
const BM25_K1 = Number(process.env.TRAINING_BM25_K1 || 1.2);
const BM25_B = Number(process.env.TRAINING_BM25_B || 0.75);
const HYBRID_MATCH_BOOST = Number(process.env.TRAINING_HYBRID_MATCH_BOOST || 0.08);
const PARAMETER_QUERY_RE = /(参数|范围|功率|机座|级数|能效|型号|尺寸|电压|电流|效率|YE\d|IE\d|Y2|kw|kW|pole|poles)/i;
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
  const latin = text.match(/[a-z0-9][a-z0-9._+/#:-]*/g) || [];
  const cjk = text.match(CJK_RE) || [];
  const cjkBigrams = [];
  for (let index = 0; index < cjk.length - 1; index += 1) {
    cjkBigrams.push(`${cjk[index]}${cjk[index + 1]}`);
  }
  return [...latin, ...cjk, ...cjkBigrams].filter(Boolean);
}

function chunkSearchText(chunk) {
  const businessKeys = chunk?.businessKeys && typeof chunk.businessKeys === "object"
    ? Object.values(chunk.businessKeys).flat().join(" ")
    : "";
  return `${chunk?.searchText || ""} ${chunk?.content || ""} ${chunk?.sourceRef || ""} ${chunk?.heading || ""} ${businessKeys}`;
}

function tokenCounts(tokens) {
  const counts = new Map();
  for (const token of tokens || []) {
    if (!token) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function buildBm25Corpus(state, knowledgeBaseId) {
  const chunks = state.chunks
    .filter((chunk) => !knowledgeBaseId || chunk.knowledgeBaseId === knowledgeBaseId)
    .filter(isUsableTrainingChunk);
  const entries = chunks.map((chunk) => {
    const tokens = tokenize(chunkSearchText(chunk));
    return {
      chunk,
      tokens,
      length: Math.max(tokens.length, 1),
      frequencies: tokenCounts(tokens),
    };
  });
  const documentFrequency = new Map();
  for (const entry of entries) {
    for (const token of new Set(entry.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const averageLength = entries.length
    ? entries.reduce((sum, entry) => sum + entry.length, 0) / entries.length
    : 1;
  return { entries, documentFrequency, averageLength, size: entries.length };
}

function bm25Score(queryTokens, entry, corpus) {
  if (!queryTokens.length || !corpus.size) return 0;
  let score = 0;
  const uniqueQueryTokens = new Set(queryTokens);
  for (const token of uniqueQueryTokens) {
    const tf = entry.frequencies.get(token) || 0;
    if (!tf) continue;
    const df = corpus.documentFrequency.get(token) || 0;
    const idf = Math.log(1 + (corpus.size - df + 0.5) / (df + 0.5));
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (entry.length / corpus.averageLength));
    score += idf * ((tf * (BM25_K1 + 1)) / denominator);
  }
  return score;
}

function searchBm25ChildChunks(state, { knowledgeBaseId, query, limit = 5 }) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 50));
  const queryTokens = tokenize(query);
  const corpus = buildBm25Corpus(state, knowledgeBaseId);
  if (!queryTokens.length) {
    return corpus.entries.slice(0, safeLimit).map((entry) => ({
      ...entry.chunk,
      score: 0,
      bm25Score: 0,
      keywordScore: 0,
      retrieval: "bm25",
    }));
  }
  return corpus.entries
    .map((entry) => {
      const score = bm25Score(queryTokens, entry, corpus);
      return {
        ...entry.chunk,
        score,
        bm25Score: score,
        keywordScore: score,
        retrieval: "bm25",
      };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, safeLimit);
}

function parentById(state) {
  return new Map((state.chunkParents || []).filter(Boolean).map((parent) => [String(parent.id), parent]));
}

function matchedPreview(chunk, maxLength = 220) {
  const text = String(chunk?.content || chunk?.searchText || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function mergeRetrieval(left, right) {
  const values = new Set(String(left || "").split("+").filter(Boolean));
  for (const item of String(right || "").split("+").filter(Boolean)) values.add(item);
  return [...values].join("+") || left || right || "bm25";
}

function parentContextForHit(parentMap, hit) {
  const parent = hit?.parentId ? parentMap.get(String(hit.parentId)) : null;
  if (!parent) {
    return {
      ...hit,
      parentId: hit?.parentId || null,
      matchedChunkId: hit?.id || hit?.chunkId || null,
      matchedPreview: matchedPreview(hit),
      matchedChunks: [{
        chunkId: hit?.id || hit?.chunkId || null,
        sourceRef: hit?.sourceRef || "",
        childType: hit?.childType || "",
        preview: matchedPreview(hit),
        score: hit?.score || 0,
        bm25Score: hit?.bm25Score || hit?.keywordScore || 0,
        semanticScore: hit?.semanticScore || 0,
      }],
    };
  }
  const matchedChunkId = hit.id || hit.chunkId || null;
  return {
    ...parent,
    id: parent.id,
    chunkId: matchedChunkId,
    parentId: parent.id,
    matchedChunkId,
    matchedPreview: matchedPreview(hit),
    matchedChunks: [{
      chunkId: matchedChunkId,
      sourceRef: hit.sourceRef || parent.sourceRef || "",
      childType: hit.childType || "",
      preview: matchedPreview(hit),
      score: hit.score || 0,
      bm25Score: hit.bm25Score || hit.keywordScore || 0,
      semanticScore: hit.semanticScore || 0,
    }],
    score: hit.score || 0,
    bm25Score: hit.bm25Score || hit.keywordScore || 0,
    bm25Normalized: hit.bm25Normalized || hit.keywordNormalized || 0,
    keywordScore: hit.keywordScore || 0,
    keywordNormalized: hit.keywordNormalized || 0,
    semanticScore: hit.semanticScore || 0,
    semanticNormalized: hit.semanticNormalized || 0,
    retrieval: hit.retrieval || "bm25",
    childType: hit.childType || "",
    searchText: `${hit.searchText || ""}\n\n${parent.content || ""}`.trim(),
    businessKeys: { ...(parent.businessKeys || {}), ...(hit.businessKeys || {}) },
  };
}

function expandParentMatches(state, matches, limit) {
  const parentMap = parentById(state);
  const merged = new Map();
  for (const hit of matches || []) {
    if (!hit) continue;
    const context = parentContextForHit(parentMap, hit);
    const key = String(context.parentId || context.id || context.matchedChunkId || "");
    if (!key) continue;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, context);
      continue;
    }
    const existingScore = Number(existing.score || 0);
    const nextScore = Number(context.score || 0);
    const base = nextScore > existingScore ? context : existing;
    const other = nextScore > existingScore ? existing : context;
    merged.set(key, {
      ...base,
      score: Math.max(existingScore, nextScore),
      bm25Score: Math.max(Number(existing.bm25Score || existing.keywordScore || 0), Number(context.bm25Score || context.keywordScore || 0)),
      bm25Normalized: Math.max(Number(existing.bm25Normalized || existing.keywordNormalized || 0), Number(context.bm25Normalized || context.keywordNormalized || 0)),
      keywordScore: Math.max(Number(existing.keywordScore || 0), Number(context.keywordScore || 0)),
      keywordNormalized: Math.max(Number(existing.keywordNormalized || 0), Number(context.keywordNormalized || 0)),
      semanticScore: Math.max(Number(existing.semanticScore || 0), Number(context.semanticScore || 0)),
      semanticNormalized: Math.max(Number(existing.semanticNormalized || 0), Number(context.semanticNormalized || 0)),
      retrieval: mergeRetrieval(existing.retrieval, context.retrieval),
      matchedChunks: [...(base.matchedChunks || []), ...(other.matchedChunks || [])]
        .filter((item, index, array) => item.chunkId && array.findIndex((entry) => entry.chunkId === item.chunkId) === index)
        .slice(0, 5),
      matchedPreview: base.matchedPreview || other.matchedPreview || "",
    });
  }
  return [...merged.values()]
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)));
}

export function searchChunks(state, { knowledgeBaseId, query, limit = 5 }) {
  return expandParentMatches(state, searchBm25ChildChunks(state, { knowledgeBaseId, query, limit }), limit);
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

function queryWeights(query) {
  if (PARAMETER_QUERY_RE.test(String(query || ""))) {
    return { semantic: 0.25, bm25: 0.75 };
  }
  const total = Math.max(SEMANTIC_WEIGHT + BM25_WEIGHT, 0.01);
  return { semantic: SEMANTIC_WEIGHT / total, bm25: BM25_WEIGHT / total };
}

function cjkPoleNumber(value) {
  const text = String(value || "");
  const digit = text.match(/(\d+)\s*级/);
  if (digit) return digit[1];
  const mapped = new Map([
    ["二", "2"],
    ["两", "2"],
    ["三", "3"],
    ["四", "4"],
    ["五", "5"],
    ["六", "6"],
    ["七", "7"],
    ["八", "8"],
  ]);
  const match = text.match(/([二两三四五六七八])\s*级/);
  return match ? mapped.get(match[1]) : "";
}

function exactParameterBoost(query, chunk) {
  if (!PARAMETER_QUERY_RE.test(String(query || ""))) return 0;
  const text = normalizeText(chunkSearchText(chunk));
  const modelTokens = [...new Set((String(query || "").match(/\b(?:Y2|YE\d|IE\d)[A-Z0-9-]*/gi) || []).map((token) => token.toLowerCase()))];
  let boost = 0;
  for (const token of modelTokens) {
    if (text.includes(token)) boost += 0.25;
  }
  const pole = cjkPoleNumber(query);
  if (pole && (text.includes(`级数: ${pole}`) || text.includes(`级数：${pole}`) || text.includes(`${pole}级`))) boost += 0.25;
  if (/(机座范围|功率范围|output power|motor model)/i.test(text)) boost += 0.25;
  if (/电机数据汇总|sheet1/.test(text)) boost += 0.15;
  return Math.min(boost, 0.8);
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
      parentId: payload.parentId || localChunk?.parentId || null,
      knowledgeBaseId: payload.knowledgeBaseId || localChunk?.knowledgeBaseId || null,
      content: localChunk?.content || payload.content || "",
      searchText: localChunk?.searchText || payload.searchText || "",
      sourceRef: payload.sourceRef || localChunk?.sourceRef || "",
      heading: payload.heading || localChunk?.heading || "",
      sectionPath: payload.sectionPath || localChunk?.sectionPath || [],
      page: payload.page ?? localChunk?.page ?? null,
      childType: payload.childType || localChunk?.childType || "",
      businessKeys: payload.businessKeys || localChunk?.businessKeys || {},
      semanticScore: typeof point.score === "number" ? point.score : 0,
      retrieval: "semantic",
    };
    if (isUsableTrainingChunk(match)) matches.push(match);
  }
  return matches;
}

export async function searchKnowledgeContexts(state, { knowledgeBaseId, query, limit = 8 }) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 20));
  const candidateLimit = Math.max(safeLimit, Math.min(50, safeLimit * 4));
  const bm25Matches = searchBm25ChildChunks(state, { knowledgeBaseId, query, limit: candidateLimit });
  const semanticMatches = HYBRID_ENABLED ? await semanticSearch(state, { knowledgeBaseId, query, limit: candidateLimit }) : [];
  const configuredWeights = queryWeights(query);
  const weights = semanticMatches.length
    ? configuredWeights
    : { bm25: 1, semantic: 0 };
  const merged = new Map();
  const bm25Range = normalizeRange(bm25Matches.map((chunk) => chunk.bm25Score || chunk.score || 0));
  for (const chunk of bm25Matches) {
    if (!chunk.id) continue;
    const bm25ScoreValue = chunk.bm25Score || chunk.score || 0;
    merged.set(chunk.id, {
      ...chunk,
      bm25Score: bm25ScoreValue,
      bm25Normalized: normalizeScore(bm25ScoreValue, bm25Range),
      keywordScore: bm25ScoreValue,
      keywordNormalized: normalizeScore(bm25ScoreValue, bm25Range),
      semanticScore: 0,
      semanticNormalized: 0,
      retrieval: "bm25",
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
      bm25Score: 0,
      bm25Normalized: 0,
      keywordScore: 0,
      keywordNormalized: 0,
    };
    const semanticNormalized = normalizeScore(match.semanticScore || 0, semanticRange);
    merged.set(id, {
      ...base,
      chunkId: id,
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
      score: weights.semantic * (chunk.semanticNormalized || 0)
        + weights.bm25 * (chunk.bm25Normalized || chunk.keywordNormalized || 0)
        + (chunk.retrieval === "hybrid" ? HYBRID_MATCH_BOOST : 0)
        + exactParameterBoost(query, chunk),
    }))
    .sort((left, right) => right.score - left.score);
  return expandParentMatches(state, ranked.slice(0, safeLimit * 2), safeLimit);
}

export async function searchChunksHybrid(state, { knowledgeBaseId, query, limit = 8 }) {
  return searchKnowledgeContexts(state, { knowledgeBaseId, query, limit });
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
