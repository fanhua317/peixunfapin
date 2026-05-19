import { askLLM } from "../llm.mjs";
import { searchChunks, searchChunksHybrid } from "../rag.mjs";
import { cleanQuestionText, isUsableTrainingChunk } from "../quality.mjs";

const DEFAULT_FLASH_MODEL = process.env.OPENCLAW_FLASH_MODEL || process.env.OPENCLAW_AI_MODEL || "deepseek/deepseek-v4-flash";
const DEFAULT_TRAINING_MODEL = process.env.OPENCLAW_TRAINING_MODEL || DEFAULT_FLASH_MODEL;
const TRAINING_AI_SESSION_KEY = process.env.OPENCLAW_TRAINING_SESSION_KEY || "agent:main:training-service";
const MAX_CONTEXT_CHARS = Number(process.env.TRAINING_AI_CONTEXT_CHARS || 12_000);
const ANSWER_CONTEXT_LIMIT = Number(process.env.TRAINING_ANSWER_CONTEXT_LIMIT || 8);
const LOW_VALUE_CONTEXT_RE = /(未能抽取|无法抽取|OCR|扫描件|复制文本|图片型 PDF|来源文件[:：]|页数[:：]|目录|封面|未识别文本|鏈兘|鎶藉彇|澶嶅埗鏂囨湰|鎵弿)/i;
const PARAM_QUERY_RE = /(参数|范围|功率|机座|级数|能效|型号|尺寸|电压|电流|效率|YE\d|IE\d|kw|kW|pole|poles)/i;
const PARAM_CHUNK_RE = /(机座范围|功率范围|级数|能效|机壳|列\s*2|Motor Model|Output\s*Power|standard\s*Eff)/i;
const PROCESS_QUERY_RE = /(工艺|铸铝|品质|质量|检测|销售|话术|客户|介绍|附加损耗|转子|定子|冲剪|铁损|断条)/i;
const FACTUAL_SOURCE_LIMIT = 8;
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

