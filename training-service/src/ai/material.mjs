import { AI_PROFILE } from "./config.mjs";
import { askLlmStructured } from "./llm-json.mjs";
import { getKnowledgeBase, renderContext, selectContextChunksHybrid } from "./context.mjs";
import {
  compactMultiline,
  compactText,
  looseJsonField,
  modelRequiredError,
  stripCodeFence,
  uniqueStrings,
} from "./text-utils.mjs";

function materialFromOpenClawText(raw, task, chunks, result) {
  const text = stripCodeFence(raw);
  const sourceRefs = chunks.map((chunk) => chunk.sourceRef);
  const markdownHeadings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .slice(0, 6);
  const jsonHeadings = [...text.matchAll(/"heading"\s*:\s*"([^"]+)"/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .slice(0, 6);
  const title = looseJsonField(text, "title") || task.title;
  const summary = looseJsonField(text, "summary") || compactText(text.replace(/^#+\s+/gm, "").split(/\n\s*\n/)[0], 360);
  const studyGuide = looseJsonField(text, "studyGuide") || looseJsonField(text, "study_guide") || text;
  const headings = markdownHeadings.length ? markdownHeadings : jsonHeadings;
  return {
    title: compactText(title, 120),
    summary: compactText(summary, 360),
    outline: headings.map((heading) => ({ heading, points: [] })),
    keyPoints: [],
    studyGuide: compactMultiline(studyGuide, 5000),
    practiceTips: [],
    sourceRefs,
    generatedBy: "openclaw-text",
    thinking: result.thinking || AI_PROFILE.material.thinking,
    model: result.model || AI_PROFILE.material.model,
    sessionPatch: result.sessionPatch,
    runId: result.runId,
    parseWarning: result.error,
    generatedAt: new Date().toISOString(),
  };
}

export async function generateTrainingMaterial(state, task) {
  const knowledgeBase = getKnowledgeBase(state, task.knowledgeBaseId);
  const chunks = await selectContextChunksHybrid(state, {
    knowledgeBaseId: task.knowledgeBaseId,
    query: `${task.title} ${task.instruction}`,
    limit: 14,
  });
  const context = renderContext(chunks);
  const profile = AI_PROFILE.material;
  const materialSchema = {
    title: "培训标题",
    summary: "150字以内摘要",
    outline: [{ heading: "模块标题", points: ["要点"] }],
    keyPoints: ["必须掌握点"],
    studyGuide: "面向员工的学习讲义，500-1200字",
    practiceTips: ["学习建议"],
    sourceRefs: ["引用来源"],
  };
  const prompt = `你是企业培训内容设计师。优先使用 DeepSeek V4 Flash（如当前 OpenClaw 会话配置可用）并使用 ${profile.thinking} 思考强度。根据资料为员工生成可学习的培训内容。\n\n只允许依据给定资料，不要编造资料外事实。只能输出 JSON，不要 Markdown 包裹。\n\n输出格式：\n{"title":"培训标题","summary":"150字以内摘要","outline":[{"heading":"模块标题","points":["要点1","要点2"]}],"keyPoints":["必须掌握点"],"studyGuide":"面向员工的学习讲义，500-1200字","practiceTips":["学习建议"],"sourceRefs":["引用来源"]}\n\n任务：${JSON.stringify(task)}\n知识库：${JSON.stringify(knowledgeBase)}\n资料上下文：\n${context}`;
  try {
    const result = await askLlmStructured({ purpose: `material:${task.id}`, prompt, profile, repairSchema: materialSchema });
    if (!result.data) return materialFromOpenClawText(result.raw, task, chunks, result);
    const material = result.data || {};
    return {
      title: compactText(material.title || task.title, 120),
      summary: compactText(material.summary, 360),
      outline: Array.isArray(material.outline) ? material.outline.slice(0, 8).map((item, index) => ({
        heading: compactText(item?.heading || `学习模块 ${index + 1}`, 80),
        points: uniqueStrings(item?.points).slice(0, 6),
      })) : [],
      keyPoints: uniqueStrings(material.keyPoints).slice(0, 12),
      studyGuide: compactMultiline(material.studyGuide, 2200),
      practiceTips: uniqueStrings(material.practiceTips).slice(0, 8),
      sourceRefs: uniqueStrings(material.sourceRefs).slice(0, 12),
      generatedBy: result.source || "openclaw",
      thinking: result.thinking || profile.thinking,
      model: result.model || profile.model,
      sessionPatch: result.sessionPatch,
      runId: result.runId,
      repaired: result.repaired === true,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    throw modelRequiredError("培训讲义生成", error);
  }
}
