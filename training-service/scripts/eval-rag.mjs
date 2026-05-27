import { loadState } from "../src/store.mjs";
import { getRuntimeHealth } from "../src/health.mjs";
import { searchChunks, searchChunksHybrid } from "../src/rag.mjs";
import { generateKnowledgeAnswer } from "../src/ai/index.mjs";
import { RAG_EVAL_THRESHOLDS, ragEvalCases } from "./fixtures/rag-eval-cases.mjs";

const args = new Set(process.argv.slice(2));
const includeAnswers = !args.has("--no-answer") && !args.has("--retrieval-only");

function textOf(hit) {
  return `${hit?.sourceRef || ""}\n${hit?.heading || ""}\n${hit?.content || ""}`;
}

function expectedHits(hit, expected) {
  const text = textOf(hit);
  return expected.filter((term) => text.includes(term)).length;
}

function compactHit(hit, expected) {
  return {
    id: hit?.id,
    parentId: hit?.parentId,
    matchedChunkId: hit?.matchedChunkId,
    retrieval: hit?.retrieval,
    score: Number(hit?.score || 0).toFixed(3),
    bm25Score: Number(hit?.bm25Score || hit?.keywordScore || 0).toFixed(3),
    semanticScore: Number(hit?.semanticScore || 0).toFixed(3),
    expectedHits: expectedHits(hit, expected),
    sourceRef: hit?.sourceRef,
    preview: String(hit?.content || "").replace(/\s+/g, " ").slice(0, 120),
  };
}

function answerChecks(answer) {
  const text = String(answer?.answer || "");
  const sourceRefs = Array.isArray(answer?.sourceRefs) ? answer.sourceRefs : [];
  const joined = `${text} ${(answer?.keyPoints || []).join(" ")} ${(answer?.caveats || []).join(" ")}`;
  const warnings = [];
  if (text.trim().length < 12) warnings.push("empty_answer");
  if (text.length > 900) warnings.push("answer_too_long");
  if (!sourceRefs.length && !(answer?.sources || []).length) warnings.push("missing_sources");
  if (/未能抽取|OCR|扫描件|复制文本|鏈兘|鎵弿/.test(joined)) warnings.push("ocr_placeholder_leaked");
  return {
    ok: warnings.length === 0,
    warnings,
    generatedBy: answer?.generatedBy,
    confidence: answer?.confidence,
    retrievalMode: answer?.retrievalMode,
    answerQuality: answer?.answerQuality,
    sourceRefs,
    answerPreview: text.replace(/\s+/g, " ").slice(0, 160),
  };
}

function chooseKnowledgeBase(state) {
  const byName = state.knowledgeBases.find((kb) => String(kb.name || "").includes("电机"));
  if (byName) return byName;
  return [...(state.knowledgeBases || [])]
    .sort((left, right) => state.chunks.filter((chunk) => chunk.knowledgeBaseId === right.id).length - state.chunks.filter((chunk) => chunk.knowledgeBaseId === left.id).length)[0];
}

const state = await loadState();
const health = await getRuntimeHealth(state);
const knowledgeBase = chooseKnowledgeBase(state);
if (!knowledgeBase) {
  throw new Error("No knowledge base found");
}

