import {
  motorExactParameterCases,
  motorMultilingualCases,
  motorSemanticCases,
} from "./rag-eval-motor-cases.mjs";
import {
  pumpExactParameterCases,
  pumpMultilingualCases,
  pumpSemanticCases,
} from "./rag-eval-pump-cases.mjs";
import {
  crossKnowledgeBaseCases,
  noAnswerCases,
} from "./rag-eval-adversarial-cases.mjs";
import { RAG_EVAL_SCHEMA_FIELDS } from "./rag-eval-case-builder.mjs";

export const RAG_EVAL_THRESHOLDS = Object.freeze({
  total: 150,
  dev: 120,
  test: 30,
  answerQuality: 60,
  groundedAnswers: 45,
  abstentionAnswers: 15,
  hybridTestHit3Rate: 0.9,
  rerankerMaxHit3Regression: 1,
  answerFaithfulnessRate: 0.9,
  citationPrecision: 1,
  citationRecall: 0.9,
  correctAbstentions: 14,
});

export const RAG_EVAL_CATEGORY_COUNTS = Object.freeze({
  "exact-parameter": 60,
  "semantic-principle": 30,
  multilingual: 20,
  "cross-kb-hard-negative": 20,
  "no-answer": 20,
});

export const ragEvalCases = Object.freeze([
  ...motorExactParameterCases,
  ...pumpExactParameterCases,
  ...motorSemanticCases,
  ...pumpSemanticCases,
  ...motorMultilingualCases,
  ...pumpMultilingualCases,
  ...crossKnowledgeBaseCases,
  ...noAnswerCases,
]);

function countBy(items, key) {
  return items.reduce((counts, item) => ({
    ...counts,
    [item[key]]: (counts[item[key]] || 0) + 1,
  }), {});
}

export function validateRagEvalCases(cases = ragEvalCases) {
  const errors = [];
  const ids = new Set();
  for (const [index, item] of cases.entries()) {
    for (const field of RAG_EVAL_SCHEMA_FIELDS) {
      if (!(field in item)) errors.push(`case[${index}] missing ${field}`);
    }
    if (!item.id) errors.push(`case[${index}] has empty id`);
    if (ids.has(item.id)) errors.push(`duplicate id: ${item.id}`);
    ids.add(item.id);
    if (!["dev", "test"].includes(item.split)) errors.push(`${item.id}: invalid split ${item.split}`);
    if (!["grounded", "abstain"].includes(item.answerMode)) errors.push(`${item.id}: invalid answerMode ${item.answerMode}`);
    for (const field of ["expectedFacts", "expectedSources", "forbiddenFacts", "tags"]) {
      if (!Array.isArray(item[field])) errors.push(`${item.id}: ${field} must be an array`);
    }
  }

  const splits = countBy(cases, "split");
  const categories = countBy(cases, "category");
  const answerCases = cases.filter((item) => item.tags.includes("answer-quality"));
  const groundedAnswers = answerCases.filter((item) => item.answerMode === "grounded").length;
  const abstentionAnswers = answerCases.filter((item) => item.answerMode === "abstain").length;
  if (cases.length !== RAG_EVAL_THRESHOLDS.total) errors.push(`expected ${RAG_EVAL_THRESHOLDS.total} cases, got ${cases.length}`);
  if (splits.dev !== RAG_EVAL_THRESHOLDS.dev) errors.push(`expected ${RAG_EVAL_THRESHOLDS.dev} dev cases, got ${splits.dev || 0}`);
  if (splits.test !== RAG_EVAL_THRESHOLDS.test) errors.push(`expected ${RAG_EVAL_THRESHOLDS.test} test cases, got ${splits.test || 0}`);
  for (const [category, expected] of Object.entries(RAG_EVAL_CATEGORY_COUNTS)) {
    if (categories[category] !== expected) errors.push(`expected ${expected} ${category} cases, got ${categories[category] || 0}`);
  }
  if (answerCases.length !== RAG_EVAL_THRESHOLDS.answerQuality) errors.push(`expected ${RAG_EVAL_THRESHOLDS.answerQuality} answer cases, got ${answerCases.length}`);
  if (groundedAnswers !== RAG_EVAL_THRESHOLDS.groundedAnswers) errors.push(`expected ${RAG_EVAL_THRESHOLDS.groundedAnswers} grounded answer cases, got ${groundedAnswers}`);
  if (abstentionAnswers !== RAG_EVAL_THRESHOLDS.abstentionAnswers) errors.push(`expected ${RAG_EVAL_THRESHOLDS.abstentionAnswers} abstention answer cases, got ${abstentionAnswers}`);

  return {
    ok: errors.length === 0,
    errors,
    counts: {
      total: cases.length,
      splits,
      categories,
      answerQuality: answerCases.length,
      groundedAnswers,
      abstentionAnswers,
    },
  };
}
