import { askLLM } from "./llm.mjs";
import { searchChunks, searchChunksHybrid } from "./rag.mjs";
import { cleanQuestionText, isUsableTrainingChunk } from "./quality.mjs";

const DEFAULT_FLASH_MODEL = process.env.OPENCLAW_FLASH_MODEL || process.env.OPENCLAW_AI_MODEL || "deepseek/deepseek-v4-flash";
const DEFAULT_TRAINING_MODEL = process.env.OPENCLAW_TRAINING_MODEL || DEFAULT_FLASH_MODEL;
const TRAINING_AI_SESSION_KEY = process.env.OPENCLAW_TRAINING_SESSION_KEY || "agent:main:training-service";
const MAX_CONTEXT_CHARS = Number(process.env.TRAINING_AI_CONTEXT_CHARS || 12_000);
const AI_PROFILE = {
  intent: {
    thinking: process.env.OPENCLAW_INTENT_THINKING || process.env.OPENCLAW_TRAINING_INTENT_THINKING || "minimal",
    model: process.env.OPENCLAW_INTENT_MODEL || process.env.OPENCLAW_TRAINING_INTENT_MODEL || DEFAULT_TRAINING_MODEL,
    timeoutMs: Number(process.env.OPENCLAW_INTENT_TIMEOUT_MS || process.env.OPENCLAW_TRAINING_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 45_000),
  },
  material: {
    thinking: process.env.OPENCLAW_MATERIAL_THINKING || process.env.OPENCLAW_TRAINING_MATERIAL_THINKING || "low",
    model: process.env.OPENCLAW_MATERIAL_MODEL || process.env.OPENCLAW_TRAINING_MATERIAL_MODEL || DEFAULT_TRAINING_MODEL,
    timeoutMs: Number(process.env.OPENCLAW_MATERIAL_TIMEOUT_MS || process.env.OPENCLAW_TRAINING_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 150_000),
  },
  quiz: {
    thinking: process.env.OPENCLAW_QUIZ_THINKING || process.env.OPENCLAW_TRAINING_QUIZ_THINKING || "medium",
    model: process.env.OPENCLAW_QUIZ_MODEL || process.env.OPENCLAW_TRAINING_QUIZ_MODEL || DEFAULT_TRAINING_MODEL,
    timeoutMs: Number(process.env.OPENCLAW_QUIZ_TIMEOUT_MS || process.env.OPENCLAW_TRAINING_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 180_000),
  },
  answer: {
    thinking: process.env.OPENCLAW_ANSWER_THINKING || process.env.OPENCLAW_TRAINING_ANSWER_THINKING || "medium",
    model: process.env.OPENCLAW_ANSWER_MODEL || process.env.OPENCLAW_TRAINING_ANSWER_MODEL || DEFAULT_TRAINING_MODEL,
    timeoutMs: Number(process.env.OPENCLAW_ANSWER_TIMEOUT_MS || process.env.OPENCLAW_TRAINING_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 120_000),
  },
  repair: {
    thinking: process.env.OPENCLAW_REPAIR_THINKING || process.env.OPENCLAW_TRAINING_REPAIR_THINKING || "minimal",
    model: process.env.OPENCLAW_REPAIR_MODEL || process.env.OPENCLAW_TRAINING_REPAIR_MODEL || DEFAULT_TRAINING_MODEL,
    timeoutMs: Number(process.env.OPENCLAW_REPAIR_TIMEOUT_MS || process.env.OPENCLAW_TRAINING_TIMEOUT_MS || process.env.OPENCLAW_CHAT_TIMEOUT_MS || 90_000),
  },
};

function compactText(value, maxLength = 1600) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function compactMultiline(value, maxLength = 1600) {
  const text = String(value || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const source = fenced ? fenced[1].trim() : unfenced;
  const candidate = source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1);
  if (!candidate || !candidate.startsWith("{")) throw new Error("OpenClaw did not return a JSON object");
  return JSON.parse(candidate);
}

