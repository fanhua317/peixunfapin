import { createHash } from "node:crypto";
import { createEmbeddingClient } from "./embedding.mjs";
import { loadLocalVectorIndex, searchLocalVectorIndex } from "./local-vector-index.mjs";
import { buildKbFilter, createQdrantClient, QDRANT_DEFAULT_COLLECTION } from "./qdrant.mjs";
import { isUsableTrainingChunk } from "./quality.mjs";
import { getRerankerRuntimeConfig, rerankDocuments } from "./reranker.mjs";
import { recordRetrievalObservation } from "./observability/context.mjs";

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
const MIN_EVIDENCE_LEXICAL_COVERAGE = Number(process.env.TRAINING_RAG_MIN_LEXICAL_COVERAGE || 0.16);
const MIN_EVIDENCE_BM25_SCORE = Number(process.env.TRAINING_RAG_MIN_BM25_SCORE || 1.5);
const MIN_EVIDENCE_SEMANTIC_SCORE = Number(process.env.TRAINING_RAG_MIN_SEMANTIC_SCORE || 0.42);
const MIN_EVIDENCE_SEMANTIC_ONLY_SCORE = Number(process.env.TRAINING_RAG_MIN_SEMANTIC_ONLY_SCORE || 0.54);
const MIN_EVIDENCE_RERANKER_SCORE = Number(process.env.TRAINING_RAG_MIN_RERANKER_SCORE || 0.45);
const BM25_CACHE_MAX_ENTRIES = boundedInteger(process.env.TRAINING_BM25_CACHE_MAX_ENTRIES, 4, 32);
const BM25_CACHE_MAX_CHUNKS = boundedInteger(process.env.TRAINING_BM25_CACHE_MAX_CHUNKS, 30_000, 250_000);
// This limit tracks retained per-document term slots, not the transient raw
// token stream used while building the corpus. The latter is discarded after
// frequencies/postings are built, so using it as the cache weight caused large
// but safe corpora to be rebuilt on every request.
const BM25_CACHE_MAX_TOKENS = boundedInteger(process.env.TRAINING_BM25_CACHE_MAX_TOKENS, 10_000_000, 50_000_000);
const SECRET_VALUE_QUERY_RE = /(?:(?:密码|口令|私钥|访问密钥|api\s*key|access\s*key|secret|password|private\s*key|token).{0,16}(?:是什么|是多少|给出|告诉|发我|显示|泄露|what\s+is|show|give|reveal)|(?:给出|告诉|发我|显示|泄露|show|give|reveal).{0,16}(?:密码|口令|私钥|访问密钥|api\s*key|access\s*key|secret|password|private\s*key|token))/i;
const EVIDENCE_STOP_BIGRAMS = new Set([
  "什么", "多少", "如何", "怎么", "是否", "哪些", "哪个", "哪种", "一下", "请问", "给出", "具体", "准确", "最新", "实时",
  "这个", "那个", "可以", "需要", "必须", "使用", "相关", "资料", "问题", "回答", "说明", "今天", "明天", "下周",
]);
const EVIDENCE_STOP_CJK_CHARS = new Set(["的", "了", "和", "是", "有", "在", "与", "及", "或", "把", "被", "为", "到", "等"]);

let cachedQdrant = null;
let cachedEmbedding = null;
let qdrantHealthy = HYBRID_ENABLED;
let cachedLocalIndex = null;
let cachedLocalIndexPath = "";
let lastSemanticFailureAt = 0;
let bm25StateSnapshots = new WeakMap();
const bm25CorpusCache = new Map();
const bm25CacheCounters = {
  hits: 0,
  misses: 0,
  builds: 0,
  invalidations: 0,
  evictions: 0,
  bypasses: 0,
};
let bm25CachedChunks = 0;
let bm25CachedTokens = 0;
let bm25MutationEpoch = 0;

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(Math.floor(parsed), maximum));
}

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

function cjkRuns(value) {
  return normalizeText(value).match(/[\u3400-\u9fff]+/g) || [];
}

