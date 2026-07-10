export const RETRIEVAL_MODES = Object.freeze(["bm25", "hybrid", "hybrid-rerank"]);

function normalizeText(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function percentile(values, ratio) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Number(sorted[index].toFixed(3));
}

export function resolveKnowledgeBase(state, selector) {
  if (!selector || selector === "all") return null;
  const knowledgeBases = state.knowledgeBases || [];
  if (selector === "motor") {
    return knowledgeBases.find((item) => /电机|motor/i.test(`${item.name || ""} ${(item.aliases || []).join(" ")}`)) || null;
  }
  if (selector === "pump") {
    return knowledgeBases.find((item) => /水泵|银嘉泵|pump/i.test(`${item.name || ""} ${(item.aliases || []).join(" ")}`)) || null;
  }
  return knowledgeBases.find((item) => item.id === selector || item.name === selector) || null;
}

export function hitText(hit) {
  return normalizeText([
    hit?.sourceRef,
    hit?.heading,
    hit?.content,
    hit?.searchText,
    hit?.matchedPreview,
    ...(hit?.matchedChunks || []).flatMap((item) => [item?.sourceRef, item?.preview]),
  ].filter(Boolean).join("\n"));
}

export function factMatches(text, fact) {
  const normalizedText = normalizeText(text);
  const normalizedFact = normalizeText(fact);
  if (!normalizedFact) return false;
  if (normalizedText.includes(normalizedFact)) return true;
  const parts = normalizedFact
    .split(/[:：=；;]/)
    .map((item) => item.replace(/[\s()（）]/g, ""))
    .filter((item) => item.length >= 2);
  return parts.length > 1 && parts.every((item) => normalizedText.replace(/[\s()（）]/g, "").includes(item));
}

export function expectedFactHits(hit, test) {
  const text = hitText(hit);
  return (test.expectedFacts || []).filter((fact) => factMatches(text, fact)).length;
}

export function expectedSourceMatch(hit, test) {
  const sourceText = normalizeText([
    hit?.sourceRef,
    hit?.heading,
    ...(hit?.matchedChunks || []).map((item) => item?.sourceRef),
  ].filter(Boolean).join("\n"));
  return (test.expectedSources || []).some((source) => sourceText.includes(normalizeText(source)));
}

export function relevanceGrade(hit, test, expectedKnowledgeBaseId) {
  if (!hit || test.answerMode === "abstain") return 0;
  if (expectedKnowledgeBaseId && hit.knowledgeBaseId !== expectedKnowledgeBaseId) return 0;
  const factHits = expectedFactHits(hit, test);
  const factsRelevant = factHits >= Math.max(1, Number(test.minHits) || 1);
  const sources = test.expectedSources || [];
  const sourceRelevant = sources.length ? expectedSourceMatch(hit, test) : true;
  if (factsRelevant && sourceRelevant) return 3;
  if (factsRelevant) return 2;
  if (sourceRelevant) return 1;
  return 0;
}

function discountedGain(grades) {
  return grades.reduce((sum, grade, index) => sum + ((2 ** grade) - 1) / Math.log2(index + 2), 0);
}

export function evaluateRankedHits(test, hits, expectedKnowledgeBaseId) {
  const grades = (hits || []).slice(0, 5).map((hit) => relevanceGrade(hit, test, expectedKnowledgeBaseId));
  const firstRelevant = grades.findIndex((grade) => grade >= 2);
  const idealGain = discountedGain([3]);
  return {
    grades,
    hitAt1: grades.slice(0, 1).some((grade) => grade >= 2),
    hitAt3: grades.slice(0, 3).some((grade) => grade >= 2),
    hitAt5: grades.some((grade) => grade >= 2),
    reciprocalRankAt5: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
    ndcgAt5: idealGain > 0 ? Math.min(1, discountedGain(grades) / idealGain) : 0,
  };
}

function safeScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? score : 0;
}

function thresholdStats(rows, threshold) {
  let grounded = 0;
  let abstain = 0;
  let groundedCorrect = 0;
  let abstainCorrect = 0;
  for (const row of rows) {
    const shouldGround = row.answerMode !== "abstain";
    const predictsGround = safeScore(row.topScore) >= threshold;
    if (shouldGround) {
      grounded += 1;
      if (predictsGround) groundedCorrect += 1;
    } else {
      abstain += 1;
      if (!predictsGround) abstainCorrect += 1;
    }
  }
  const truePositiveRate = grounded ? groundedCorrect / grounded : 1;
  const trueNegativeRate = abstain ? abstainCorrect / abstain : 1;
  return {
    threshold,
    balancedAccuracy: (truePositiveRate + trueNegativeRate) / 2,
    accuracy: rows.length ? (groundedCorrect + abstainCorrect) / rows.length : 1,
    groundedCorrect,
    grounded,
    abstainCorrect,
    abstain,
    falseAnswers: abstain - abstainCorrect,
  };
}