async function askLlmJson({ purpose, prompt, profile }) {
  const result = await askLLM(prompt, {
    sessionKey: `${TRAINING_AI_SESSION_KEY}:${purpose}`,
    thinking: profile.thinking,
    model: profile.model,
    timeoutMs: profile.timeoutMs,
  });
  return {
    data: extractJsonObject(result.answer),
    raw: result.answer,
    runId: result.runId,
    source: result.source || "openclaw",
    thinking: result.thinking || profile.thinking,
    model: result.model || profile.model,
    sessionPatch: result.sessionPatch,
  };
}

async function askLlmStructured({ purpose, prompt, profile, repairSchema }) {
  const result = await askLLM(prompt, {
    sessionKey: `${TRAINING_AI_SESSION_KEY}:${purpose}`,
    thinking: profile.thinking,
    model: profile.model,
    timeoutMs: profile.timeoutMs,
  });
  try {
    return {
      data: extractJsonObject(result.answer),
      raw: result.answer,
      runId: result.runId,
      source: result.source || "openclaw",
      thinking: result.thinking || profile.thinking,
      model: result.model || profile.model,
      sessionPatch: result.sessionPatch,
      format: "json",
    };
  } catch (error) {
    if (repairSchema) {
      try {
        const repairProfile = AI_PROFILE.repair;
        const repair = await askLLM(`请把下面内容转换成严格 JSON 对象。只能输出 JSON，不要 Markdown，不要解释。目标格式：${JSON.stringify(repairSchema)}\n\n原始内容：\n${result.answer}`, {
          sessionKey: `${TRAINING_AI_SESSION_KEY}:${purpose}:repair`,
          thinking: repairProfile.thinking,
          model: repairProfile.model,
          timeoutMs: repairProfile.timeoutMs,
        });
        return {
          data: extractJsonObject(repair.answer),
          raw: repair.answer,
          runId: repair.runId,
          source: repair.source || "openclaw",
          thinking: repair.thinking || repairProfile.thinking,
          model: repair.model || repairProfile.model,
          sessionPatch: repair.sessionPatch,
          format: "json",
          repaired: true,
        };
      } catch {
      }
    }
    return {
      data: null,
      raw: result.answer,
      runId: result.runId,
      source: result.source || "openclaw",
      thinking: result.thinking || profile.thinking,
      model: result.model || profile.model,
      sessionPatch: result.sessionPatch,
      format: "text",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getKnowledgeBase(state, knowledgeBaseId) {
  return state.knowledgeBases.find((kb) => kb.id === knowledgeBaseId) || null;
}

function selectContextChunks(state, { knowledgeBaseId, query, limit = 12 }) {
  const ranked = searchChunks(state, { knowledgeBaseId, query, limit });
  const fallback = state.chunks.filter((chunk) => chunk.knowledgeBaseId === knowledgeBaseId).filter(isUsableTrainingChunk);
  const seen = new Set();
  const selected = [];
  for (const chunk of [...ranked, ...fallback]) {
    if (!chunk || seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    selected.push(chunk);
    if (selected.length >= limit) break;
  }
  return selected;
}

async function selectContextChunksHybrid(state, { knowledgeBaseId, query, limit = 12 }) {
  try {
    const hybrid = await searchChunksHybrid(state, { knowledgeBaseId, query, limit });
    if (hybrid && hybrid.length) {
      const seen = new Set();
      const merged = [];
      for (const chunk of hybrid) {
        if (!chunk || !chunk.id || seen.has(chunk.id)) continue;
        seen.add(chunk.id);
        merged.push(chunk);
      }
      for (const chunk of selectContextChunks(state, { knowledgeBaseId, query, limit })) {
        if (!chunk || !chunk.id || seen.has(chunk.id)) continue;
        seen.add(chunk.id);
        merged.push(chunk);
        if (merged.length >= limit) break;
      }
      return merged.slice(0, limit);
    }
  } catch {
  }
  return selectContextChunks(state, { knowledgeBaseId, query, limit });
}

function renderContext(chunks) {
  let total = 0;
  const lines = [];
  for (const chunk of chunks) {
    const text = `[${chunk.sourceRef}]\n${chunk.content}`;
    const remaining = MAX_CONTEXT_CHARS - total;
    if (remaining <= 0) break;
    const clipped = text.length > remaining ? text.slice(0, remaining) : text;
    lines.push(clipped);
    total += clipped.length;
  }
  return lines.join("\n\n---\n\n");
}

function localIntent(message) {
  const text = String(message || "");
  if (/(查询|查看|进度|完成情况|成绩|谁完成|谁没完成|状态|报表)/.test(text)) {
    return { intent: "query_training_status", confidence: 0.75, skill: "show_training_status", source: "local" };
  }
  if (
    /(发布|安排|创建|新建|布置|分配|指派|生成|制定|做|建).*(培训|学习|考试|课程|题|计划|考察)/.test(text) ||
    /给.+(培训|学习|考试|课程)/.test(text) ||
    /(出|生成|做)\s*\d+\s*(道)?\s*(题|考题|试题)/.test(text) ||
    /(全部|所有|全员|全体).*(培训|学习|考试|课程|考察)/.test(text) ||
    /(培训|学习|考试|课程).*(全部|所有|全员|全体|员工|人员)/.test(text) ||
    /(及格|通过分数|截止时间|员工专属链接)/.test(text)
  ) {
    return { intent: "create_training_draft", confidence: 0.78, skill: "create_training_draft", source: "local" };
  }
  return { intent: "general_chat", confidence: 0.6, skill: "answer_general_chat", source: "local" };
}

function cleanTrainingText(value) {
  return String(value || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s*/gm, "")
    .replace(/来源文件[:：]\s*[^\s。；;\n]+/g, "")
    .replace(/页数[:：]\s*\d+/g, "")
    .replace(/页码[:：]\s*\d+/g, "")
    .replace(/第\s*\d+\s*页/g, "")
    .replace(/\bhttps?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulTrainingText(value) {
  const text = cleanTrainingText(value);
  return text.length >= 12 && !/(来源文件|页数|页码|未能从|OCR|抽取|复制文本|导入|扫描件)/i.test(text);
}

function splitTrainingSentences(value, limit = 4) {
  return uniqueStrings((cleanTrainingText(value).match(/[^。！？；;.!?]+[。！？；;.!?]?/g) || [])
    .map((sentence) => compactText(sentence, 120))
    .filter(isUsefulTrainingText))
    .slice(0, limit);
}

const MATERIAL_KEYWORD_RE = /(电机|三相|异步|同步|定子|转子|绕组|铁芯|铸铝|轴承|端盖|风叶|风罩|接线盒|铭牌|功率|电压|电流|转速|频率|效率|防护|绝缘|安装|选型|客户|销售|沟通|低压|转差|磁场|水泵|应用|能效|IE\d?)/i;
const MATERIAL_NOISE_RE = /^(?:来源文件|页数|作成|日期|目录|第\s*\d+\s*页|福建新银嘉泵业有限公司|FUJIAN NEW YINJIA PUMP CO\.?,?\s*LTD\.?|YINJIA|A TRUSTED BRAND|YOUR RELIABLE PARTNER|\d+)$/i;

function cleanMaterialPoint(value, maxLength = 180) {
  const text = cleanTrainingText(String(value || "")
    .replace(/[●○•▪▫□■◆◇►▶]/g, " ")
    .replace(/^#+\s*/g, "")
    .replace(/^\s*[-*·•○●▪▫□■◆◇►▶]+\s*/g, "")
    .replace(/^\s*(?:第\s*)?\d+\s*(?:页)?\s*$/g, "")
    .replace(/^\s*\d+\s+(?=\d+(?:\.\d+)+|\S)/g, "")
    .replace(/\s+/g, " "));
  return compactText(text, maxLength);
}

function isGoodMaterialPoint(value) {
  const text = cleanMaterialPoint(value);
  if (!text || text.length < 12) return false;
  if (MATERIAL_NOISE_RE.test(text)) return false;
  if (/^[\d\s.。,:：;；、-]+$/.test(text)) return false;
  if (/[\u0400-\u04ff\u0600-\u06ff]/.test(text)) return false;
  if (/^[A-Z]{1,5}\d[-A-Z0-9]*\s+\d/.test(text) && (text.match(/\d/g) || []).length >= 8) return false;
  if ((text.match(/[A-Za-z0-9]/g) || []).length > text.length * 0.55 && (text.match(/[\u3400-\u9fff]/g) || []).length < 6) return false;
  if (/有限公司/.test(text) && text.length < 40) return false;
  if (/专利号[:：]?|发明专利/i.test(text)) return false;
  if (/^Q[:：]/i.test(text)) return false;
  if (/[，,、：:]$/.test(text)) return false;
  if (/^(?:什么是|结构组成|规格参数|运行特性)$/.test(text)) return false;
  if (text.length < 20 && !MATERIAL_KEYWORD_RE.test(text)) return false;
  return isUsefulTrainingText(text);
}

function splitMaterialLine(line) {
  const cleaned = cleanMaterialPoint(line);
  if (!cleaned) return [];
  if (cleaned.length <= 90) return [cleaned];
  const pieces = cleaned.match(/[^。！？；;]+[。！？；;]?/g) || [cleaned];
  return pieces.map((piece) => cleanMaterialPoint(piece)).filter(Boolean);
}

function materialCandidateLines(value) {
  const lines = String(value || "")
    .replace(/\r/g, "\n")
    .split(/\n+|[●○•▪▫□■◆◇►▶]/g)
    .flatMap((line) => splitMaterialLine(line));
  return uniqueStrings(lines.filter(isGoodMaterialPoint));
}

function extractLearningPoints(value, limit = 4) {
  return materialCandidateLines(value).slice(0, limit);
}

function extractSectionHeading(value) {
  const lines = String(value || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => cleanMaterialPoint(line, 80))
    .filter(Boolean);
  const numbered = lines.find((line) => /^\d+(?:\.\d+)+\s*\S/.test(line) && line.length <= 60);
  const heading = numbered || lines.find((line) => MATERIAL_KEYWORD_RE.test(line) && line.length >= 4 && line.length <= 40);
  return heading ? heading.replace(/^\d+(?:\.\d+)+\s*/, "").trim() : "";
}

function materialChunkScore(chunk, task) {
  const points = extractLearningPoints(chunk.content, 8);
  if (!points.length) return -100;
  const query = `${task.title || ""} ${task.instruction || ""}`;
  const text = cleanTrainingText(`${chunk.content || ""} ${chunk.sourceRef || ""}`);
  let score = points.length * 8 + Math.min(text.length / 120, 8) + Number(chunk.score || chunk.keywordScore || 0);
  if (MATERIAL_KEYWORD_RE.test(text)) score += 8;
  const sourceName = `${chunk.sourcePath || ""} ${chunk.sourceRef || ""}`;
  if (/视觉识别补充/.test(sourceName)) score += 80;
  if (/三相异步电动机|异步电机定转子|电机数据/.test(sourceName)) score += 4;
  if (/定转子参数表-多语言|定转子参数表-(?:俄语|法语|英语|阿语)/.test(sourceName) && !/(参数表|俄语|法语|英语|阿语|多语言)/.test(query)) score -= 35;
  if (/(产品3|Q[:：]|PK|话术)/.test(text) && !/(话术|问答|客户异议)/.test(query)) score -= 18;
  if (!/(销售|客户|新人|业务|沟通)/.test(query) && /(产品3|销售|客户|话术|PK|需求)/.test(text)) score -= 10;
  if (/^(?:#|来源文件|页数)/.test(String(chunk.content || "").trim())) score -= 8;
  return score;
}

function selectFallbackMaterialChunks(state, task, limit = 10) {
  const query = `${task.title || ""} ${task.instruction || ""}`;
  const ranked = selectContextChunks(state, {
    knowledgeBaseId: task.knowledgeBaseId,
    query,
    limit: 30,
  });
  const fallback = state.chunks
    .filter((chunk) => chunk.knowledgeBaseId === task.knowledgeBaseId)
    .filter(isUsableTrainingChunk);
  const seen = new Set();
  const candidates = [];
  for (const chunk of [...ranked, ...fallback]) {
    if (!chunk || !chunk.id || seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    candidates.push(chunk);
  }
  return candidates
    .map((chunk) => ({
      ...chunk,
      materialScore: materialChunkScore(chunk, task),
      sentences: extractLearningPoints(chunk.content, 5),
      sectionHeading: extractSectionHeading(chunk.content),
      clean: cleanTrainingText(chunk.content),
    }))
    .filter((chunk) => chunk.materialScore > 0 && chunk.sentences.length)
    .sort((left, right) => right.materialScore - left.materialScore)
    .slice(0, limit);
}

function inferModuleHeading(text, index) {
  const value = cleanTrainingText(text);
  const rules = [
    [/定子|转子|绕组|铁芯|铸铝/, "电机结构与核心部件"],
    [/功率|电压|电流|转速|效率|功率因数|防护|绝缘|参数|铭牌/, "关键参数与铭牌识读"],
    [/启动|变频|运行|转差|转矩|调速|温升/, "运行特性与使用条件"],
    [/选型|客户|销售|拒绝|话术|沟通|应用/, "客户沟通与销售应用"],
    [/维护|检查|故障|安全|安装|保养/, "安装维护与安全要点"],
  ];
  const matched = rules.find(([pattern]) => pattern.test(value));
  if (matched) return matched[1];
  return `学习模块 ${index + 1}`;
}

export async function classifyTrainingIntent(state, message) {
  const kbList = state.knowledgeBases
    .filter((kb) => kb.status === "ready")
    .map((kb) => ({ id: kb.id, name: kb.name, aliases: kb.aliases || [] }));
  const employeeList = state.employees
    .filter((employee) => employee.status === "active")
    .map((employee) => ({ name: employee.name, department: employee.department, role: employee.role, aliases: employee.aliases || [] }));
  const profile = AI_PROFILE.intent;
  const prompt = `你是苏州钜洲工业有限公司培训系统的意图路由器。优先使用 DeepSeek V4 Flash（如当前 OpenClaw 会话配置可用）并使用 ${profile.thinking} 思考强度。\n\n只能输出 JSON，不要输出解释。\n\n可调用 skill：\n1. create_training_draft：用户要发布、安排、生成、制定培训计划，或要求出题、考试、考察、给员工学习。\n2. show_training_status：用户要查培训进度、完成情况、成绩、报表。\n3. answer_general_chat：其他普通聊天。\n\n输出格式：{"intent":"create_training_draft|show_training_status|answer_general_chat","skill":"create_training_draft|show_training_status|answer_general_chat","confidence":0到1,"reason":"一句话原因"}\n\n已导入知识库：${JSON.stringify(kbList)}\n员工：${JSON.stringify(employeeList)}\n用户输入：${JSON.stringify(String(message || ""))}`;
  try {
    const result = await askLlmJson({ purpose: "intent", prompt, profile });
    const intent = String(result.data.intent || result.data.skill || "");
    if (["create_training_draft", "show_training_status", "answer_general_chat"].includes(intent)) {
      return {
        intent,
        skill: String(result.data.skill || intent),
        confidence: Number(result.data.confidence) || 0.8,
        reason: String(result.data.reason || ""),
        source: "openclaw",
        runId: result.runId,
        thinking: result.thinking,
        model: result.model,
        sessionPatch: result.sessionPatch,
      };
    }
  } catch {
  }
  return localIntent(message);
}

function fallbackTrainingMaterial(state, task) {
  const chunks = selectFallbackMaterialChunks(state, task, 10);
  const cleanedChunks = chunks.filter((chunk) => isUsefulTrainingText(chunk.clean) || chunk.sentences.length);
  const keyPoints = uniqueStrings(cleanedChunks.flatMap((chunk) => chunk.sentences)).slice(0, 8);
  const modules = [];
  for (const chunk of cleanedChunks) {
    const inferredHeading = inferModuleHeading(chunk.clean, modules.length);
    const finalHeading = /^学习模块/.test(inferredHeading) && chunk.sectionHeading ? chunk.sectionHeading : inferredHeading;
    const existing = modules.find((item) => item.heading === finalHeading);
    const points = chunk.sentences.slice(0, 3);
    if (!points.length) continue;
    if (existing) {
      existing.points = uniqueStrings([...existing.points, ...points]).slice(0, 4);
    } else {
      modules.push({ heading: finalHeading, points });
    }
    if (modules.length >= 6) break;
  }
  if (!keyPoints.length) {
    keyPoints.push(
      "理解培训资料中的核心概念和适用场景。",
      "掌握与岗位相关的关键参数、结构特点或业务规则。",
      "能够结合实际客户问题或工作任务进行复述和应用。",
    );
  }
  if (!modules.length) {
    modules.push(
      {
        heading: "培训目标与学习路径",
        points: ["先了解本次培训主题和岗位要求。", "再按资料重点完成核心概念学习。"],
      },
      {
        heading: "核心知识与应用复盘",
        points: keyPoints.slice(0, 3),
      },
    );
  }
  const fallbackSummary = `本次培训围绕${task.title}展开，重点覆盖${modules.map((item) => item.heading).slice(0, 4).join("、") || "资料核心知识"}，帮助学习者理解关键概念并完成后续考试。`;
  const guideLines = [
    `请先按模块完成${task.title}学习，理解每个概念对应的实际应用场景。`,
    ...keyPoints.slice(0, 5).map((point, index) => `${index + 1}. ${point}`),
    "学习结束后，请尝试用自己的话复述核心参数、结构特点和客户沟通要点，再进入在线考试。",
  ];
  return {
    title: task.title,
    summary: compactText(fallbackSummary, 260),
    outline: modules,
    keyPoints,
    studyGuide: compactMultiline(guideLines.join("\n"), 1400),
    practiceTips: ["先看模块标题，再逐条理解要点。", "遇到参数、结构、应用场景时，结合资料来源复盘。", "考试前重点复习模块卡片和必须掌握内容。"],
    sourceRefs: uniqueStrings(chunks.map((chunk) => chunk.sourceRef)).slice(0, 12),
    generatedBy: "fallback",
    fallbackVersion: 2,
    generatedAt: new Date().toISOString(),
  };
}

export function regenerateLocalTrainingMaterial(state, task) {
  return fallbackTrainingMaterial(state, task);
}

function looseJsonField(text, field) {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*"|\\n\\s*"|\\s*})`);
  const match = String(text || "").match(pattern);
  return match ? match[1].replace(/\\"/g, "\"").replace(/\\\\n/g, "\n").replace(/\\n/g, "\n").trim() : "";
}

function stripCodeFence(text) {
  return String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function cleanAnswerText(value) {
  return compactMultiline(String(value || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s*/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\n{3,}/g, "\n\n"), 1800);
}

function sourceObjects(chunks) {
  return chunks.map((chunk) => ({
    chunkId: chunk.id,
    documentId: chunk.documentId,
    sourceRef: chunk.sourceRef,
    score: chunk.score,
    retrieval: chunk.retrieval,
    keywordScore: chunk.keywordScore,
    semanticScore: chunk.semanticScore,
  }));
}

function retrievalConfidence(chunks, high = "high", medium = "medium") {
  const top = chunks[0] || {};
  if (top.retrieval === "semantic" || top.retrieval === "hybrid") {
    return (top.score || 0) >= 0.55 ? high : medium;
  }
  return (top.score || 0) >= 4 ? high : medium;
}

function fallbackKnowledgeAnswer(chunks, question) {
  if (!chunks.length) {
    return {
      answer: "当前知识库中没有找到足够相关的资料。建议换一个更具体的问题，或补充、重新清洗对应资料。",
      keyPoints: [],
      caveats: ["未检索到相关资料片段。"],
      sources: [],
      confidence: "low",
      generatedBy: "fallback",
    };
  }
  const keyPoints = uniqueStrings(chunks.flatMap((chunk) => splitTrainingSentences(chunk.content, 5))).slice(0, 8);
  const sourceRefs = uniqueStrings(chunks.map((chunk) => chunk.sourceRef)).slice(0, 8);
  const explainToCustomer = /(客户|销售|话术|怎么讲|如何讲|怎么介绍|如何介绍|说明|讲解)/.test(String(question || ""));
  const answer = explainToCustomer && keyPoints.length
    ? [
        "可以按“先场景、再结构、最后价值”的顺序讲。",
        "先说明这部分资料用于帮助客户理解产品结构和应用关注点；再把资料里的零部件、安装方式、维护部件或选型差异分组说明，不要逐条念清单；最后落到客户关心的安装、维护和选型决策上。",
        `结合当前资料，重点可提到：${keyPoints.slice(0, 3).join("；")}`,
      ].join("\n")
    : keyPoints.length
      ? `根据当前资料，关于“${compactText(question, 80)}”，可以先抓住这些重点：${keyPoints.slice(0, 3).join("；")}`
      : `当前资料与“${compactText(question, 80)}”相关，但可提炼内容有限。建议查看引用来源进一步确认。`;
  return {
    answer: compactMultiline(answer, 900),
    keyPoints,
    caveats: ["这是本地整理结果，未调用 OpenClaw 深度归纳。"],
    sources: sourceObjects(chunks),
    sourceRefs,
    confidence: retrievalConfidence(chunks, "medium", "low"),
    generatedBy: "fallback",
  };
}

function answerFromOpenClawText(raw, chunks, result) {
  const answer = cleanAnswerText(stripCodeFence(raw));
  return {
    answer: answer || fallbackKnowledgeAnswer(chunks, "").answer,
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

export async function generateKnowledgeAnswer(state, { knowledgeBaseId, question }) {
  const text = String(question || "").trim();
  if (!text) {
    return {
      answer: "请先输入你想咨询的资料问题。",
      keyPoints: [],
      caveats: [],
      sources: [],
      confidence: "low",
      generatedBy: "fallback",
    };
  }
  let chunks = [];
  try {
    chunks = await searchChunksHybrid(state, {
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
  if (!chunks.length) return fallbackKnowledgeAnswer(chunks, text);
  const profile = AI_PROFILE.answer;
  const answerSchema = {
    answer: "直接回答，120-260字，不要照抄原文",
    keyPoints: ["关键要点"],
    caveats: ["资料不足或需要注意的地方"],
    sourceRefs: ["引用来源"],
  };
  const prompt = `你是企业培训资料答疑助手。优先使用 DeepSeek V4 Flash（如当前 OpenClaw 会话配置可用）并使用 ${profile.thinking} 思考强度。\n\n只允许依据给定资料回答；不要编造资料外事实；不要输出 Markdown；不要照抄大段原文。请先直接回答问题，再提炼员工容易理解的要点。如果资料不足，请明确说明不足。\n\n只能输出 JSON，不要 Markdown 包裹。\n\n输出格式：{"answer":"直接回答，120-260字","keyPoints":["关键要点1","关键要点2"],"caveats":["注意事项或资料不足"],"sourceRefs":["引用来源"]}\n\n问题：${JSON.stringify(text)}\n资料上下文：\n${renderContext(chunks)}`;
  try {
    const result = await askLlmStructured({ purpose: `answer:${knowledgeBaseId}`, prompt, profile, repairSchema: answerSchema });
    if (!result.data) return answerFromOpenClawText(result.raw, chunks, result);
    const data = result.data || {};
    return {
      answer: cleanAnswerText(data.answer),
      keyPoints: uniqueStrings(data.keyPoints).map((item) => cleanTrainingText(item)).filter(Boolean).slice(0, 8),
      caveats: uniqueStrings(data.caveats).map((item) => cleanTrainingText(item)).filter(Boolean).slice(0, 5),
      sources: sourceObjects(chunks),
      sourceRefs: uniqueStrings(data.sourceRefs).slice(0, 8),
      confidence: retrievalConfidence(chunks, "high", "medium"),
      generatedBy: result.source || "openclaw",
      thinking: result.thinking || profile.thinking,
      model: result.model || profile.model,
      sessionPatch: result.sessionPatch,
      runId: result.runId,
      repaired: result.repaired === true,
    };
  } catch {
    return fallbackKnowledgeAnswer(chunks, text);
  }
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
  } catch {
    return fallbackTrainingMaterial(state, task);
  }
}

function normalizeQuestion(raw, index, task, sourceRefs) {
  const requestedType = task.quizType === "true_false" ? "true_false" : "single_choice";
  const type = raw?.type === "true_false" || requestedType === "true_false" ? "true_false" : "single_choice";
  const prompt = cleanQuestionText(raw?.prompt || `请根据培训资料回答第 ${index + 1} 题。`, 180);
  const sourceRef = compactText(raw?.sourceRef || sourceRefs[index % Math.max(sourceRefs.length, 1)] || "培训资料", 180);
  if (type === "true_false") {
    const answer = String(raw?.correctAnswer || "正确").includes("错") ? "错误" : "正确";
    return {
      type,
      prompt,
      options: ["正确", "错误"],
      correctAnswer: answer,
      explanation: compactText(raw?.explanation || `参考资料：${sourceRef}`, 360),
      sourceRef,
    };
  }
  const correctAnswer = cleanQuestionText(raw?.correctAnswer || raw?.answer || "以上说法符合培训资料", 80);
  const options = uniqueStrings([correctAnswer, ...(Array.isArray(raw?.options) ? raw.options : []).map((option) => cleanQuestionText(option, 80))]).slice(0, 4);
  for (const option of ["只关注价格，不需要理解技术资料。", "客户问题可以不结合资料回答。", "培训内容与实际选型和销售沟通无关。", "无需确认客户应用场景。"]) {
    if (options.length >= 4) break;
    if (option !== correctAnswer) options.push(option);
  }
  return {
    type,
    prompt,
    options,
    correctAnswer,
    explanation: compactText(raw?.explanation || `参考资料：${sourceRef}`, 360),
    sourceRef,
  };
}

export async function generateQuizQuestions(state, task) {
  const count = Math.max(1, Math.min(Number(task.quizCount) || 10, 50));
  const chunks = await selectContextChunksHybrid(state, {
    knowledgeBaseId: task.knowledgeBaseId,
    query: `${task.title} ${task.instruction}`,
    limit: Math.max(10, Math.min(count + 6, 24)),
  });
  const sourceRefs = chunks.map((chunk) => chunk.sourceRef);
  const context = renderContext(chunks);
  const profile = AI_PROFILE.quiz;
  const quizSchema = {
    questions: [
      {
        type: "single_choice",
        prompt: "题干",
        options: ["A", "B", "C", "D"],
        correctAnswer: "A",
        explanation: "解析",
        sourceRef: "来源",
      },
    ],
  };
  const prompt = `你是企业培训考试出题专家。优先使用 DeepSeek V4 Flash（如当前 OpenClaw 会话配置可用）并使用 ${profile.thinking} 思考强度。请根据资料生成考试题。\n\n要求：\n- 只依据资料上下文出题，不要编造。\n- 题目应考察理解、选型、应用、结构、参数或销售沟通重点。\n- 每题必须有明确正确答案、解析和来源。\n- 如果是单选题，每题 4 个选项，且 correctAnswer 必须完全等于某个 options。\n- 只能输出 JSON，不要 Markdown 包裹。\n\n输出格式：{"questions":[{"type":"single_choice或true_false","prompt":"题干","options":["A","B","C","D"],"correctAnswer":"正确选项文本","explanation":"解析","sourceRef":"来源"}]}\n\n题目数量：${count}\n题型要求：${task.quizType || "single_choice"}\n任务：${JSON.stringify(task)}\n培训内容：${JSON.stringify(task.trainingMaterial || null)}\n资料上下文：\n${context}`;
  try {
    const result = await askLlmStructured({ purpose: `quiz:${task.id}`, prompt, profile, repairSchema: quizSchema });
    if (!result.data) return { questions: [], source: "fallback", error: result.error };
    const rawQuestions = Array.isArray(result.data.questions) ? result.data.questions : [];
    const normalized = rawQuestions.map((question, index) => normalizeQuestion(question, index, task, sourceRefs)).filter((question) => question.prompt && question.options.length >= 2);
    return {
      questions: normalized.slice(0, count),
      source: "openclaw",
      thinking: result.thinking || profile.thinking,
      model: result.model || profile.model,
      sessionPatch: result.sessionPatch,
      runId: result.runId,
    };
  } catch {
    return { questions: [], source: "fallback" };
  }
}
