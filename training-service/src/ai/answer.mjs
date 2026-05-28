import { searchChunks, searchKnowledgeContexts } from "../rag.mjs";
import { ANSWER_CONTEXT_LIMIT, AI_PROFILE } from "./config.mjs";
import { askLlmStructured } from "./llm-json.mjs";
import {
  allowedSourceRefs,
  normalizeSourceRefs,
  refineContextChunks,
  renderContext,
  retrievalConfidence,
  retrievalModeFromChunks,
  sourceObjects,
} from "./context.mjs";
import {
  cleanAnswerText,
  cleanReadableText,
  cleanTrainingText,
  modelRequiredError,
  splitTrainingSentences,
  stripCodeFence,
  uniqueStrings,
} from "./text-utils.mjs";

function buildAnswerQuality({ chunks, answer, sourceRefs, warnings = [], generatedBy = "" }) {
  const hasAnswer = cleanReadableText(answer, 1200).length >= 12;
  const hasSources = sourceRefs.length > 0 && chunks.length > 0;
  const status = !hasAnswer || !hasSources ? "insufficient" : warnings.length ? "limited" : "ok";
  return {
    status,
    generatedBy,
    retrievalMode: retrievalModeFromChunks(chunks),
    sourceCount: sourceRefs.length,
    answerChars: String(answer || "").length,
    warnings,
  };
}

function withAnswerMetadata(payload, chunks, extra = {}) {
  const sourceRefs = normalizeSourceRefs(payload.sourceRefs || chunks.map((chunk) => chunk.sourceRef), chunks);
  const warnings = uniqueStrings([...(payload.warnings || []), ...(extra.warnings || [])]);
  const usedSources = sourceObjects(chunks).filter((source) => sourceRefs.includes(source.sourceRef));
  return {
    ...payload,
    sourceRefs,
    usedSources,
    retrievalMode: retrievalModeFromChunks(chunks),
    answerQuality: buildAnswerQuality({
      chunks,
      answer: payload.answer,
      sourceRefs,
      warnings,
      generatedBy: payload.generatedBy || extra.generatedBy || "",
    }),
    warnings,
  };
}

function answerFromOpenClawText(raw, chunks, result) {
  const answer = cleanAnswerText(stripCodeFence(raw));
  if (!answer) throw modelRequiredError("资料答疑", "大模型没有返回可显示内容");
  return {
    answer,
    keyPoints: splitTrainingSentences(answer, 6),
    caveats: [],
    sources: sourceObjects(chunks),
    sourceRefs: uniqueStrings(chunks.map((chunk) => chunk.sourceRef)).slice(0, 8),
    confidence: "medium",
    generatedBy: "openclaw-text",
    thinking: result.thinking || AI_PROFILE.answer.thinking,
    model: result.model || AI_PROFILE.answer.model,
    sessionPatch: result.sessionPatch,
    runId: result.runId,
    parseWarning: result.error,
  };
}

async function generateStrictKnowledgeAnswer({ knowledgeBaseId, question, chunks }) {
  const profile = AI_PROFILE.answer;
  const allowedRefs = allowedSourceRefs(chunks);
  const answerSchema = {
    answer: "直接回答，80-260字，只能依据资料，不照抄大段原文",
    keyPoints: ["2-4个可培训的要点"],
    caveats: ["资料不足或需要注意的地方"],
    sourceRefs: ["必须来自给定来源列表"],
  };
  const prompt = `你是企业培训资料答疑助手。请只依据给定资料回答，不要补充资料外事实，不要写成营销文案，不要照抄大段原文。

输出要求：
- 只能输出 JSON，不要 Markdown。
- answer 要先直接回答问题，控制在 80-260 字。
- keyPoints 写 2-4 个员工容易理解的短要点。
- sourceRefs 必须从这个列表中选择：${JSON.stringify(allowedRefs)}
- 如果资料不足，明确写在 caveats 中，不要强行推断。

输出格式：${JSON.stringify(answerSchema)}

问题：${JSON.stringify(question)}
资料上下文：
${renderContext(chunks)}`;

  try {
    const result = await askLlmStructured({ purpose: `answer:${knowledgeBaseId}`, prompt, profile, repairSchema: answerSchema });
    if (!result.data) {
      throw modelRequiredError("资料答疑", result.error || "大模型未返回结构化答案");
    }
    const data = result.data || {};
    const answer = cleanAnswerText(data.answer);
    const warnings = [];
    if (!answer) warnings.push("empty_answer");
    if (!uniqueStrings(data.sourceRefs).length) warnings.push("model_missing_source_refs");
    if (answer.length > 900) warnings.push("answer_too_long");
    return withAnswerMetadata({
      answer,
      keyPoints: uniqueStrings(data.keyPoints).map((item) => cleanTrainingText(item)).filter(Boolean).slice(0, 6),
      caveats: uniqueStrings(data.caveats).map((item) => cleanTrainingText(item)).filter(Boolean).slice(0, 4),
      sources: sourceObjects(chunks),
      sourceRefs: normalizeSourceRefs(data.sourceRefs, chunks),
      confidence: retrievalConfidence(chunks, "high", "medium"),
      generatedBy: result.source || "openclaw",
      thinking: result.thinking || profile.thinking,
      model: result.model || profile.model,
      sessionPatch: result.sessionPatch,
      runId: result.runId,
      repaired: result.repaired === true,
      warnings,
    }, chunks);
  } catch (error) {
    throw modelRequiredError("资料答疑", error);
  }
}

export async function generateKnowledgeAnswer(state, { knowledgeBaseId, question }) {
  const text = String(question || "").trim();
  if (!text) {
    return {
      answer: "请先输入你想咨询的资料问题。",
      keyPoints: [],
      caveats: [],
      sources: [],
      confidence: "low",
      generatedBy: "none",
    };
  }
  let chunks = [];
  try {
    chunks = await searchKnowledgeContexts(state, {
      knowledgeBaseId,
      query: text,
      limit: 8,
    });
  } catch {
    chunks = searchChunks(state, {
      knowledgeBaseId,
      query: text,
      limit: 8,
    });
  }
  if (!chunks.length) {
    chunks = searchChunks(state, {
      knowledgeBaseId,
      query: text,
      limit: 8,
    });
  }
  chunks = refineContextChunks(chunks, text, ANSWER_CONTEXT_LIMIT);
  if (!chunks.length) throw new Error("当前知识库没有检索到足够相关的资料，已停止回答。");
  return await generateStrictKnowledgeAnswer({ knowledgeBaseId, question: text, chunks });
}
