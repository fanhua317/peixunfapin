import { AI_PROFILE } from "./config.mjs";
import { askLlmStructured } from "./llm-json.mjs";
import { allowedSourceRefs, normalizeSourceRefs, renderContext, selectContextChunksHybrid } from "./context.mjs";
import { cleanReadableText, modelRequiredError, uniqueStrings } from "./text-utils.mjs";

function conciseOption(value, maxLength = 58) {
  return cleanReadableText(value, maxLength)
    .replace(/^[A-D][.、:：]\s*/i, "")
    .trim();
}

function resolveCorrectAnswer(raw, options) {
  const value = String(raw?.correctAnswer || raw?.answer || "").trim();
  const letter = value.match(/^[A-D]$/i)?.[0]?.toUpperCase();
  if (letter) {
    const index = letter.charCodeAt(0) - 65;
    if (options[index]) return options[index];
  }
  return conciseOption(value || options[0] || "以上说法符合培训资料");
}

function explanationWithSource(explanation, sourceRef) {
  const text = cleanReadableText(explanation, 260);
  if (!sourceRef) return text || "解析依据培训资料。";
  if (text.includes(sourceRef)) return text;
  return `${text || "解析依据培训资料。"} 来源：${sourceRef}`;
}

function normalizeQuestionStrict(raw, index, task, chunks) {
  const requestedType = task.quizType === "true_false" ? "true_false" : "single_choice";
  const sourceRefs = allowedSourceRefs(chunks);
  const sourceRef = normalizeSourceRefs([raw?.sourceRef], chunks)[0] || sourceRefs[index % Math.max(sourceRefs.length, 1)] || "培训资料";
  const type = raw?.type === "true_false" || requestedType === "true_false" ? "true_false" : "single_choice";
  const prompt = cleanReadableText(raw?.prompt, 150) || `关于${sourceRef}中的培训要点，哪项说法正确？`;
  if (type === "true_false") {
    const answerText = String(raw?.correctAnswer || raw?.answer || "正确");
    const correctAnswer = /错|false|错误/i.test(answerText) ? "错误" : "正确";
    return {
      type,
      prompt,
      options: ["正确", "错误"],
      correctAnswer,
      explanation: explanationWithSource(raw?.explanation, sourceRef),
      sourceRef,
    };
  }
  const rawOptions = Array.isArray(raw?.options) ? raw.options.map((option) => conciseOption(option)).filter(Boolean) : [];
  const correctAnswer = resolveCorrectAnswer(raw, rawOptions);
  const options = uniqueStrings([correctAnswer, ...rawOptions]).slice(0, 4);
  for (const option of ["只看价格不核对参数", "忽略客户实际需求", "不需要依据资料判断", "跳过质量和工艺说明"]) {
    if (options.length >= 4) break;
    if (option !== correctAnswer) options.push(option);
  }
  return {
    type,
    prompt,
    options: options.slice(0, 4),
    correctAnswer,
    explanation: explanationWithSource(raw?.explanation, sourceRef),
    sourceRef,
  };
}

async function generateQuizQuestionsStrict(state, task) {
  const count = Math.max(1, Math.min(Number(task.quizCount) || 10, 50));
  const chunks = await selectContextChunksHybrid(state, {
    knowledgeBaseId: task.knowledgeBaseId,
    query: `${task.title} ${task.instruction}`,
    limit: Math.max(10, Math.min(count + 6, 24)),
  });
  if (!chunks.length) throw new Error("knowledge base has no usable chunks for quiz generation");
  const sourceRefs = allowedSourceRefs(chunks);
  const profile = AI_PROFILE.quiz;
  const quizSchema = {
    questions: [
      {
        type: "single_choice",
        prompt: "题干，考察一个具体知识点",
        options: ["短选项A", "短选项B", "短选项C", "短选项D"],
        correctAnswer: "必须完全等于某个选项",
        explanation: "解释为什么正确，并写明来源",
        sourceRef: "必须来自给定来源列表",
      },
    ],
  };
  const prompt = `你是企业培训考试出题专家。请严格依据资料生成题目，不要编造资料外事实。

要求：
- 只输出 JSON，不要 Markdown。
- 题干必须考察一个具体知识点，不能截取大段原文。
- 单选题必须有 4 个短选项，correctAnswer 必须完全等于某个 options。
- 错误选项要短，但不能离谱到一眼无效。
- explanation 必须说明为什么正确，并包含来源。
- sourceRef 必须从这个列表中选择：${JSON.stringify(sourceRefs)}

输出格式：${JSON.stringify(quizSchema)}

题目数量：${count}
题型要求：${task.quizType || "single_choice"}
任务：${JSON.stringify(task)}
资料上下文：
${renderContext(chunks)}`;
  try {
    const result = await askLlmStructured({ purpose: `quiz:${task.id}`, prompt, profile, repairSchema: quizSchema });
    if (!result.data) throw modelRequiredError("考试出题", result.error || "大模型未返回结构化题目");
    const rawQuestions = Array.isArray(result.data.questions) ? result.data.questions : [];
    const normalized = rawQuestions
      .map((question, index) => normalizeQuestionStrict(question, index, task, chunks))
      .filter((question) => question.prompt && question.options.length >= 2 && question.sourceRef);
    return {
      questions: normalized.slice(0, count),
      source: result.source || "openclaw",
      thinking: result.thinking || profile.thinking,
      model: result.model || profile.model,
      sessionPatch: result.sessionPatch,
      runId: result.runId,
    };
  } catch (error) {
    throw modelRequiredError("考试出题", error);
  }
}

export async function generateQuizQuestions(state, task) {
  return await generateQuizQuestionsStrict(state, task);
}
