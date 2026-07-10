export const RAG_EVAL_SCHEMA_FIELDS = [
  "id",
  "split",
  "domain",
  "category",
  "query",
  "knowledgeBase",
  "expectedFacts",
  "expectedSources",
  "forbiddenFacts",
  "answerMode",
  "minHits",
  "tags",
];

export function defineRagCase(input) {
  const value = {
    id: String(input.id || "").trim(),
    split: input.split,
    domain: input.domain,
    category: input.category,
    query: String(input.query || "").trim(),
    knowledgeBase: input.knowledgeBase,
    expectedFacts: [...(input.expectedFacts || [])],
    expectedSources: [...(input.expectedSources || [])],
    forbiddenFacts: [...(input.forbiddenFacts || [])],
    answerMode: input.answerMode || "grounded",
    minHits: Number.isFinite(input.minHits) ? input.minHits : 1,
    tags: [...(input.tags || [])],
  };
  return Object.freeze(value);
}

export function splitFor(index, developmentCount) {
  return index < developmentCount ? "dev" : "test";
}
