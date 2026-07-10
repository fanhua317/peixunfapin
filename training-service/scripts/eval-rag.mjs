import { loadState } from "../src/store.mjs";
import { getRuntimeHealth } from "../src/health.mjs";
import * as ragSearch from "../src/rag.mjs";
import { generateKnowledgeAnswer } from "../src/ai/index.mjs";
import {
  RAG_EVAL_THRESHOLDS,
  ragEvalCases,
  validateRagEvalCases,
} from "./fixtures/rag-eval-cases.mjs";
import {
  RETRIEVAL_MODES,
  compactRetrievalHit,
  evaluateRankedHits,
  resolveKnowledgeBase,
  summarizeModeRows,
} from "./evaluation/rag-metrics.mjs";
import {
  evaluateAnswerQuality,
  summarizeAnswerQuality,
} from "./evaluation/answer-quality.mjs";

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const includeAnswers = !args.has("--no-answer") && !args.has("--retrieval-only");

function optionValue(name) {
  const equals = rawArgs.find((item) => item.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = rawArgs.indexOf(name);
  return index >= 0 ? rawArgs[index + 1] : "";
}

function selectedModes() {
  const requested = optionValue("--modes") || optionValue("--mode");
  if (!requested) return [...RETRIEVAL_MODES];
  const modes = requested.split(/[,;|]/).map((item) => item.trim()).filter(Boolean);
  const invalid = modes.filter((mode) => !RETRIEVAL_MODES.includes(mode));
  if (invalid.length) throw new Error(`Unsupported retrieval mode(s): ${invalid.join(", ")}`);
  return [...new Set(modes)];
}

function selectedSplit() {
  const split = optionValue("--split");
  if (!split) return "";
  if (!["dev", "test"].includes(split)) throw new Error(`Unsupported split: ${split}`);
  return split;
}

function evaluationCases(split) {
  // A frozen test run still evaluates dev rows internally so its evidence
  // threshold is calibrated only on dev instead of silently collapsing to 0.
  if (split === "dev") return ragEvalCases.filter((item) => item.split === "dev");
  return [...ragEvalCases];
}

async function searchByMode(state, options) {
  if (typeof ragSearch.searchKnowledgeContextsByMode === "function") {
    return await ragSearch.searchKnowledgeContextsByMode(state, options);
  }
  if (options.mode === "bm25") {
    return ragSearch.searchChunks(state, options);
  }
  return await ragSearch.searchKnowledgeContexts(state, options);
}

function retrievalScope(test, expectedKnowledgeBase) {
  if (test.knowledgeBase === "all" || test.category === "cross-kb-hard-negative") return undefined;
  return expectedKnowledgeBase?.id;
}

function retryableAnswerEvalError(error) {
  const text = error instanceof Error ? `${error.name} ${error.message} ${error.cause?.message || ""}` : String(error || "");
  return /fetch failed|econn|enet|socket|timeout|timed out|429|rate limit|50[0234]|temporar(?:y|ily)|network/i.test(text);
}

async function generateEvaluatedAnswer(state, options) {
  const maxAttempts = 3;
  let lastError = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      return { answer: await generateKnowledgeAnswer(state, options), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !retryableAnswerEvalError(error)) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  return { error: lastError, attempts };
}

function isRealRerankerResult(rows) {
  return rows.some((row) => row.hits.some((hit) => (
    hit.rerankerScore !== null || /^(?:ok|success|reranked)$/i.test(hit.rerankerStatus)
  )));
}

function compareReranker(modeSummaries, modeRows) {
  const hybrid = modeSummaries.hybrid?.test;
  const reranked = modeSummaries["hybrid-rerank"]?.test;
  if (!hybrid || !reranked) return { evaluated: false, reason: "required_modes_not_selected" };
  if (!isRealRerankerResult(modeRows["hybrid-rerank"] || [])) {
    return { evaluated: false, reason: "reranker_not_used_or_fell_back" };
  }
  const hit3Regression = hybrid.hitAt3 - reranked.hitAt3;
  const checks = {
    hitAt1NonDegraded: reranked.hitAt1 >= hybrid.hitAt1,
    mrrAt5NonDegraded: reranked.mrrAt5 + Number.EPSILON >= hybrid.mrrAt5,
    ndcgAt5NonDegraded: reranked.ndcgAt5 + Number.EPSILON >= hybrid.ndcgAt5,
    hitAt3RegressionWithinLimit: hit3Regression <= RAG_EVAL_THRESHOLDS.rerankerMaxHit3Regression,
    abstentionAccuracyNonDegraded: reranked.abstentionAccuracy + Number.EPSILON >= hybrid.abstentionAccuracy,
  };
  return {
    evaluated: true,
    passed: Object.values(checks).every(Boolean),
    checks,
    hit3Regression,
    hybrid: {
      hitAt1: hybrid.hitAt1,
      hitAt3: hybrid.hitAt3,
      mrrAt5: hybrid.mrrAt5,
      ndcgAt5: hybrid.ndcgAt5,
      abstentionAccuracy: hybrid.abstentionAccuracy,
    },
    reranked: {
      hitAt1: reranked.hitAt1,
      hitAt3: reranked.hitAt3,
      mrrAt5: reranked.mrrAt5,
      ndcgAt5: reranked.ndcgAt5,
      abstentionAccuracy: reranked.abstentionAccuracy,
    },
  };
}

const fixtureValidation = validateRagEvalCases();
if (!fixtureValidation.ok) {
  throw new Error(`Invalid RAG fixtures:\n${fixtureValidation.errors.join("\n")}`);
}

const modes = selectedModes();
const requestedSplit = selectedSplit();
const cases = evaluationCases(requestedSplit);
const reportedCases = requestedSplit ? ragEvalCases.filter((item) => item.split === requestedSplit) : ragEvalCases;
const state = await loadState();
const health = await getRuntimeHealth(state);
const knowledgeBases = Object.fromEntries(["motor", "pump"].map((selector) => {
  const knowledgeBase = resolveKnowledgeBase(state, selector);
  if (!knowledgeBase) throw new Error(`No ${selector} knowledge base found`);
  return [selector, knowledgeBase];
}));

const rowsByMode = {};
const summariesByMode = {};
for (const mode of modes) {
  const rows = [];
  for (const test of cases) {
    const expectedKnowledgeBase = test.knowledgeBase === "all" ? null : knowledgeBases[test.knowledgeBase];
    const knowledgeBaseId = retrievalScope(test, expectedKnowledgeBase);
    const startedAt = performance.now();
    let hits = [];
    let error = "";
    try {
      hits = await searchByMode(state, {
        knowledgeBaseId,
        query: test.query,
        limit: 5,
        mode,
      });
    } catch (searchError) {
      error = searchError instanceof Error ? searchError.message : String(searchError);
    }
    const latencyMs = performance.now() - startedAt;
    const metrics = evaluateRankedHits(test, hits, expectedKnowledgeBase?.id);
    rows.push({
      id: test.id,
      split: test.split,
      domain: test.domain,
      category: test.category,
      answerMode: test.answerMode,
      query: test.query,
      knowledgeBase: test.knowledgeBase,
      expectedKnowledgeBaseId: expectedKnowledgeBase?.id || null,
      searchKnowledgeBaseId: knowledgeBaseId || null,
      latencyMs: Number(latencyMs.toFixed(3)),
      topScore: hits.length ? Number(hits[0]?.score || 0) : -1,
      metrics,
      error,
      hits: hits.slice(0, 5).map((hit) => compactRetrievalHit(hit, test, expectedKnowledgeBase?.id)),
    });
  }
  rowsByMode[mode] = rows;
  summariesByMode[mode] = summarizeModeRows(rows);
}

let answerRows = [];
let answerSummary = null;
if (includeAnswers) {
  const answerCases = cases.filter((item) => (
    item.tags.includes("answer-quality")
    && (!requestedSplit || item.split === requestedSplit)
  ));
  for (const test of answerCases) {
    const expectedKnowledgeBase = test.knowledgeBase === "all" ? null : knowledgeBases[test.knowledgeBase];
    const generated = await generateEvaluatedAnswer(state, {
      knowledgeBaseId: expectedKnowledgeBase?.id,
      question: test.query,
    });
    answerRows.push({
      ...evaluateAnswerQuality(state, test, generated),
      evaluationAttempts: generated.attempts,
    });
  }
  answerSummary = summarizeAnswerQuality(answerRows, RAG_EVAL_THRESHOLDS);
}

const rerankerAcceptance = compareReranker(summariesByMode, rowsByMode);
const fullSuite = cases.length === ragEvalCases.length;
const fullAnswerSuite = answerRows.length === RAG_EVAL_THRESHOLDS.answerQuality;
const hybridQualityEnvironment = String(health.retrievalMode || "").startsWith("hybrid");
const hybridTest = summariesByMode.hybrid?.test || null;
const hybridQualityGate = hybridTest
  ? {
      evaluated: hybridQualityEnvironment,
      passed: hybridQualityEnvironment ? hybridTest.hitAt3Rate >= RAG_EVAL_THRESHOLDS.hybridTestHit3Rate : null,
      targetHitAt3Rate: RAG_EVAL_THRESHOLDS.hybridTestHit3Rate,
      actualHitAt3Rate: hybridTest.hitAt3Rate,
      reason: hybridQualityEnvironment ? "hybrid_available" : "environment_degraded_to_bm25",
    }
  : { evaluated: false, passed: null, reason: "hybrid_mode_not_selected" };

const summary = {
  ok: fixtureValidation.ok,
  fixture: fixtureValidation.counts,
  selected: {
    total: reportedCases.length,
    evaluatedTotal: cases.length,
    split: requestedSplit || "all",
    modes,
    answers: includeAnswers,
  },
  knowledgeBases: Object.fromEntries(Object.entries(knowledgeBases).map(([key, value]) => [key, {
    id: value.id,
    name: value.name,
    chunks: state.chunks.filter((chunk) => chunk.knowledgeBaseId === value.id).length,
  }])),
  runtime: {
    retrievalMode: health.retrievalMode,
    ollamaOk: health.ollamaOk,
    localVectorIndexOk: health.localVectorIndexOk,
    qdrantOk: health.qdrantOk,
    hybridQualityEnvironment,
  },
  retrieval: {
    modes: summariesByMode,
    hybridQualityGate,
    rerankerAcceptance,
    // Compatibility fields used by older reports. They now refer to the full answerable subset.
    total: cases.length,
    expectedTotal: fullSuite ? RAG_EVAL_THRESHOLDS.total : cases.length,
    hybridTop1Relevant: summariesByMode.hybrid?.overall.hitAt1 ?? null,
    hybridTop3Relevant: summariesByMode.hybrid?.overall.hitAt3 ?? null,
  },
  answers: answerSummary,
};

if (fullSuite && hybridQualityGate.evaluated && !hybridQualityGate.passed) summary.ok = false;
if (fullSuite && rerankerAcceptance.evaluated && !rerankerAcceptance.passed) summary.ok = false;
if (includeAnswers && fullAnswerSuite && !answerSummary?.ok) summary.ok = false;
if (Object.values(rowsByMode).some((rows) => rows.some((row) => row.error))) summary.ok = false;

const reportedRows = requestedSplit
  ? Object.fromEntries(Object.entries(rowsByMode).map(([mode, rows]) => [mode, rows.filter((row) => row.split === requestedSplit)]))
  : rowsByMode;
console.log(JSON.stringify(args.has("--summary-only") ? { summary } : { summary, rows: reportedRows, answerRows }, null, 2));

if (!summary.ok) process.exitCode = 1;