const rows = [];
for (const test of ragEvalCases) {
  const hybrid = await searchChunksHybrid(state, { knowledgeBaseId: knowledgeBase.id, query: test.query, limit: 5 });
  const bm25 = searchChunks(state, { knowledgeBaseId: knowledgeBase.id, query: test.query, limit: 5 });
  const threshold = Number.isFinite(test.minHits) ? test.minHits : Math.min(2, test.expected.length);
  const hybridScores = hybrid.map((hit) => expectedHits(hit, test.expected));
  const bm25Scores = bm25.map((hit) => expectedHits(hit, test.expected));
  const row = {
    id: test.id,
    category: test.category || "uncategorized",
    query: test.query,
    expected: test.expected,
    minHits: threshold,
    hybridTop1Relevant: (hybridScores[0] || 0) >= threshold,
    hybridTop3Relevant: hybridScores.slice(0, 3).some((score) => score >= threshold),
    hybridTop1ExpectedHits: hybridScores[0] || 0,
    bm25Top1ExpectedHits: bm25Scores[0] || 0,
    hybridTop1BetterOrEqualBm25: (hybridScores[0] || 0) >= (bm25Scores[0] || 0),
    hybridTop3: hybrid.slice(0, 3).map((hit) => compactHit(hit, test.expected)),
    bm25Top3: bm25.slice(0, 3).map((hit) => compactHit(hit, test.expected)),
  };
  if (includeAnswers) {
    const answer = await generateKnowledgeAnswer(state, { knowledgeBaseId: knowledgeBase.id, question: test.query });
    row.answer = answerChecks(answer);
  }
  rows.push(row);
}

function summarizeCategory(categoryRows) {
  return {
    total: categoryRows.length,
    hybridTop1Relevant: categoryRows.filter((row) => row.hybridTop1Relevant).length,
    hybridTop3Relevant: categoryRows.filter((row) => row.hybridTop3Relevant).length,
    hybridTop1BetterOrEqualBm25: categoryRows.filter((row) => row.hybridTop1BetterOrEqualBm25).length,
    failedTop1: categoryRows.filter((row) => !row.hybridTop1Relevant).map((row) => row.id),
    failedTop3: categoryRows.filter((row) => !row.hybridTop3Relevant).map((row) => row.id),
  };
}

function summarizeCategories(allRows) {
  return Object.fromEntries(
    [...new Set(allRows.map((row) => row.category))]
      .sort()
      .map((category) => [category, summarizeCategory(allRows.filter((row) => row.category === category))])
  );
}

const answerRows = rows.filter((row) => row.answer);
const summary = {
  ok: true,
  knowledgeBase: {
    id: knowledgeBase.id,
    name: knowledgeBase.name,
    chunks: state.chunks.filter((chunk) => chunk.knowledgeBaseId === knowledgeBase.id).length,
  },
  runtime: {
    retrievalMode: health.retrievalMode,
    ollamaOk: health.ollamaOk,
    localVectorIndexOk: health.localVectorIndexOk,
    qdrantOk: health.qdrantOk,
  },
  retrieval: {
    total: rows.length,
    expectedTotal: RAG_EVAL_THRESHOLDS.total,
    hybridTop1Relevant: rows.filter((row) => row.hybridTop1Relevant).length,
    hybridTop3Relevant: rows.filter((row) => row.hybridTop3Relevant).length,
    hybridTop1BetterOrEqualBm25: rows.filter((row) => row.hybridTop1BetterOrEqualBm25).length,
    thresholds: RAG_EVAL_THRESHOLDS,
    byCategory: summarizeCategories(rows),
    failedTop1: rows.filter((row) => !row.hybridTop1Relevant).map((row) => row.id),
    failedTop3: rows.filter((row) => !row.hybridTop3Relevant).map((row) => row.id),
  },
  answers: includeAnswers ? {
    total: answerRows.length,
    ok: answerRows.filter((row) => row.answer.ok).length,
    failed: answerRows.filter((row) => !row.answer.ok).map((row) => ({ id: row.id, warnings: row.answer.warnings })),
  } : null,
};

summary.ok = summary.retrieval.total === RAG_EVAL_THRESHOLDS.total
  && summary.retrieval.hybridTop1Relevant >= RAG_EVAL_THRESHOLDS.hybridTop1Relevant
  && summary.retrieval.hybridTop3Relevant >= RAG_EVAL_THRESHOLDS.hybridTop3Relevant
  && summary.retrieval.hybridTop1BetterOrEqualBm25 >= RAG_EVAL_THRESHOLDS.hybridTop1BetterOrEqualBm25
  && (!includeAnswers || summary.answers.failed.length === 0);

console.log(JSON.stringify({ summary, rows }, null, 2));

if (!summary.ok) {
  process.exitCode = 1;
}
