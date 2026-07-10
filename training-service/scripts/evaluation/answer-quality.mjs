import { factMatches, resolveKnowledgeBase } from "./rag-metrics.mjs";

const REFUSAL_RE = /(?:没有|未能|未检索到|找不到|资料不足|信息不足|无法|不能).{0,24}(?:资料|信息|依据|回答|确定|确认)|(?:insufficient|not enough|no relevant|cannot answer|unable to determine|not available)|(?:aucune information|informations insuffisantes)|(?:недостаточно данных|нет данных)|(?:لا توجد معلومات|معلومات غير كافية)/i;

function answerText(answer) {
  return [
    answer?.answer,
    ...(answer?.keyPoints || []),
    ...(answer?.caveats || []),
    ...(answer?.warnings || []),
  ].filter(Boolean).join("\n");
}

function allKnownSourceRefs(state, knowledgeBaseId) {
  const refs = new Set();
  for (const item of [...(state.chunkParents || []), ...(state.chunks || [])]) {
    if (knowledgeBaseId && item.knowledgeBaseId !== knowledgeBaseId) continue;
    if (item.sourceRef) refs.add(String(item.sourceRef));
  }
  return refs;
}

function sourceMatchesExpected(sourceRef, expectedSources) {
  const normalized = String(sourceRef || "").normalize("NFKC").toLowerCase();
  return (expectedSources || []).some((source) => normalized.includes(String(source || "").normalize("NFKC").toLowerCase()));
}

function sourceSupportsExpectedFacts(state, sourceRef, test) {
  const items = [...(state.chunkParents || []), ...(state.chunks || [])]
    .filter((item) => String(item.sourceRef || "") === String(sourceRef || ""));
  return items.some((item) => {
    const text = `${item.sourceRef || ""}\n${item.heading || ""}\n${item.content || ""}\n${item.searchText || ""}`;
    const hits = (test.expectedFacts || []).filter((fact) => factMatches(text, fact)).length;
    return hits >= Math.max(1, Number(test.minHits) || 1);
  });
}

export function evaluateAnswerQuality(state, test, result = {}) {
  const expectedKnowledgeBase = resolveKnowledgeBase(state, test.knowledgeBase);
  const answer = result.answer || null;
  const error = result.error || null;
  const errorText = error ? (error instanceof Error ? error.message : String(error)) : "";
  const text = answerText(answer);
  const sourceRefs = Array.isArray(answer?.sourceRefs) ? answer.sourceRefs.map(String) : [];
  const knownSourceRefs = allKnownSourceRefs(state, expectedKnowledgeBase?.id || null);
  const matchedFacts = (test.expectedFacts || []).filter((fact) => factMatches(text, fact));
  const forbiddenFacts = (test.forbiddenFacts || []).filter((fact) => factMatches(text, fact));
  const validSourceRefs = sourceRefs.filter((sourceRef) => knownSourceRefs.has(sourceRef));
  const citationRecall = (test.expectedSources || []).length === 0
    ? true
    : sourceRefs.some((sourceRef) => (
        sourceMatchesExpected(sourceRef, test.expectedSources)
          || sourceSupportsExpectedFacts(state, sourceRef, test)
      ));
  const refusalError = Boolean(error) && (
    String(error?.code || "").toUpperCase() === "INSUFFICIENT_EVIDENCE"
    || /insufficientevidence/i.test(String(error?.name || ""))
    || REFUSAL_RE.test(errorText)
  );
  const refused = refusalError || REFUSAL_RE.test(text);
  const requiredFactHits = Math.max(1, Math.min(Number(test.minHits) || 1, (test.expectedFacts || []).length || 1));

  if (test.answerMode === "abstain") {
    return {
      id: test.id,
      split: test.split,
      answerMode: test.answerMode,
      ok: refused && forbiddenFacts.length === 0 && sourceRefs.length === 0,
      refused,
      error: errorText,
      forbiddenFacts,
      sourceRefs,
      answerPreview: text.replace(/\s+/g, " ").slice(0, 200),
    };
  }

  const faithful = matchedFacts.length >= requiredFactHits && forbiddenFacts.length === 0;
  const citationPrecision = sourceRefs.length > 0 && validSourceRefs.length === sourceRefs.length;
  return {
    id: test.id,
    split: test.split,
    answerMode: test.answerMode,
    ok: !error && faithful && citationPrecision && citationRecall,
    faithful,
    expectedFactHits: matchedFacts.length,
    expectedFactTotal: (test.expectedFacts || []).length,
    requiredFactHits,
    matchedFacts,
    forbiddenFacts,
    citationPrecision,
    citationRecall,
    validSourceRefs: validSourceRefs.length,
    sourceRefs,
    error: errorText,
    answerPreview: text.replace(/\s+/g, " ").slice(0, 200),
  };
}

export function summarizeAnswerQuality(rows, thresholds) {
  const grounded = rows.filter((row) => row.answerMode === "grounded");
  const abstentions = rows.filter((row) => row.answerMode === "abstain");
  const totalRefs = grounded.reduce((sum, row) => sum + row.sourceRefs.length, 0);
  const validRefs = grounded.reduce((sum, row) => sum + row.validSourceRefs, 0);
  const faithful = grounded.filter((row) => row.faithful).length;
  const citationRecallCases = grounded.filter((row) => row.citationRecall).length;
  const correctAbstentions = abstentions.filter((row) => row.ok).length;
  const summary = {
    total: rows.length,
    grounded: grounded.length,
    abstentions: abstentions.length,
    faithful,
    faithfulnessRate: grounded.length ? faithful / grounded.length : 0,
    citationPrecision: totalRefs ? validRefs / totalRefs : 0,
    citationRecall: grounded.length ? citationRecallCases / grounded.length : 0,
    correctAbstentions,
    failed: rows.filter((row) => !row.ok).map((row) => ({
      id: row.id,
      error: row.error,
      expectedFactHits: row.expectedFactHits,
      requiredFactHits: row.requiredFactHits,
      citationPrecision: row.citationPrecision,
      citationRecall: row.citationRecall,
      refused: row.refused,
      forbiddenFacts: row.forbiddenFacts,
    })),
  };
  summary.ok = summary.total === thresholds.answerQuality
    && summary.grounded === thresholds.groundedAnswers
    && summary.abstentions === thresholds.abstentionAnswers
    && summary.faithfulnessRate >= thresholds.answerFaithfulnessRate
    && summary.citationPrecision >= thresholds.citationPrecision
    && summary.citationRecall >= thresholds.citationRecall
    && summary.correctAbstentions >= thresholds.correctAbstentions;
  return summary;
}