export function calibrateEvidenceThreshold(rows) {
  const scores = [...new Set(rows.map((row) => safeScore(row.topScore)))].sort((left, right) => left - right);
  const candidates = scores.length
    ? [scores[0] - Number.EPSILON, ...scores.slice(0, -1).map((score, index) => (score + scores[index + 1]) / 2), scores.at(-1) + Number.EPSILON]
    : [0];
  const ranked = candidates.map((threshold) => thresholdStats(rows, threshold)).sort((left, right) => (
    right.balancedAccuracy - left.balancedAccuracy
      || left.falseAnswers - right.falseAnswers
      || right.accuracy - left.accuracy
      || right.threshold - left.threshold
  ));
  return ranked[0];
}

function summarizeRows(rows, threshold) {
  const groundedRows = rows.filter((row) => row.answerMode !== "abstain");
  const abstainRows = rows.filter((row) => row.answerMode === "abstain");
  const thresholdResult = thresholdStats(rows, threshold);
  const count = (key) => groundedRows.filter((row) => row.metrics[key]).length;
  const average = (key) => groundedRows.length
    ? groundedRows.reduce((sum, row) => sum + Number(row.metrics[key] || 0), 0) / groundedRows.length
    : 0;
  return {
    total: rows.length,
    grounded: groundedRows.length,
    abstain: abstainRows.length,
    hitAt1: count("hitAt1"),
    hitAt3: count("hitAt3"),
    hitAt5: count("hitAt5"),
    hitAt1Rate: groundedRows.length ? count("hitAt1") / groundedRows.length : 0,
    hitAt3Rate: groundedRows.length ? count("hitAt3") / groundedRows.length : 0,
    hitAt5Rate: groundedRows.length ? count("hitAt5") / groundedRows.length : 0,
    mrrAt5: average("reciprocalRankAt5"),
    ndcgAt5: average("ndcgAt5"),
    abstentionAccuracy: abstainRows.length ? thresholdResult.abstainCorrect / abstainRows.length : 1,
    evidenceGate: thresholdResult,
    latencyMs: {
      p50: percentile(rows.map((row) => row.latencyMs), 0.5),
      p95: percentile(rows.map((row) => row.latencyMs), 0.95),
      p99: percentile(rows.map((row) => row.latencyMs), 0.99),
    },
    failures: {
      hitAt1: groundedRows.filter((row) => !row.metrics.hitAt1).map((row) => row.id),
      hitAt3: groundedRows.filter((row) => !row.metrics.hitAt3).map((row) => row.id),
      hitAt5: groundedRows.filter((row) => !row.metrics.hitAt5).map((row) => row.id),
      abstention: abstainRows.filter((row) => safeScore(row.topScore) >= threshold).map((row) => row.id),
    },
  };
}

export function summarizeModeRows(rows) {
  const devRows = rows.filter((row) => row.split === "dev");
  const calibration = calibrateEvidenceThreshold(devRows);
  const categories = [...new Set(rows.map((row) => row.category))].sort();
  return {
    thresholdCalibratedOn: "dev",
    evidenceThreshold: calibration.threshold,
    calibration,
    overall: summarizeRows(rows, calibration.threshold),
    dev: summarizeRows(devRows, calibration.threshold),
    test: summarizeRows(rows.filter((row) => row.split === "test"), calibration.threshold),
    byCategory: Object.fromEntries(categories.map((category) => [
      category,
      summarizeRows(rows.filter((row) => row.category === category), calibration.threshold),
    ])),
  };
}

export function compactRetrievalHit(hit, test, expectedKnowledgeBaseId) {
  return {
    id: hit?.id,
    parentId: hit?.parentId,
    matchedChunkId: hit?.matchedChunkId,
    knowledgeBaseId: hit?.knowledgeBaseId,
    retrieval: hit?.retrieval,
    score: safeScore(hit?.score),
    bm25Score: safeScore(hit?.bm25Score || hit?.keywordScore),
    semanticScore: safeScore(hit?.semanticScore),
    rerankerScore: Number.isFinite(Number(hit?.rerankerScore)) ? Number(hit.rerankerScore) : null,
    originalScore: Number.isFinite(Number(hit?.originalScore)) ? Number(hit.originalScore) : null,
    relevanceGrade: relevanceGrade(hit, test, expectedKnowledgeBaseId),
    expectedFactHits: expectedFactHits(hit, test),
    expectedSourceMatch: expectedSourceMatch(hit, test),
    sourceRef: hit?.sourceRef,
    rerankerStatus: hit?.rerankerStatus || "",
    preview: String(hit?.content || "").replace(/\s+/g, " ").slice(0, 140),
  };
}