function cleanReadableText(value, maxLength = 260) {
  const text = cleanTrainingText(value)
    .replace(/#+\s*/g, "")
    .replace(/福建新银嘉泵业有限公司/g, "")
    .replace(/FUJIAN NEW YINJIA PUMP CO\.?,?\s*LTD\.?/gi, "")
    .replace(/来源文件[:：][^\n。；;]+/g, "")
    .replace(/页数[:：]\s*\d+/g, "")
    .replace(/页码[:：]\s*\d+/g, "")
    .replace(/第\s*\d+\s*页/g, "")
    .replace(/(?:^|\s)\d{1,3}\s+\d+(?:\.\d+)*\s+(?=[\u4e00-\u9fa5A-Za-z])/g, " ")
    .replace(/(?:^|\s)\d+(?:\.\d+)+\s+(?=[\u4e00-\u9fa5A-Za-z])/g, " ")
    .replace(/^(?:\d+\s+){1,3}(?=[\u4e00-\u9fa5A-Za-z])/g, "")
    .replace(/^[\s#\-*•·]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return compactText(text, maxLength);
}

function isLowValueContext(chunk) {
  const text = `${chunk?.heading || ""}\n${chunk?.sourceRef || ""}\n${chunk?.content || ""}`;
  const cleaned = cleanReadableText(text, 500);
  if (!cleaned || cleaned.length < 16) return true;
  if (LOW_VALUE_CONTEXT_RE.test(cleaned) && !/(工艺|铸铝|检测|机座范围|功率范围|能效|附加损耗|客户|销售)/.test(cleaned)) return true;
  return false;
}

function splitReadableClauses(sentence) {
  const cleaned = cleanReadableText(sentence, 360)
    .replace(/^填补国家空白\s*/, "")
    .replace(/^专业铸铝\s*/, "")
    .replace(/^[，,；;:：\s]+/, "")
    .replace(/[，,；;:：\s]+$/, "");
  if (cleaned.length <= 90) return [cleaned];
  const clauses = cleaned
    .split(/[，,]/)
    .flatMap((part) => part.split(/(?=这是因为|此外|同时|因此|常见|在这三种|低压铸铝|离心铸铝|压力铸铝)/))
    .map((part) => cleanReadableText(part, 110).replace(/^[，,；;:：\s]+/, "").replace(/[，,；;:：\s]+$/, ""))
    .filter((part) => part.length >= 8);
  return clauses.length ? clauses : [compactText(cleaned, 110)];
}

function splitReadableSentences(value, limit = 4) {
  return uniqueStrings((cleanReadableText(value, 1400).match(/[^。！？；;.!?]+[。！？；;.!?]?/g) || [])
    .flatMap(splitReadableClauses)
    .map((sentence) => cleanReadableText(sentence, 130))
    .filter((sentence) => sentence.length >= 8 && !LOW_VALUE_CONTEXT_RE.test(sentence)))
    .slice(0, limit);
}

const FALLBACK_TERM_HINTS = [
  "附加损耗",
  "低压铸铝",
  "离心铸铝",
  "压力铸铝",
  "铸铝方式",
  "铸铝转子",
  "导条",
  "端环",
  "铁心",
  "铁损检测仪",
  "硅钢片",
  "铸铝断条检测仪",
  "不良转子",
  "YE4",
  "YE3",
  "YE2",
  "Y2",
  "六级",
  "四级",
  "二级",
  "级数",
  "机座范围",
  "功率范围",
  "能效",
  "五项领先制造工艺",
  "高导电率铝转子铸铝工艺",
  "High-Conductivity Rotor Aluminum Casting",
  "专利号",
  "ZL201810801154.9",
  "客户",
  "销售",
  "专业知识",
  "需求",
  "痛点",
];

function fallbackQueryTerms(question) {
  const text = String(question || "");
  const hinted = FALLBACK_TERM_HINTS.filter((term) => text.includes(term));
  const alnum = text.match(/[A-Za-z][A-Za-z0-9-]{1,}|\b[A-Z]{1,5}\d[A-Z]?\b|ZL\d+(?:\.\d+)?|\d+\s*(?:级|kw|KW|L)/g) || [];
  const derived = [];
  if (text.includes("压力铸铝")) derived.push("压铸");
  return uniqueStrings([...hinted, ...derived, ...alnum]);
}

function fallbackSentenceScore(sentence, question, chunk, sentenceIndex) {
  const text = `${sentence}\n${chunk?.sourceRef || ""}`;
  const terms = fallbackQueryTerms(question);
  let score = Math.max(0, 14 - sentenceIndex * 2);
  let termHits = 0;
  for (const term of terms) {
    if (text.includes(term)) {
      termHits += 1;
      score += Math.max(18, Math.min(38, term.length * 4));
    }
  }
  if (/(因为|因此|所以|最大|最佳|作用|用于|包括|对应|范围|功率|杜绝|把控|不同|增加|降低)/.test(sentence)) score += 18;
  if (!termHits && !/(因为|因此|所以|不同|最大|最佳|增加|降低|导电率|电气性能)/.test(sentence)) score -= 40;
  if (!/(专利|专利号|知识产权)/.test(String(question || "")) && /(专利|专利号|知识产权)/.test(sentence)) score -= 45;
  if (/^(?:Sheet|第\s*\d+\s*条|列\s*\d+|[0-9.]+\s*)/i.test(sentence)) score -= 15;
  if (LOW_VALUE_CONTEXT_RE.test(sentence)) score -= 80;
  return score;
}

function fallbackAnswerEntries(chunks, question, limit = 4) {
  const entries = [];
  for (const [chunkIndex, chunk] of (chunks || []).entries()) {
    const sentences = splitReadableSentences(chunk.content, 8);
    for (const [sentenceIndex, sentence] of sentences.entries()) {
      entries.push({
        sentence,
        chunk,
        score: fallbackSentenceScore(sentence, question, chunk, sentenceIndex) - chunkIndex * 4,
      });
    }
  }
  const seen = new Set();
  return entries
    .sort((left, right) => right.score - left.score)
    .filter((entry) => {
      const key = entry.sentence.replace(/[，。；,.!?！？\s]/g, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return entry.score > 20;
    })
    .slice(0, limit);
}

function chunksForAnswerEntries(entries, fallbackChunks) {
  const selected = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = entry.chunk?.sourceRef || entry.chunk?.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(entry.chunk);
  }
  return selected.length ? selected.slice(0, FACTUAL_SOURCE_LIMIT) : fallbackChunks.slice(0, FACTUAL_SOURCE_LIMIT);
}

function retrievalModeFromChunks(chunks) {
  if ((chunks || []).some((chunk) => chunk.retrieval === "hybrid")) return "hybrid";
  if ((chunks || []).some((chunk) => chunk.retrieval === "semantic")) return "hybrid";
  return "keyword";
}

function contextScoreForQuery(chunk, query, index) {
  const text = `${chunk?.sourceRef || ""}\n${chunk?.heading || ""}\n${chunk?.content || ""}`;
  let score = Math.max(0, 100 - index * 4);
  score += Number(chunk?.score || 0) * 30;
  score += Number(chunk?.semanticScore || 0) * 20;
  if (PARAM_QUERY_RE.test(query) && PARAM_CHUNK_RE.test(text)) score += 60;
  if (PROCESS_QUERY_RE.test(query) && /(工艺|铸铝|检测|质量|品质|客户|销售|附加损耗|转子|定子)/.test(text)) score += 35;
  if (isLowValueContext(chunk)) score -= 120;
  if (/^#\s*视觉识别补充[:：]/.test(String(chunk?.content || ""))) score -= 60;
  return score;
}

function refineContextChunks(chunks, query, limit = ANSWER_CONTEXT_LIMIT) {
  const seen = new Set();
  return (chunks || [])
    .map((chunk, index) => ({ chunk, score: contextScoreForQuery(chunk, query, index) }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.chunk)
    .filter((chunk) => {
      if (!chunk || !chunk.id) return false;
      const key = `${chunk.id}:${chunk.sourceRef || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return !isLowValueContext(chunk) || PARAM_CHUNK_RE.test(String(chunk.content || ""));
    })
    .slice(0, Math.max(1, limit));
}

function allowedSourceRefs(chunks) {
  return uniqueStrings((chunks || []).map((chunk) => chunk.sourceRef)).slice(0, FACTUAL_SOURCE_LIMIT);
}

function normalizeSourceRefs(rawRefs, chunks) {
  const allowed = allowedSourceRefs(chunks);
  const requested = uniqueStrings(rawRefs);
  const matched = requested
    .map((ref) => allowed.find((allowedRef) => allowedRef === ref || allowedRef.includes(ref) || ref.includes(allowedRef)))
    .filter(Boolean);
  return matched.length ? uniqueStrings(matched).slice(0, FACTUAL_SOURCE_LIMIT) : allowed;
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
      return refineContextChunks(merged, query, limit);
    }
  } catch {
  }
  return refineContextChunks(selectContextChunks(state, { knowledgeBaseId, query, limit }), query, limit);
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
    contentPreview: cleanReadableText(chunk.content, 220),
  }));
}

function retrievalConfidence(chunks, high = "high", medium = "medium") {
  const top = chunks[0] || {};
  if (top.retrieval === "semantic" || top.retrieval === "hybrid") {
    return (top.score || 0) >= 0.55 ? high : medium;
  }
  return (top.score || 0) >= 4 ? high : medium;
}

function extractField(text, label) {
  const match = String(text || "").match(new RegExp(`${label}\\s*[:：]\\s*([^\\n\\r]+)`));
  return match ? cleanReadableText(match[1].replace(/^[-*]\s*/, ""), 80) : "";
}

function tableFactsFromChunk(chunk) {
  const text = String(chunk?.content || "");
  const fields = {
    model: extractField(text, "列\\s*2") || extractField(text, "Motor Model"),
    shell: extractField(text, "机壳"),
    energy: extractField(text, "能效"),
    poles: extractField(text, "级数"),
    frameRange: extractField(text, "机座范围"),
    powerRange: extractField(text, "功率范围") || extractField(text, "Output\\s*Power"),
  };
  return Object.values(fields).filter(Boolean).length >= 3 ? fields : null;
}

function buildTableAnswer(chunks, question) {
  if (!PARAM_QUERY_RE.test(question)) return null;
  const chunk = chunks.find((item) => tableFactsFromChunk(item));
  const facts = tableFactsFromChunk(chunk);
  if (!facts) return null;
  const subject = [facts.model, facts.poles ? `${facts.poles}级` : "", facts.shell].filter(Boolean).join(" ");
  const points = [
    facts.frameRange ? `机座范围：${facts.frameRange}` : "",
    facts.powerRange ? `功率范围：${facts.powerRange}` : "",
    facts.energy ? `能效等级：${facts.energy}` : "",
  ].filter(Boolean);
  return {
    answer: `${subject || "该型号"}的${points.join("，")}。`,
    keyPoints: points,
    chunk,
  };
}

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

function fallbackKnowledgeAnswer(chunks, question) {
  const refined = refineContextChunks(chunks, question, 5);
  if (!refined.length) {
    return withAnswerMetadata({
      answer: "当前知识库没有检索到足够相关的资料，建议换一个更具体的问题，或先补充、重新清洗对应资料。",
      keyPoints: [],
      caveats: ["未检索到相关资料片段。"],
      sources: [],
      sourceRefs: [],
      confidence: "low",
      generatedBy: "fallback",
      warnings: ["no_relevant_sources"],
    }, []);
  }
  const tableAnswer = buildTableAnswer(refined, question);
  if (tableAnswer) {
    return withAnswerMetadata({
      answer: tableAnswer.answer,
      keyPoints: tableAnswer.keyPoints,
      caveats: [],
      sources: sourceObjects([tableAnswer.chunk]),
      sourceRefs: allowedSourceRefs([tableAnswer.chunk]),
      confidence: retrievalConfidence([tableAnswer.chunk], "medium", "low"),
      generatedBy: "fallback",
    }, [tableAnswer.chunk]);
  }
  const entries = fallbackAnswerEntries(refined, question, 4);
  const answerChunks = chunksForAnswerEntries(entries, refined);
  const structuredPoints = entries.map((entry) => entry.sentence);
  const structuredAnswer = structuredPoints.length
    ? `资料中可确认：${structuredPoints.slice(0, 4).join("；")}`
    : "当前资料能检索到相关片段，但可提炼的信息较少，建议结合引用来源复核。";
  return withAnswerMetadata({
    answer: compactMultiline(structuredAnswer, 900),
    keyPoints: structuredPoints,
    caveats: ["这是本地结构化整理结果，未扩展资料外信息。"],
    sources: sourceObjects(answerChunks),
    sourceRefs: allowedSourceRefs(answerChunks),
    confidence: retrievalConfidence(answerChunks, "medium", "low"),
    generatedBy: "fallback",
  }, answerChunks);
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
      return {
        ...fallbackKnowledgeAnswer(chunks, question),
        parseWarning: result.error,
      };
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
  } catch {
    return fallbackKnowledgeAnswer(chunks, question);
  }
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
  chunks = refineContextChunks(chunks, text, ANSWER_CONTEXT_LIMIT);
  if (!chunks.length) return fallbackKnowledgeAnswer(chunks, text);
  return await generateStrictKnowledgeAnswer({ knowledgeBaseId, question: text, chunks });
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
  if (!chunks.length) return { questions: [], source: "fallback" };
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
    if (!result.data) return { questions: [], source: "fallback", error: result.error };
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
  } catch {
    return { questions: [], source: "fallback" };
  }
}

export async function generateQuizQuestions(state, task) {
  return await generateQuizQuestionsStrict(state, task);
}
