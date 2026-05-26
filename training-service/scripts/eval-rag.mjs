import { loadState } from "../src/store.mjs";
import { getRuntimeHealth } from "../src/health.mjs";
import { searchChunks, searchChunksHybrid } from "../src/rag.mjs";
import { generateKnowledgeAnswer } from "../src/ai/index.mjs";

const args = new Set(process.argv.slice(2));
const includeAnswers = !args.has("--no-answer") && !args.has("--retrieval-only");

const tests = [
  {
    id: "ye3-ie3-four-business-row",
    query: "YE3 IE3 4级 功率范围",
    expected: ["YE3", "IE3", "级数: 4", "功率范围"],
  },
  {
    id: "motor-structure-knowledge-point",
    query: "三相异步电动机结构",
    expected: ["三相异步电动机", "定子", "转子"],
  },
  {
    id: "stator-rotor-sales-training",
    query: "定子转子销售培训",
    expected: ["定子", "转子", "销售"],
  },
  {
    id: "casting-loss",
    query: "电机附加损耗和低压铸铝、离心铸铝、压力铸铝有什么关系？",
    expected: ["附加损耗", "低压铸铝", "离心铸铝", "压力铸铝"],
  },
  {
    id: "broken-bar",
    query: "铸铝断条检测仪在品质管理里是做什么的？",
    expected: ["铸铝断条检测仪", "不良转子"],
  },
  {
    id: "iron-loss",
    query: "铁损检测仪主要控制哪一类原材料质量？",
    expected: ["铁损检测仪", "硅钢片"],
  },
  {
    id: "ye4-six",
    query: "YE4 六级铁壳电机的机座范围和功率范围是多少？",
    expected: ["YE4", "级数: 6", "机座范围", "功率范围"],
  },
  {
    id: "ye3-six",
    query: "YE3 六级铁壳电机的机座范围和功率范围是多少？",
    expected: ["YE3", "级数: 6", "机座范围", "功率范围"],
  },
  {
    id: "y2-four",
    query: "Y2 四级铁壳电机的机座范围和功率范围是多少？",
    expected: ["Y2", "级数: 4", "机座范围", "功率范围"],
  },
  {
    id: "five-process",
    query: "银嘉五项领先制造工艺包括哪些？",
    expected: ["五项领先制造工艺", "铝转子铸铝工艺"],
  },
  {
    id: "english-rotor",
    query: "High-Conductivity Rotor Aluminum Casting 是什么意思，对应哪项工艺？",
    expected: ["High-Conductivity Rotor Aluminum Casting", "高导电率铝转子铸铝工艺"],
  },
  {
    id: "patent",
    query: "低压铸铝相关的发明专利号是什么？",
    expected: ["低压铸", "发明专利", "ZL201810801154.9"],
  },
  {
    id: "cast-rotor",
    query: "铸铝转子是怎么形成一个整体的？",
    expected: ["铸铝转子", "导条", "端环"],
  },
  {
    id: "product-intro",
    query: "销售介绍产品时为什么不要单一讲专业知识？",
    expected: ["不要单一讲产品的专业知识", "客户", "产品"],
  },
];

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
for (const test of tests) {
  const hybrid = await searchChunksHybrid(state, { knowledgeBaseId: knowledgeBase.id, query: test.query, limit: 5 });
  const bm25 = searchChunks(state, { knowledgeBaseId: knowledgeBase.id, query: test.query, limit: 5 });
  const threshold = Math.min(2, test.expected.length);
  const hybridScores = hybrid.map((hit) => expectedHits(hit, test.expected));
  const bm25Scores = bm25.map((hit) => expectedHits(hit, test.expected));
  const row = {
    id: test.id,
    query: test.query,
    expected: test.expected,
    hybridTop1Relevant: (hybridScores[0] || 0) >= threshold,
    hybridTop3Relevant: hybridScores.slice(0, 3).some((score) => score >= threshold),
    hybridTop1ExpectedHits: hybridScores[0] || 0,
    bm25Top1ExpectedHits: bm25Scores[0] || 0,
    hybridTop3: hybrid.slice(0, 3).map((hit) => compactHit(hit, test.expected)),
    bm25Top3: bm25.slice(0, 3).map((hit) => compactHit(hit, test.expected)),
  };
  if (includeAnswers) {
    const answer = await generateKnowledgeAnswer(state, { knowledgeBaseId: knowledgeBase.id, question: test.query });
    row.answer = answerChecks(answer);
  }
  rows.push(row);
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
    hybridTop1Relevant: rows.filter((row) => row.hybridTop1Relevant).length,
    hybridTop3Relevant: rows.filter((row) => row.hybridTop3Relevant).length,
    hybridTop1BetterOrEqualBm25: rows.filter((row) => row.hybridTop1ExpectedHits >= row.bm25Top1ExpectedHits).length,
  },
  answers: includeAnswers ? {
    total: answerRows.length,
    ok: answerRows.filter((row) => row.answer.ok).length,
    failed: answerRows.filter((row) => !row.answer.ok).map((row) => ({ id: row.id, warnings: row.answer.warnings })),
  } : null,
};

summary.ok = summary.retrieval.hybridTop3Relevant >= Math.ceil(rows.length * 0.8)
  && (!includeAnswers || summary.answers.failed.length === 0);

console.log(JSON.stringify({ summary, rows }, null, 2));

if (!summary.ok) {
  process.exitCode = 1;
}