function cjkBigrams(value) {
  const bigrams = [];
  for (const run of cjkRuns(value)) {
    const characters = [...run];
    for (let index = 0; index < characters.length - 1; index += 1) {
      bigrams.push(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return bigrams;
}

function meaningfulEvidenceTerms(value) {
  const text = normalizeText(value);
  const latin = (text.match(/[a-z0-9][a-z0-9._+/#:-]*/g) || [])
    .filter((token) => token.length >= 3 && !/^(?:what|which|when|where|find|the|and|for|with|from|into|about)$/.test(token));
  const bigrams = cjkBigrams(text).filter((term) => (
    !EVIDENCE_STOP_BIGRAMS.has(term)
    && ![...term].some((character) => EVIDENCE_STOP_CJK_CHARS.has(character))
  ));
  return [...new Set([...latin, ...bigrams])];
}

function definitionEvidenceTerms(value) {
  const text = normalizeText(value);
  const patterns = [
    /(?:讲一下|介绍一下|解释一下)\s*([^，。！？?]{1,24}?)(?:是什么|是啥|[！？?]|$)/i,
    /什么是\s*([^，。！？?]{1,24})/i,
    /^(?:请问\s*)?([^，。！？?\s]{1,8})(?:是什么|是啥)[！？?]?$/i,
    /^what\s+is\s+(.{1,40}?)[?!.]?$/i,
    /^define\s+(.{1,40}?)[?!.]?$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return meaningfulEvidenceTerms(match[1]);
  }
  return [];
}

function evidenceIdentifiers(value) {
  return [...new Set((String(value || "").match(/\b(?=[a-z0-9._+/#:-]*[a-z])(?=[a-z0-9._+/#:-]*\d)[a-z0-9][a-z0-9._+/#:-]{1,}\b/gi) || []).map((token) => token.toLowerCase()))];
}

function businessKeyValues(chunk, names) {
  const keys = chunk?.businessKeys && typeof chunk.businessKeys === "object" ? chunk.businessKeys : {};
  return names.flatMap((name) => {
    const value = keys[name];
    if (Array.isArray(value)) return value;
    return value === undefined || value === null ? [] : [value];
  }).map(normalizeText).filter(Boolean);
}

function exactIdentifierBm25Boost(query, chunk) {
  const identifiers = evidenceIdentifiers(query);
  if (!identifiers.length) return 0;
  const modelValues = businessKeyValues(chunk, ["model", "models", "series"]);
  const heading = normalizeText(`${chunk?.heading || ""}\n${chunk?.sourceRef || ""}`);
  const text = normalizeText(chunkSearchText(chunk));
  let boost = 0;
  for (const identifier of identifiers) {
    const exactBusinessKey = modelValues.some((value) => tokenize(value).includes(identifier));
    if (exactBusinessKey) {
      boost += 100;
      continue;
    }
    if (tokenize(heading).includes(identifier)) {
      boost += 45;
      continue;
    }
    if (tokenize(text).includes(identifier)) boost += 12;
  }
  return boost;
}

export function assessEvidenceSufficiency(contexts, query) {
  if (SECRET_VALUE_QUERY_RE.test(String(query || ""))) {
    return {
      sufficient: false,
      reason: "secret_value_request",
      queryTermCount: meaningfulEvidenceTerms(query).length,
      identifierCount: evidenceIdentifiers(query).length,
      best: null,
      rows: [],
      thresholds: {
        lexicalCoverage: MIN_EVIDENCE_LEXICAL_COVERAGE,
        bm25Score: MIN_EVIDENCE_BM25_SCORE,
        semanticScore: MIN_EVIDENCE_SEMANTIC_SCORE,
        rerankerScore: MIN_EVIDENCE_RERANKER_SCORE,
      },
    };
  }
  const candidates = (contexts || []).slice(0, 3);
  const queryTerms = meaningfulEvidenceTerms(query);
  const identifiers = evidenceIdentifiers(query);
  const definitionTerms = definitionEvidenceTerms(query);
  const rows = candidates.map((context) => {
    const text = normalizeText(`${context?.sourceRef || ""}\n${context?.heading || ""}\n${context?.matchedPreview || ""}\n${context?.content || ""}`);
    const matchedTerms = queryTerms.filter((term) => text.includes(term));
    const matchedIdentifiers = identifiers.filter((identifier) => text.includes(identifier));
    const lexicalCoverage = queryTerms.length ? matchedTerms.length / queryTerms.length : 0;
    const bm25ScoreValue = Number(context?.bm25Score || context?.keywordScore || 0);
    const exactIdentifierBoostValue = Number(context?.exactIdentifierBoost || 0);
    const semanticScoreValue = Number(context?.semanticScore || 0);
    const rerankerScoreValue = Number(context?.rerankerScore);
    const identifierRequired = identifiers.length > 0;
    const identifierSatisfied = !identifierRequired || matchedIdentifiers.length > 0;
    const rankSignal = bm25ScoreValue >= MIN_EVIDENCE_BM25_SCORE
      || semanticScoreValue >= MIN_EVIDENCE_SEMANTIC_SCORE
      || (Number.isFinite(rerankerScoreValue) && rerankerScoreValue >= MIN_EVIDENCE_RERANKER_SCORE)
      || exactIdentifierBoostValue > 0;
    const lexicalSignal = matchedTerms.length >= 2 && lexicalCoverage >= MIN_EVIDENCE_LEXICAL_COVERAGE;
    const semanticOnlySignal = !identifierRequired && semanticScoreValue >= MIN_EVIDENCE_SEMANTIC_ONLY_SCORE;
    const singleExactSignal = queryTerms.length === 1 && matchedTerms.length === 1 && bm25ScoreValue >= MIN_EVIDENCE_BM25_SCORE * 2;
    const definitionSignal = !identifierRequired
      && definitionTerms.some((term) => matchedTerms.includes(term))
      && bm25ScoreValue >= MIN_EVIDENCE_BM25_SCORE * 2;
    const sufficient = identifierSatisfied && (lexicalSignal || semanticOnlySignal || singleExactSignal || definitionSignal || (matchedIdentifiers.length > 0 && rankSignal));
    return {
      id: context?.parentId || context?.id || context?.matchedChunkId || "",
      sufficient,
      lexicalCoverage: Number(lexicalCoverage.toFixed(4)),
      matchedTermCount: matchedTerms.length,
      queryTermCount: queryTerms.length,
      matchedIdentifierCount: matchedIdentifiers.length,
      identifierCount: identifiers.length,
      bm25Score: bm25ScoreValue,
      exactIdentifierBoost: exactIdentifierBoostValue,
      semanticScore: semanticScoreValue,
      rerankerScore: Number.isFinite(rerankerScoreValue) ? rerankerScoreValue : null,
    };
  });
  const best = [...rows].sort((left, right) => {
    if (left.sufficient !== right.sufficient) return left.sufficient ? -1 : 1;
    return right.lexicalCoverage - left.lexicalCoverage;
  })[0] || null;
  return {
    sufficient: rows.some((row) => row.sufficient),
    queryTermCount: queryTerms.length,
    identifierCount: identifiers.length,
    best,
    rows,
    thresholds: {
      lexicalCoverage: MIN_EVIDENCE_LEXICAL_COVERAGE,
      bm25Score: MIN_EVIDENCE_BM25_SCORE,
      semanticScore: MIN_EVIDENCE_SEMANTIC_SCORE,
      semanticOnlyScore: MIN_EVIDENCE_SEMANTIC_ONLY_SCORE,
      rerankerScore: MIN_EVIDENCE_RERANKER_SCORE,
    },
  };
}

export function hasExactIdentifierEvidence(contexts, query) {
  const identifiers = evidenceIdentifiers(query);
  if (!identifiers.length) return false;
  return (contexts || []).some((context) => {
    const matchedChunks = (context?.matchedChunks || [])
      .map((item) => `${item?.sourceRef || ""}\n${item?.preview || ""}`)
      .join("\n");
    const text = normalizeText([
      context?.sourceRef,
      context?.heading,
      context?.matchedPreview,
      context?.content,
      context?.searchText,
      Object.values(context?.businessKeys || {}).flat().join(" "),
      matchedChunks,
    ].filter(Boolean).join("\n"));
    return identifiers.every((identifier) => text.includes(identifier));
  });
}

function applyEvidenceGate(contexts, query) {
  const evidence = assessEvidenceSufficiency(contexts, query);
  if (!evidence.sufficient) return { contexts: [], evidence };
  return {
    contexts: (contexts || []).map((context) => ({ ...context, evidenceSufficiency: evidence })),
    evidence,
  };
}

function semanticEvidenceUsed(contexts) {
  return (contexts || []).some((context) => (
    /(?:^|\+)semantic(?:\+|$)|(?:^|\+)hybrid(?:\+|$)/i.test(String(context?.retrieval || ""))
    || Number(context?.semanticScore || 0) > 0
    || Number(context?.semanticNormalized || 0) > 0
  ));
}

function withRetrievalExecution(contexts, execution) {
  const value = Array.isArray(contexts) ? contexts : [];
  Object.defineProperty(value, "execution", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ ...execution }),
  });
  return value;
}

function tokenize(value) {
  const text = normalizeText(value);
  const latin = text.match(/[a-z0-9][a-z0-9._+/#:-]*/g) || [];
  const cjk = text.match(CJK_RE) || [];
  return [...latin, ...cjk, ...cjkBigrams(text)].filter(Boolean);
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

function bm25CorpusCacheKey(revision, scope, mutationSalt = "") {
  const hash = createHash("sha256");
  hash.update("juzhou-bm25-corpus-v4;");
  hash.update(`${revision};${scope};${mutationSalt}`);
  return hash.digest("hex");
}

function bm25ScopeKey(scope) {
  return createHash("sha256").update("juzhou-bm25-scope-v1;").update(scope).digest("hex");
}

function chunkSequenceMatches(snapshot, chunksRef, revision) {
  if (!snapshot || snapshot.chunksRef !== chunksRef || snapshot.revision !== revision) return false;
  return snapshot.chunkCount === chunksRef.length;
}

function bm25StateSnapshot(state, chunksRef, revision) {
  if (!state || typeof state !== "object") return null;
  const previous = bm25StateSnapshots.get(state);
  if (chunkSequenceMatches(previous, chunksRef, revision)) return previous;
  if (previous) bm25CacheCounters.invalidations += 1;
  const snapshot = {
    chunksRef,
    chunkCount: chunksRef.length,
    revision,
    scopes: new Map(),
    mutationSalt: previous ? `mutation-${++bm25MutationEpoch}` : "",
  };
  bm25StateSnapshots.set(state, snapshot);
  return snapshot;
}

export function invalidateBm25CacheForState(state) {
  if (!state || typeof state !== "object") return;
  const chunksRef = Array.isArray(state.chunks) ? state.chunks : [];
  const revision = String(state?.meta?.chunksRevision || state?.meta?.updatedAt || state?.meta?.version || "");
  bm25CacheCounters.invalidations += 1;
  bm25StateSnapshots.set(state, {
    chunksRef,
    chunkCount: chunksRef.length,
    revision,
    scopes: new Map(),
    mutationSalt: `explicit-${++bm25MutationEpoch}`,
  });
}

function readBm25CorpusCache(cacheKey) {
  const cached = bm25CorpusCache.get(cacheKey);
  if (!cached) {
    bm25CacheCounters.misses += 1;
    return null;
  }
  bm25CorpusCache.delete(cacheKey);
  bm25CorpusCache.set(cacheKey, cached);
  bm25CacheCounters.hits += 1;
  return cached.corpus;
}

function evictOldestBm25Corpus() {
  const oldestKey = bm25CorpusCache.keys().next().value;
  if (oldestKey === undefined) return false;
  const oldest = bm25CorpusCache.get(oldestKey);
  bm25CorpusCache.delete(oldestKey);
  bm25CachedChunks -= oldest.chunkCount;
  bm25CachedTokens -= oldest.tokenCount;
  bm25CacheCounters.evictions += 1;
  return true;
}

function storeBm25CorpusCache(cacheKey, corpus) {
  const chunkCount = corpus.size;
  const tokenCount = corpus.tokenCount;
  if (
    BM25_CACHE_MAX_ENTRIES === 0
    || chunkCount > BM25_CACHE_MAX_CHUNKS
    || tokenCount > BM25_CACHE_MAX_TOKENS
  ) {
    bm25CacheCounters.bypasses += 1;
    return;
  }
  while (
    bm25CorpusCache.size >= BM25_CACHE_MAX_ENTRIES
    || bm25CachedChunks + chunkCount > BM25_CACHE_MAX_CHUNKS
    || bm25CachedTokens + tokenCount > BM25_CACHE_MAX_TOKENS
  ) {
    if (!evictOldestBm25Corpus()) break;
  }
  if (
    bm25CorpusCache.size >= BM25_CACHE_MAX_ENTRIES
    || bm25CachedChunks + chunkCount > BM25_CACHE_MAX_CHUNKS
    || bm25CachedTokens + tokenCount > BM25_CACHE_MAX_TOKENS
  ) {
    bm25CacheCounters.bypasses += 1;
    return;
  }
  bm25CorpusCache.set(cacheKey, { corpus, chunkCount, tokenCount });
  bm25CachedChunks += chunkCount;
  bm25CachedTokens += tokenCount;
}

export function getBm25CacheDiagnostics() {
  return {
    version: 1,
    ...bm25CacheCounters,
    entries: bm25CorpusCache.size,
    cachedChunks: bm25CachedChunks,
    cachedTokens: bm25CachedTokens,
    limits: {
      entries: BM25_CACHE_MAX_ENTRIES,
      chunks: BM25_CACHE_MAX_CHUNKS,
      tokens: BM25_CACHE_MAX_TOKENS,
    },
  };
}

export function resetBm25CacheForTests() {
  bm25CorpusCache.clear();
  bm25StateSnapshots = new WeakMap();
  bm25CachedChunks = 0;
  bm25CachedTokens = 0;
  bm25MutationEpoch = 0;
  for (const key of Object.keys(bm25CacheCounters)) bm25CacheCounters[key] = 0;
}

function buildBm25Corpus(state, knowledgeBaseId) {
  const chunksRef = Array.isArray(state?.chunks) ? state.chunks : [];
  const scope = String(knowledgeBaseId || "*");
  const revision = String(state?.meta?.chunksRevision || state?.meta?.updatedAt || state?.meta?.version || "");
  const snapshot = bm25StateSnapshot(state, chunksRef, revision);
  const scopeKey = bm25ScopeKey(scope);
  let cacheKey = snapshot?.scopes.get(scopeKey);
  if (!cacheKey) {
    cacheKey = bm25CorpusCacheKey(revision, scope, snapshot?.mutationSalt);
    snapshot?.scopes.set(scopeKey, cacheKey);
  }
  const cached = readBm25CorpusCache(cacheKey);
  if (cached) return cached;
  const chunks = chunksRef
    .filter((chunk) => !knowledgeBaseId || chunk.knowledgeBaseId === knowledgeBaseId)
    .filter(isUsableTrainingChunk);
  const entries = chunks.map((chunk) => {
    const tokens = tokenize(chunkSearchText(chunk));
    const frequencies = tokenCounts(tokens);
    return {
      chunk,
      length: Math.max(tokens.length, 1),
      frequencies,
    };
  });
  const documentFrequency = new Map();
  const postings = new Map();
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    for (const token of entry.frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
      const indexes = postings.get(token);
      if (indexes) indexes.push(entryIndex);
      else postings.set(token, [entryIndex]);
    }
  }
  const averageLength = entries.length
    ? entries.reduce((sum, entry) => sum + entry.length, 0) / entries.length
    : 1;
  const tokenCount = entries.reduce((sum, entry) => sum + entry.frequencies.size, 0);
  const corpus = { entries, documentFrequency, postings, averageLength, size: entries.length, tokenCount };
  bm25CacheCounters.builds += 1;
  storeBm25CorpusCache(cacheKey, corpus);
  return corpus;
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

function bm25CandidateTokens(query, queryTokens, corpus) {
  const present = [...new Set(queryTokens)]
    .filter((token) => corpus.postings.has(token))
    .sort((left, right) => (corpus.documentFrequency.get(left) || corpus.size) - (corpus.documentFrequency.get(right) || corpus.size));
  const identifiers = new Set(evidenceIdentifiers(query));
  const identifierTokens = present.filter((token) => identifiers.has(token));
  if (identifierTokens.length) {
    const minimumFrequency = corpus.documentFrequency.get(identifierTokens[0]) || 1;
    return identifierTokens
      .filter((token) => (corpus.documentFrequency.get(token) || corpus.size) <= Math.max(8, minimumFrequency * 4))
      .slice(0, 4);
  }
  return present.slice(0, 12);
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
  const candidateIndexes = new Set();
  for (const token of bm25CandidateTokens(query, queryTokens, corpus)) {
    for (const entryIndex of corpus.postings.get(token) || []) candidateIndexes.add(entryIndex);
  }
  return [...candidateIndexes]
    .map((entryIndex) => corpus.entries[entryIndex])
    .map((entry) => {
      const baseScore = bm25Score(queryTokens, entry, corpus);
      const identifierBoost = exactIdentifierBm25Boost(query, entry.chunk);
      const score = baseScore + identifierBoost;
      return {
        ...entry.chunk,
        score,
        bm25Score: baseScore,
        keywordScore: baseScore,
        exactIdentifierBoost: identifierBoost,
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
    exactIdentifierBoost: hit.exactIdentifierBoost || 0,
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
      exactIdentifierBoost: Math.max(Number(existing.exactIdentifierBoost || 0), Number(context.exactIdentifierBoost || 0)),
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
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 50)));
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
  } catch {
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
  } catch {
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

async function searchHybridKnowledgeContexts(state, { knowledgeBaseId, query, limit = 8 }) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 50));
  const candidateLimit = Math.max(safeLimit, Math.min(50, safeLimit * 4));
  const bm25Matches = searchBm25ChildChunks(state, { knowledgeBaseId, query, limit: candidateLimit });
  const semanticMatches = HYBRID_ENABLED ? await semanticSearch(state, { knowledgeBaseId, query, limit: candidateLimit }) : [];
  const configuredWeights = queryWeights(query);
  const weights = semanticMatches.length
    ? configuredWeights
    : { bm25: 1, semantic: 0 };
  const merged = new Map();
  const bm25Range = normalizeRange(bm25Matches.map((chunk) => chunk.score || chunk.bm25Score || 0));
  for (const chunk of bm25Matches) {
    if (!chunk.id) continue;
    const bm25ScoreValue = chunk.bm25Score || 0;
    const bm25RankingScore = chunk.score || bm25ScoreValue;
    merged.set(chunk.id, {
      ...chunk,
      bm25Score: bm25ScoreValue,
      bm25RankingScore,
      bm25Normalized: normalizeScore(bm25RankingScore, bm25Range),
      keywordScore: bm25ScoreValue,
      keywordNormalized: normalizeScore(bm25RankingScore, bm25Range),
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

function rerankerText(context) {
  const matched = (context?.matchedChunks || [])
    .slice(0, 3)
    .map((chunk) => chunk.preview || chunk.sourceRef || "")
    .filter(Boolean)
    .join("\n");
  return [context?.sourceRef, context?.heading, matched, context?.content]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4_000);
}

function normalizeRankScores(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return () => 0;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) return (value) => Number.isFinite(value) ? 1 : 0;
  return (value) => Number.isFinite(value) ? (value - min) / (max - min) : 0;
}

async function applyReranker(query, candidates, limit) {
  const config = getRerankerRuntimeConfig();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 20));
  const startedAt = Date.now();
  const result = await rerankDocuments(query, candidates.map((candidate) => ({
    id: String(candidate.parentId || candidate.id || candidate.matchedChunkId),
    text: rerankerText(candidate),
  })), { topK: candidates.length });
  if (!result.ok) {
    return candidates.slice(0, safeLimit).map((candidate) => ({
      ...candidate,
      originalScore: Number(candidate.score || 0),
      rerankerStatus: result.status,
      rerankerReason: result.reasonCode || result.status,
      rerankerError: result.error || "",
      rerankerLatencyMs: result.latencyMs || Date.now() - startedAt,
      retrievalLatencyMs: 0,
    }));
  }
  const byId = new Map(candidates.map((candidate) => [String(candidate.parentId || candidate.id || candidate.matchedChunkId), candidate]));
  const resultById = new Map(result.results.map((entry) => [String(entry.id), entry]));
  const normalizeOriginal = normalizeRankScores(candidates.map((candidate) => Number(candidate.score || 0)));
  const normalizeReranker = normalizeRankScores(result.results.map((entry) => Number(entry.score)));
  return candidates
    .map((candidate) => {
      const id = String(candidate.parentId || candidate.id || candidate.matchedChunkId);
      const reranked = resultById.get(id);
      const originalScore = Number(candidate.score || 0);
      const rerankerScore = Number(reranked?.score);
      const rerankerNormalized = normalizeReranker(rerankerScore);
      const originalNormalized = normalizeOriginal(originalScore);
      return {
        ...candidate,
        originalScore,
        rerankerScore: Number.isFinite(rerankerScore) ? rerankerScore : null,
        rerankerNormalized,
        score: config.weight * rerankerNormalized + (1 - config.weight) * originalNormalized,
        retrieval: mergeRetrieval(candidate.retrieval, "reranker"),
        rerankerStatus: "ready",
        rerankerModel: result.model,
        rerankerLatencyMs: result.latencyMs || Date.now() - startedAt,
        retrievalLatencyMs: 0,
      };
    })
    .filter((candidate) => byId.has(String(candidate.parentId || candidate.id || candidate.matchedChunkId)))
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .slice(0, safeLimit);
}

export async function searchKnowledgeContextsByMode(state, { knowledgeBaseId, query, limit = 8, mode = "auto" }) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 20));
  const requestedMode = String(mode || "auto").trim().toLowerCase();
  const startedAt = Date.now();
  if (requestedMode === "bm25") {
    const rawContexts = searchChunks(state, { knowledgeBaseId, query, limit: safeLimit }).map((context) => ({
      ...context,
      retrievalLatencyMs: Date.now() - startedAt,
    }));
    const { contexts } = applyEvidenceGate(rawContexts, query);
    recordRetrievalObservation({
      mode: "bm25",
      candidateCount: rawContexts.length,
      evidenceCount: contexts.length,
      retrievalLatencyMs: Date.now() - startedAt,
    });
    return withRetrievalExecution(contexts, {
      requestedMode,
      effectiveMode: "bm25",
      semanticUsed: false,
      rerankerStatus: "not_requested",
      intentionalSkip: false,
      degradedReason: "",
    });
  }
  const config = getRerankerRuntimeConfig();
  const shouldRerank = requestedMode === "hybrid-rerank"
    || requestedMode === "hybrid+reranker"
    || (requestedMode === "auto" && config.enabled);
  const candidateLimit = shouldRerank ? Math.max(safeLimit, config.candidates) : safeLimit;
  const candidates = await searchHybridKnowledgeContexts(state, { knowledgeBaseId, query, limit: candidateLimit });
  const semanticUsed = semanticEvidenceUsed(candidates);
  if (!shouldRerank) {
    const rawContexts = candidates.slice(0, safeLimit).map((context) => ({
      ...context,
      retrievalLatencyMs: Date.now() - startedAt,
    }));
    const { contexts } = applyEvidenceGate(rawContexts, query);
    recordRetrievalObservation({
      mode: "hybrid",
      candidateCount: candidates.length,
      evidenceCount: contexts.length,
      retrievalLatencyMs: Date.now() - startedAt,
    });
    return withRetrievalExecution(contexts, {
      requestedMode,
      effectiveMode: semanticUsed ? "hybrid" : "bm25",
      semanticUsed,
      rerankerStatus: "not_requested",
      intentionalSkip: false,
      degradedReason: semanticUsed ? "" : "semantic_not_used",
    });
  }
  // A cross-encoder may promote a superficially related item from the wider
  // candidate pool, but ranking confidence is not evidence sufficiency. Require
  // the plain top window to pass first, except when the original wider pool
  // already contains every exact model/evidence identifier from the query.
  // The final reranked window is gated again below, so this exception lets the
  // reranker rescue precise evidence without turning an unrelated query into an
  // answer.
  const preRerankWindow = candidates.slice(0, safeLimit);
  const preRerankEvidence = assessEvidenceSufficiency(preRerankWindow, query);
  const exactIdentifierEvidence = hasExactIdentifierEvidence(candidates, query);
  if (!preRerankEvidence.sufficient && !exactIdentifierEvidence) {
    recordRetrievalObservation({
      mode: "hybrid",
      candidateCount: candidates.length,
      evidenceCount: 0,
      retrievalLatencyMs: Date.now() - startedAt,
      rerankerLatencyMs: 0,
      rerankerStatus: "skipped_insufficient_evidence",
      degradedReason: "insufficient_evidence",
    });
    return withRetrievalExecution([], {
      requestedMode,
      effectiveMode: semanticUsed ? "hybrid_evidence_refusal" : "bm25_evidence_refusal",
      semanticUsed,
      rerankerStatus: "skipped_insufficient_evidence",
      intentionalSkip: true,
      degradedReason: semanticUsed ? "" : "semantic_not_used",
    });
  }
  const reranked = await applyReranker(query, candidates, safeLimit);
  const rawContexts = reranked.map((context) => ({
    ...context,
    retrievalLatencyMs: Date.now() - startedAt,
  }));
  const { contexts } = applyEvidenceGate(rawContexts, query);
  const top = rawContexts[0] || {};
  const rerankerReady = top.rerankerStatus === "ready";
  const degradedReason = [
    ...(semanticUsed ? [] : ["semantic_not_used"]),
    ...(rerankerReady ? [] : [top.rerankerReason || top.rerankerStatus || "reranker_not_ready"]),
  ].join(";");
  recordRetrievalObservation({
    mode: top.rerankerStatus === "ready" ? "hybrid+reranker" : "hybrid",
    candidateCount: candidates.length,
    evidenceCount: contexts.length,
    retrievalLatencyMs: Date.now() - startedAt,
    rerankerLatencyMs: top.rerankerLatencyMs,
    rerankerStatus: top.rerankerStatus,
    degradedReason: top.rerankerStatus === "ready" ? "" : top.rerankerReason || top.rerankerStatus,
  });
  return withRetrievalExecution(contexts, {
    requestedMode,
    effectiveMode: rerankerReady
      ? (semanticUsed ? "hybrid+reranker" : "bm25+reranker")
      : (semanticUsed ? "hybrid" : "bm25"),
    semanticUsed,
    rerankerStatus: top.rerankerStatus || "missing",
    intentionalSkip: false,
    degradedReason,
  });
}

export async function searchKnowledgeContexts(state, options) {
  return await searchKnowledgeContextsByMode(state, { ...options, mode: options?.mode || "auto" });
}

export async function searchChunksHybrid(state, { knowledgeBaseId, query, limit = 8 }) {
  return searchKnowledgeContextsByMode(state, { knowledgeBaseId, query, limit, mode: "hybrid" });
}

export function isHybridSearchEnabled() {
  return HYBRID_ENABLED && qdrantHealthy;
}

export function buildAnswer(state, { knowledgeBaseId, question }) {
  const matches = applyEvidenceGate(searchChunks(state, { knowledgeBaseId, query: question, limit: 4 }), question).contexts;
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
