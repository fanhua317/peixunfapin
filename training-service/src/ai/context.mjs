import { searchChunks, searchKnowledgeContexts } from "../rag.mjs";
import { isUsableTrainingChunk } from "../quality.mjs";
import {
  ANSWER_CONTEXT_LIMIT,
  FACTUAL_SOURCE_LIMIT,
  LOW_VALUE_CONTEXT_RE,
  MAX_CONTEXT_CHARS,
  PARAM_CHUNK_RE,
  PARAM_QUERY_RE,
  PROCESS_QUERY_RE,
} from "./config.mjs";
import { cleanReadableText, uniqueStrings } from "./text-utils.mjs";

const CONCRETE_MODEL_RE = /\b(?=[a-z0-9._+/#:-]*[a-z])(?=[a-z0-9._+/#:-]*\d)[a-z0-9][a-z0-9._+/#:-]{1,}\b/i;
const SUBSTANTIVE_PRODUCT_RE = /(型号|系列|功率|参数|用途|适用|结构|标准|能效|工艺|离心泵|自吸|清水输送|增压|motor|pump|model|power|application)/i;

function isLowValueContext(chunk) {
  const text = `${chunk?.heading || ""}\n${chunk?.sourceRef || ""}\n${chunk?.content || ""}`;
  const cleaned = cleanReadableText(text, 500);
  const body = cleanReadableText(chunk?.content || "", 500);
  if (!cleaned || cleaned.length < 16) return true;
  const substantiveBody = body.length >= 24 && (CONCRETE_MODEL_RE.test(body) || SUBSTANTIVE_PRODUCT_RE.test(body));
  if (LOW_VALUE_CONTEXT_RE.test(cleaned) && !/(工艺|铸铝|检测|机座范围|功率范围|能效|附加损耗|客户|销售)/.test(cleaned) && !substantiveBody) return true;
  return false;
}

export function retrievalModeFromChunks(chunks) {
  if ((chunks || []).some((chunk) => String(chunk.retrieval || "").includes("reranker") && chunk.rerankerStatus === "ready")) return "hybrid+reranker";
  if ((chunks || []).some((chunk) => String(chunk.retrieval || "").includes("hybrid"))) return "hybrid";
  if ((chunks || []).some((chunk) => /(semantic|local-vector|vector)/.test(String(chunk.retrieval || "")))) return "hybrid";
  if ((chunks || []).some((chunk) => String(chunk.retrieval || "").includes("bm25"))) return "bm25";
  return "keyword-legacy";
}

function contextScoreForQuery(chunk, query, index) {
  const text = `${chunk?.sourceRef || ""}\n${chunk?.heading || ""}\n${chunk?.content || ""}`;
  let score = Math.max(0, 100 - index * 4);
  score += Number(chunk?.score || 0) * 30;
  score += Number(chunk?.semanticScore || 0) * 20;
  if (PARAM_QUERY_RE.test(query) && PARAM_CHUNK_RE.test(text)) score += 60;
  if (PROCESS_QUERY_RE.test(query) && /(工艺|铸铝|检测|质量|品质|客户|销售|附加损耗|转子|定子)/.test(text)) score += 35;
  if (isLowValueContext(chunk)) score -= 120;
  if (/^#\s*视觉识别补充[:：]/.test(String(chunk?.content || ""))) score -= 60;
  return score;
}

export function refineContextChunks(chunks, query, limit = ANSWER_CONTEXT_LIMIT) {
  const seen = new Set();
  return (chunks || [])
    .map((chunk, index) => ({ chunk, score: contextScoreForQuery(chunk, query, index) }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.chunk)
    .filter((chunk) => {
      if (!chunk || !chunk.id) return false;
      const key = `${chunk.id}:${chunk.sourceRef || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return !isLowValueContext(chunk) || PARAM_CHUNK_RE.test(String(chunk.content || ""));
    })
    .slice(0, Math.max(1, limit));
}

export function allowedSourceRefs(chunks) {
  return uniqueStrings((chunks || []).map((chunk) => chunk.sourceRef)).slice(0, FACTUAL_SOURCE_LIMIT);
}

export function normalizeSourceRefs(rawRefs, chunks) {
  const allowed = allowedSourceRefs(chunks);
  const requested = uniqueStrings(rawRefs);
  const matched = requested
    .map((ref) => allowed.find((allowedRef) => allowedRef === ref || allowedRef.includes(ref) || ref.includes(allowedRef)))
    .filter(Boolean);
  return matched.length ? uniqueStrings(matched).slice(0, FACTUAL_SOURCE_LIMIT) : allowed;
}

export function getKnowledgeBase(state, knowledgeBaseId) {
  return state.knowledgeBases.find((kb) => kb.id === knowledgeBaseId) || null;
}

function selectContextChunks(state, { knowledgeBaseId, query, limit = 12 }) {
  const ranked = searchChunks(state, { knowledgeBaseId, query, limit });
  const supplemental = state.chunks.filter((chunk) => chunk.knowledgeBaseId === knowledgeBaseId).filter(isUsableTrainingChunk);
  const seen = new Set();
  const selected = [];
  for (const chunk of [...ranked, ...supplemental]) {
    if (!chunk || seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    selected.push(chunk);
    if (selected.length >= limit) break;
  }
  return selected;
}

export async function selectContextChunksHybrid(state, { knowledgeBaseId, query, limit = 12 }) {
  try {
    const hybrid = await searchKnowledgeContexts(state, { knowledgeBaseId, query, limit });
    if (hybrid && hybrid.length) {
      const seen = new Set();
      const merged = [];
      for (const chunk of hybrid) {
        if (!chunk || !chunk.id || seen.has(chunk.id)) continue;
        seen.add(chunk.id);
        merged.push(chunk);
      }
      for (const chunk of selectContextChunks(state, { knowledgeBaseId, query, limit })) {
        if (!chunk || !chunk.id || seen.has(chunk.id)) continue;
        seen.add(chunk.id);
        merged.push(chunk);
        if (merged.length >= limit) break;
      }
      return refineContextChunks(merged, query, limit);
    }
  } catch {
  }
  return refineContextChunks(selectContextChunks(state, { knowledgeBaseId, query, limit }), query, limit);
}

export function renderContext(chunks) {
  let total = 0;
  const lines = [];
  for (const chunk of chunks) {
    const matched = Array.isArray(chunk.matchedChunks) && chunk.matchedChunks.length
      ? `\n\nMatched child snippets:\n${chunk.matchedChunks
        .slice(0, 3)
        .map((item, index) => `${index + 1}. ${item.preview || item.sourceRef || item.chunkId}`)
        .join("\n")}`
      : chunk.matchedPreview
        ? `\n\nMatched child snippet:\n${chunk.matchedPreview}`
        : "";
    const text = `[${chunk.sourceRef}]\n${chunk.content}${matched}`;
    const remaining = MAX_CONTEXT_CHARS - total;
    if (remaining <= 0) break;
    const clipped = text.length > remaining ? text.slice(0, remaining) : text;
    lines.push(clipped);
    total += clipped.length;
  }
  return lines.join("\n\n---\n\n");
}

export function sourceObjects(chunks) {
  return chunks.map((chunk) => ({
    chunkId: chunk.matchedChunkId || chunk.chunkId || chunk.id,
    parentId: chunk.parentId || null,
    matchedChunkId: chunk.matchedChunkId || chunk.chunkId || null,
    documentId: chunk.documentId,
    sourceRef: chunk.sourceRef,
    score: chunk.score,
    retrieval: chunk.retrieval,
    bm25Score: chunk.bm25Score,
    keywordScore: chunk.keywordScore,
    semanticScore: chunk.semanticScore,
    originalScore: chunk.originalScore,
    rerankerScore: chunk.rerankerScore,
    rerankerStatus: chunk.rerankerStatus,
    rerankerModel: chunk.rerankerModel,
    retrievalLatencyMs: chunk.retrievalLatencyMs,
    rerankerLatencyMs: chunk.rerankerLatencyMs,
    matchedPreview: chunk.matchedPreview || "",
    contentPreview: cleanReadableText(chunk.content, 220),
  }));
}

export function retrievalConfidence(chunks, high = "high", medium = "medium") {
  const top = chunks[0] || {};
  if (/(semantic|hybrid|local-vector|vector)/.test(String(top.retrieval || ""))) {
    return (top.score || 0) >= 0.55 ? high : medium;
  }
  return (top.score || 0) >= 0.55 || (top.bm25Score || 0) >= 4 ? high : medium;
}
