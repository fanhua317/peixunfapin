import { makeId } from "../store.mjs";
import { chunkToLearningPoints, cleanQuestionText } from "../quality.mjs";

export function buildFallbackQuestionFromChunk(chunk, index, quizType) {
  const points = chunkToLearningPoints(chunk, 4);
  const correctOption = cleanQuestionText(points[0] || chunk.content || "该说法符合培训资料", 64);
  const sourceRef = chunk.sourceRef || "培训资料";
  const heading = cleanQuestionText(chunk.heading || chunk.metadata?.section || "培训内容", 32);

  if (quizType === "true_false") {
    const correct = index % 2 === 0;
    return {
      id: makeId("question"),
      type: "true_false",
      prompt: correct ? `判断：${correctOption}` : `判断：${heading}可以脱离资料随意理解。`,
      options: ["正确", "错误"],
      correctAnswer: correct ? "正确" : "错误",
      explanation: correct ? `该说法来自资料。来源：${sourceRef}` : `培训判断必须依据资料，不能脱离来源。来源：${sourceRef}`,
      sourceRef,
    };
  }

  return {
    id: makeId("question"),
    type: "single_choice",
    prompt: `关于${heading}，哪项说法符合培训资料？`,
    options: [
      correctOption,
      "只看价格不核对参数",
      "忽略客户实际需求",
      "不需要依据资料判断",
    ],
    correctAnswer: correctOption,
    explanation: `正确答案依据资料中的对应要点。来源：${sourceRef}`,
    sourceRef,
  };
}
