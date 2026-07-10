import http from "node:http";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let llmCalls = 0;
const mockLlm = http.createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  llmCalls += 1;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: JSON.stringify({
          answer: "这是一条不应生成的答案。",
          keyPoints: ["不应调用模型"],
          caveats: [],
          sourceRefs: ["motor-insulation.md#formula"],
          webSourceRefs: [],
        }),
      },
      finish_reason: "stop",
    }],
  }));
});

await new Promise((resolve, reject) => {
  mockLlm.once("error", reject);
  mockLlm.listen(0, "127.0.0.1", () => {
    mockLlm.off("error", reject);
    resolve();
  });
});

const address = mockLlm.address();
process.env.TRAINING_HYBRID_RETRIEVAL = "0";
process.env.TRAINING_RERANKER_ENABLED = "0";
process.env.TRAINING_LLM_PROVIDER = "openai-compatible";
process.env.TRAINING_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
process.env.TRAINING_LLM_API_KEY = "evidence-gate-eval-key";
process.env.TRAINING_LLM_MODEL = "evidence-gate-mock";

const state = {
  knowledgeBases: [{ id: "kb-motor", name: "电机培训资料", status: "ready" }],
  documents: [{ id: "doc-motor", knowledgeBaseId: "kb-motor", name: "绝缘工艺说明" }],
  chunkParents: [],
  chunks: [{
    id: "chunk-motor-insulation",
    knowledgeBaseId: "kb-motor",
    documentId: "doc-motor",
    heading: "电机绝缘漆工艺",
    sourceRef: "motor-insulation.md#formula",
    content: "电机绝缘漆配方由工艺部门按耐热等级管理，生产人员应核对树脂批次、浸漆温度和固化周期。这段资料仅用于内部电机制造工艺培训。",
    searchText: "电机 绝缘漆 配方 耐热等级 树脂 浸漆 固化周期 制造工艺",
  }, {
    id: "chunk-product-advantages-distractor",
    knowledgeBaseId: "kb-motor",
    documentId: "doc-motor",
    heading: "产品优势",
    sourceRef: "product-advantages.md#machining",
    content: "叶轮轮毂孔、键槽和基准面的高精度加工能保证配合公差，并推迟汽蚀发生时间，降低维护成本。",
    searchText: "产品优势 基准面的高精度加工 配合公差 汽蚀发生时间 维护成本",
  }],
};

const cases = [
  { id: "motor-world-cup", query: "电机世界杯冠军是谁？" },
  { id: "no-answer-pasta", query: "正宗意大利培根蛋面的配方和烹饪时间是什么？" },
];
const results = [];

try {
  const { executeWebSkill } = await import("../src/tools/registry.mjs");
  const { assessEvidenceSufficiency, hasExactIdentifierEvidence } = await import("../src/rag.mjs");
  const { evaluateAnswerQuality } = await import("./evaluation/answer-quality.mjs");
  for (const item of cases) {
    const callsBefore = llmCalls;
    const payload = await executeWebSkill("answer_knowledge_question", {
      state,
      message: item.query,
      decision: {
        intent: "answer_knowledge_question",
        skill: "answer_knowledge_question",
        knowledgeBaseId: "kb-motor",
      },
      webSearchMode: "off",
    });
    assert(payload.insufficient === true, `${item.id}: insufficient evidence must be refused`);
    assert(payload.generatedBy === "none", `${item.id}: refusal must not be model-generated`);
    assert((payload.sourceRefs || []).length === 0, `${item.id}: refusal cited an unrelated source`);
    assert((payload.sources || []).length === 0, `${item.id}: refusal returned unrelated source objects`);
    assert((payload.usedSources || []).length === 0, `${item.id}: refusal returned unrelated usedSources`);
    assert(llmCalls === callsBefore, `${item.id}: insufficient evidence still invoked the LLM`);
    results.push({ id: item.id, ok: true });
  }
  const definitionEvidence = assessEvidenceSufficiency([{
    id: "parent-motor-definition",
    sourceRef: "motor-basics.md#definition",
    content: "电机是一种把电能转换为机械能的装置。",
    matchedPreview: "电机是一种把电能转换为机械能的装置。",
    bm25Score: 4.08,
  }], "给王小明讲一下电机是什么");
  assert(definitionEvidence.sufficient === true, "definition question filler terms diluted valid evidence");
  results.push({ id: "definition-question-with-instruction-filler", ok: true });
  const widerIdentifierCandidates = [{
    id: "unrelated-top-window",
    sourceRef: "generic.md",
    content: "普通产品概览，没有目标型号。",
  }, {
    id: "exact-candidate-outside-window",
    sourceRef: "YE4-160M.md",
    content: "型号 YE4-160M，证据编号 JZ-EVIDENCE-000777，额定功率 11 kW。",
  }];
  assert(
    hasExactIdentifierEvidence(widerIdentifierCandidates, "YE4-160M JZ-EVIDENCE-000777 的额定功率是多少？") === true,
    "exact identifiers in the wider candidate pool must be eligible for reranking",
  );
  assert(
    hasExactIdentifierEvidence(widerIdentifierCandidates, "ZXQ-999 JZ-EVIDENCE-999999 的保修期是多少？") === false,
    "fabricated identifiers must not bypass the pre-rerank evidence gate",
  );
  results.push({ id: "reranker-exact-identifier-pre-gate", ok: true });
  const abstainFixture = {
    id: "abstain-quality-contract",
    split: "test",
    knowledgeBase: "kb-motor",
    answerMode: "abstain",
    expectedFacts: [],
    expectedSources: [],
    forbiddenFacts: ["世界杯冠军"],
    minHits: 0,
  };
  const networkFailure = evaluateAnswerQuality(state, abstainFixture, { error: new Error("fetch failed") });
  assert(networkFailure.ok === false, "network/model errors must not count as correct refusals");
  const citedRefusal = evaluateAnswerQuality(state, abstainFixture, {
    answer: { answer: "资料不足，无法回答。", sourceRefs: ["motor-insulation.md#formula"] },
  });
  assert(citedRefusal.ok === false, "a refusal with an unrelated citation must fail");
  const cleanRefusal = evaluateAnswerQuality(state, abstainFixture, {
    answer: { answer: "当前资料不足，无法确认。", sourceRefs: [] },
  });
  assert(cleanRefusal.ok === true, "a clean explicit evidence refusal should pass");
  results.push({ id: "answer-quality-refusal-contract", ok: true });
  assert(llmCalls === 0, `evidence gate regression invoked the LLM ${llmCalls} time(s)`);
  console.log(JSON.stringify({ ok: true, llmCalls, results }, null, 2));
} catch (error) {
  console.error(error);
  console.log(JSON.stringify({ ok: false, llmCalls, results }, null, 2));
  process.exitCode = 1;
} finally {
  await new Promise((resolve, reject) => mockLlm.close((error) => (error ? reject(error) : resolve())));
}
