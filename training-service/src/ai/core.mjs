import { searchChunks, searchChunksHybrid } from "../rag.mjs";
import { isUsableTrainingChunk } from "../quality.mjs";
import {
  AI_PROFILE,
  ANSWER_CONTEXT_LIMIT,
  FACTUAL_SOURCE_LIMIT,
  LOW_VALUE_CONTEXT_RE,
  MAX_CONTEXT_CHARS,
  PARAM_CHUNK_RE,
  PARAM_QUERY_RE,
  PROCESS_QUERY_RE,
} from "./config.mjs";
import { askLlmJson, askLlmStructured } from "./llm-json.mjs";

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

function getKnowledgeBase(state, knowledgeBaseId) {
  return state.knowledgeBases.find((kb) => kb.id === knowledgeBaseId) || null;
}

function modelRequiredError(feature, error) {
  if (error instanceof Error && /需要可用的大模型 API/.test(error.message)) return error;
  const detail = error instanceof Error ? error.message : String(error || "");
  const required = new Error(`${feature}需要可用的大模型 API；请配置 TRAINING_LLM_API_KEY、DEEPSEEK_API_KEY 或 OPENAI_API_KEY 后重试。${detail ? ` 原因：${detail}` : ""}`);
  required.statusCode = 503;
  return required;
}

function selectContextChunks(state, { knowledgeBaseId, query, limit = 12 }) {
  const ranked = searchChunks(state, { knowledgeBaseId, query, limit });
  const supplemental = state.chunks.filter((chunk) => chunk.knowledgeBaseId === knowledgeBaseId).filter(isUsableTrainingChunk);
  const seen = new Set();
  const selected = [];
  for (const chunk of [...ranked, ...supplemental]) {
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
    const matched = Array.isArray(chunk.matchedChunks) && chunk.matchedChunks.length
      ? `\n\nMatched child snippets:\n${chunk.matchedChunks
        .slice(0, 3)
        .map((item, index) => `${index + 1}. ${item.preview || item.sourceRef || item.chunkId}`)
        .join("\n")}`
      : chunk.matchedPreview
        ? `\n\nMatched child snippet:\n${chunk.matchedPreview}`
        : "";
    const text = `[${chunk.sourceRef}]\n${chunk.content}${matched}`;
    const remaining = MAX_CONTEXT_CHARS - total;
    if (remaining <= 0) break;
    const clipped = text.length > remaining ? text.slice(0, remaining) : text;
    lines.push(clipped);
    total += clipped.length;
  }
  return lines.join("\n\n---\n\n");
}

function isMarketingArticleIntent(text) {
  const value = String(text || "");
  if (/(软文|营销文章|推广文案|公众号文章|宣传文案|客户文章|宣传稿|营销稿|官网文章|推文|B2B\s*文案|b2b\s*文案)/i.test(value)) {
    return true;
  }
  if (/(写|生成|做|来|出|整理|创作).*(产品介绍|品牌介绍|宣传介绍|营销内容|推广内容|客户内容)/.test(value) && !/(培训|考试|试题|考题|学习|课程)/.test(value)) {
    return true;
  }
  return false;
}

const KNOWN_INTENT_SKILLS = new Set([
  "create_training_draft",
  "show_training_status",
  "delete_training_records",
  "generate_marketing_article",
  "answer_general_chat",
]);
const OPERATION_INTENT_SKILLS = new Set([
  "create_training_draft",
  "show_training_status",
  "delete_training_records",
  "generate_marketing_article",
]);
const HIGH_RISK_INTENT_SKILLS = new Set(["delete_training_records"]);
const DIRECT_OPERATION_CONFIDENCE = 0.7;
const LOCAL_BYPASS_CONFIDENCE = 0.82;

function normalizeIntentSkill(value) {
  const skill = String(value || "").trim();
  if (skill === "query_training_status") return "show_training_status";
  if (skill === "general_chat") return "answer_general_chat";
  return KNOWN_INTENT_SKILLS.has(skill) ? skill : "";
}

function normalizeAlternatives(value, selectedSkill) {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((item) => {
      if (typeof item === "string") {
        const skill = normalizeIntentSkill(item);
        return skill && skill !== selectedSkill ? { skill, confidence: 0 } : null;
      }
      const skill = normalizeIntentSkill(item?.skill || item?.intent);
      return skill && skill !== selectedSkill
        ? {
            skill,
            intent: skill,
            confidence: Number(item?.confidence) || 0,
            reason: String(item?.reason || ""),
          }
        : null;
    })
    .filter(Boolean)
    .slice(0, 3);
}

function needsIntentConfirmation(decision) {
  if (!OPERATION_INTENT_SKILLS.has(decision.skill)) return false;
  if (HIGH_RISK_INTENT_SKILLS.has(decision.skill)) return true;
  return Number(decision.confidence || 0) < DIRECT_OPERATION_CONFIDENCE;
}

function normalizeIntentDecision(raw, extra = {}) {
  const skill = normalizeIntentSkill(raw?.skill || raw?.intent) || "answer_general_chat";
  const confidence = Math.max(0, Math.min(1, Number(raw?.confidence) || (skill === "answer_general_chat" ? 0.6 : 0.75)));
  const decision = {
    intent: skill,
    skill,
    confidence,
    source: String(raw?.source || extra.source || "local"),
    reason: String(raw?.reason || ""),
    alternatives: normalizeAlternatives(raw?.alternatives, skill),
    ...extra,
  };
  decision.needsConfirmation = Boolean(extra.confirmed)
    ? false
    : Boolean(raw?.needsConfirmation ?? needsIntentConfirmation(decision));
  return decision;
}

export function isConfirmedSkillAllowed(value) {
  return OPERATION_INTENT_SKILLS.has(normalizeIntentSkill(value));
}

function confirmedIntentDecision(value) {
  const skill = normalizeIntentSkill(value);
  if (!OPERATION_INTENT_SKILLS.has(skill)) return null;
  return normalizeIntentDecision({
    intent: skill,
    skill,
    confidence: 1,
    source: "confirmed",
    reason: "用户已确认执行该操作。",
    needsConfirmation: false,
  }, { confirmed: true });
}

function isStatusIntent(text) {
  const value = String(text || "");
  return (
    /(查询|查看|看一下|看看|查一下).*(培训|学习|考试|任务|进度|完成情况|成绩|报表|状态)/.test(value) ||
    /(培训|学习|考试|任务).*(进度|完成情况|成绩|报表|状态|谁完成|谁没完成|未完成|完成率|平均分)/.test(value) ||
    /(谁完成|谁没完成|未完成|完成率|平均分|培训报表|学习报表|考试成绩)/.test(value)
  );
}

function isTrainingDraftIntent(text) {
  const value = String(text || "");
  return (
    /(发布|安排|创建|新建|布置|分配|指派|制定|建).*(培训|学习|考试|课程|题|计划|考察)/.test(value) ||
    /给.+(培训|学习|考试|课程|考察)/.test(value) ||
    /(出|生成|做)\s*\d+\s*(道)?\s*(题|考题|试题)/.test(value) ||
    /(全部|所有|全员|全体).*(培训|学习|考试|课程|考察)/.test(value) ||
    /(培训|学习|考试|课程).*(全部|所有|全员|全体|员工|人员)/.test(value) ||
    /(及格|通过分数|截止时间|员工专属链接)/.test(value)
  );
}

function localIntent(message) {
  const text = String(message || "");
  if (/(删除|删掉|清空|清除|清理|移除|作废|撤销).*(培训记录|培训任务|任务记录|学习记录|考试记录|记录)|(?:培训记录|培训任务|任务记录|学习记录|考试记录).*(删除|删掉|清空|清除|清理|移除|作废|撤销)/.test(text)) {
    return normalizeIntentDecision({ intent: "delete_training_records", confidence: 0.95, skill: "delete_training_records", source: "local", reason: "命中删除培训记录关键词。" });
  }
  if (isStatusIntent(text)) {
    return normalizeIntentDecision({ intent: "show_training_status", confidence: 0.82, skill: "show_training_status", source: "local", reason: "命中培训进度或成绩查询关键词。" });
  }
  if (isMarketingArticleIntent(text)) {
    return normalizeIntentDecision({ intent: "generate_marketing_article", confidence: 0.86, skill: "generate_marketing_article", source: "local", reason: "命中营销文章生成关键词。" });
  }
  if (isTrainingDraftIntent(text)) {
    return normalizeIntentDecision({ intent: "create_training_draft", confidence: 0.84, skill: "create_training_draft", source: "local", reason: "命中培训发布或出题安排关键词。" });
  }
  return normalizeIntentDecision({ intent: "answer_general_chat", confidence: 0.6, skill: "answer_general_chat", source: "local", reason: "未命中操作意图规则。" });
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

export async function classifyTrainingIntent(state, message, options = {}) {
  const confirmed = confirmedIntentDecision(options.confirmedSkill);
  if (confirmed) return confirmed;

  const local = localIntent(message);
  if (local.skill !== "answer_general_chat" && local.confidence >= LOCAL_BYPASS_CONFIDENCE) return local;
  if (!["1", "true", "on", "yes"].includes(String(process.env.TRAINING_LLM_INTENT_ROUTER || "").toLowerCase())) {
    return local;
  }

  const kbList = state.knowledgeBases
    .filter((kb) => kb.status === "ready")
    .map((kb) => ({ id: kb.id, name: kb.name, aliases: kb.aliases || [] }));
  const employeeList = state.employees
    .filter((employee) => employee.status === "active")
    .map((employee) => ({ name: employee.name, department: employee.department, role: employee.role, aliases: employee.aliases || [] }));
  const profile = AI_PROFILE.intent;
  const prompt = `你是苏州钜洲工业有限公司培训系统的意图路由器。优先使用 DeepSeek V4 Flash（如当前 OpenClaw 会话配置可用）并使用 ${profile.thinking} 思考强度。

只能输出 JSON，不要输出解释。

可调用 skill：
1. create_training_draft：用户要发布、安排、生成、制定培训计划，或要求出题、考试、考察、给员工学习。
2. show_training_status：用户要查培训进度、完成情况、成绩、报表。
3. delete_training_records：用户要删除、清空、移除、作废培训记录或培训任务。
4. generate_marketing_article：用户要写软文、营销文章、推广文案、公众号文章、产品介绍、宣传文案或客户文章。
5. answer_general_chat：其他普通聊天、解释系统、闲聊、咨询“你是谁”等不执行系统操作的问题。

判定规则：
- 只有明确要求培训、学习、考试、员工链接或出题，才选 create_training_draft。
- “重新输入：给某人发布培训...”是新的 create_training_draft，不是确认发布。
- “确认发布/可以/发吧”这类短确认语不是后端 skill，由前端已有草稿处理；没有上下文时选 answer_general_chat。
- 删除、清空、作废培训记录必须选 delete_training_records，但系统会再让用户确认。
- 普通聊天不要因为出现“查看/生成/介绍”就误判为操作。

输出格式：{"intent":"create_training_draft|show_training_status|delete_training_records|generate_marketing_article|answer_general_chat","skill":"create_training_draft|show_training_status|delete_training_records|generate_marketing_article|answer_general_chat","confidence":0到1,"reason":"一句话原因","alternatives":[{"skill":"备选skill","confidence":0到1,"reason":"一句话原因"}]}

已导入知识库：${JSON.stringify(kbList)}
员工：${JSON.stringify(employeeList)}
本地规则初判：${JSON.stringify(local)}
用户输入：${JSON.stringify(String(message || ""))}`;
  try {
    const result = await askLlmJson({ purpose: "intent", prompt, profile });
    if (!normalizeIntentSkill(result.data?.intent || result.data?.skill)) return local;
    const decision = normalizeIntentDecision(result.data, {
      source: result.source || "llm",
      runId: result.runId,
      thinking: result.thinking,
      model: result.model,
      sessionPatch: result.sessionPatch,
    });
    if (decision.skill) return decision;
  } catch {
  }
  return local;
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
    chunkId: chunk.matchedChunkId || chunk.chunkId || chunk.id,
    parentId: chunk.parentId || null,
    matchedChunkId: chunk.matchedChunkId || chunk.chunkId || null,
    documentId: chunk.documentId,
    sourceRef: chunk.sourceRef,
    score: chunk.score,
    retrieval: chunk.retrieval,
    keywordScore: chunk.keywordScore,
    semanticScore: chunk.semanticScore,
    matchedPreview: chunk.matchedPreview || "",
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
      generatedBy: "none",
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
  if (!chunks.length) throw new Error("当前知识库没有检索到足够相关的资料，已停止回答。");
  return await generateStrictKnowledgeAnswer({ knowledgeBaseId, question: text, chunks });
}

function requestedWebSearch(instruction) {
  return /(联网|网上|网络|搜索|查一下|查找|检索|最新|外部资料|行业趋势|竞品|市场数据)/.test(String(instruction || ""));
}

function marketingSubjectText(instruction) {
  return String(instruction || "")
    .replace(/联网|网上|网络|搜索|查一下|查找|检索|最新|外部资料|行业趋势|竞品|市场数据/g, " ")
    .replace(/写|生成|做|来|出|整理|创作|给我|帮我|一篇|关于|基于|根据/g, " ")
    .replace(/软文|营销文章|推广文案|公众号文章|产品介绍|宣传文案|客户文章|宣传稿|营销稿|官网文章|推文|文章|文案/g, " ")
    .replace(/短一点|简短|详细|完整|客户营销|客户|官网|公众号|朋友圈|阿里国际站|B2B|b2b|平台/g, " ")
    .replace(/[，,。.!！?？:：；;\s]+/g, " ")
    .trim();
}

function matchMarketingKnowledgeBase(state, instruction) {
  const text = String(instruction || "").toLowerCase();
  const subject = marketingSubjectText(instruction);
  const ready = (state.knowledgeBases || []).filter((kb) => kb.status === "ready");
  const scored = ready.map((kb) => {
    const names = uniqueStrings([
      kb.name,
      String(kb.name || "").replace(/资料库|培训资料库|培训/g, ""),
      ...(kb.aliases || []),
    ]).filter((item) => item.length >= 2);
    let score = 0;
    let explicitNameMatch = false;
    for (const name of names) {
      const normalized = name.toLowerCase();
      if (normalized && text.includes(normalized)) {
        explicitNameMatch = true;
        score += normalized.length >= 4 ? 6 : 3;
      }
    }
    let chunkScore = 0;
    if (subject.length >= 2) {
      const matches = searchChunks(state, { knowledgeBaseId: kb.id, query: subject, limit: 3 });
      chunkScore = matches.reduce((sum, chunk) => sum + Number(chunk.score || 0), 0);
      score += chunkScore;
    }
    return { kb, score, explicitNameMatch, chunkScore };
  }).sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best) return null;
  if (best.explicitNameMatch) return best.kb;
  return best.chunkScore >= 4 ? best.kb : null;
}

function articleChannel(instruction) {
  const text = String(instruction || "");
  if (/朋友圈|私域|微信/.test(text)) return "朋友圈/私域";
  if (/公众号|推文/.test(text)) return "公众号";
  if (/阿里|国际站|B2B|b2b|平台/.test(text)) return "B2B平台";
  if (/官网|网站/.test(text)) return "官网";
  return "官网/公众号/B2B平台";
}

function articleLengthInstruction(instruction) {
  const text = String(instruction || "");
  if (/短一点|简短|朋友圈|300字|五百字|500字/.test(text)) return "300-600字";
  if (/长文|详细|深度|完整|1500|一千五|2000|两千/.test(text)) return "1200-1600字";
  return "800-1200字";
}

function insufficientMarketingArticle(message, warnings = []) {
  return {
    title: "资料不足，无法生成软文",
    summary: message,
    article: message,
    sellingPoints: [],
    sourceRefs: [],
    warnings,
    generatedBy: "none",
    retrievalMode: "none",
    insufficient: true,
    generatedAt: new Date().toISOString(),
  };
}

export async function generateMarketingArticle(state, { instruction }) {
  const text = String(instruction || "").trim();
  const webSearchDisabled = requestedWebSearch(text);
  const warnings = webSearchDisabled ? ["当前版本未开启联网搜索，已仅基于本地知识库生成。"] : [];
  const knowledgeBase = matchMarketingKnowledgeBase(state, text);
  if (!knowledgeBase) {
    const prefix = webSearchDisabled ? "当前版本未开启联网搜索，且" : "";
    return insufficientMarketingArticle(`${prefix}本地知识库没有匹配到足够相关的产品资料，无法生成软文。`, warnings);
  }

  const chunks = await selectContextChunksHybrid(state, {
    knowledgeBaseId: knowledgeBase.id,
    query: text,
    limit: 16,
  });
  if (!chunks.length) {
    return insufficientMarketingArticle("本地知识库没有检索到足够相关的资料，无法生成软文。", warnings);
  }

  const sourceRefs = allowedSourceRefs(chunks);
  const profile = AI_PROFILE.marketingArticle;
  const articleSchema = {
    title: "营销文章标题",
    summary: "80-150字摘要",
    article: "完整营销文章正文，按自然段换行",
    sellingPoints: ["3-6个真实卖点"],
    sourceRefs: ["必须来自给定来源列表"],
    warnings: ["资料不足或表达限制"],
  };
  const prompt = `你是工业品营销内容策划。请基于给定资料，为客户营销场景生成一篇真实可信的中文软文。

硬性要求：
- 只允许依据给定资料，不要编造资料外事实，不要假装联网搜索。
- ${webSearchDisabled ? "用户提到了联网搜索，但当前系统没有联网搜索能力；文章只能写本地资料已支持的内容。" : "不要引用互联网、行业报告或未给出的市场数据。"}
- 文章面向客户营销，适合${articleChannel(text)}，正文长度${articleLengthInstruction(text)}。
- 语言要有销售转化感，但避免夸大、绝对化承诺和虚假排名。
- sourceRefs 必须从这个列表中选择：${JSON.stringify(sourceRefs)}
- 只能输出 JSON，不要 Markdown 包裹。

输出格式：${JSON.stringify(articleSchema)}

用户需求：${JSON.stringify(text)}
知识库：${JSON.stringify({ id: knowledgeBase.id, name: knowledgeBase.name, description: knowledgeBase.description || "", aliases: knowledgeBase.aliases || [] })}
资料上下文：
${renderContext(chunks)}`;

  try {
    const result = await askLlmStructured({ purpose: `marketing:${knowledgeBase.id}:${Date.now()}`, prompt, profile, repairSchema: articleSchema });
    if (!result.data) throw modelRequiredError("营销软文生成", result.error || "大模型未返回结构化软文");
    const data = result.data || {};
    const article = cleanAnswerText(data.article);
    if (!article) throw modelRequiredError("营销软文生成", "大模型没有返回可显示正文");
    const normalizedSourceRefs = normalizeSourceRefs(data.sourceRefs, chunks);
    const modelWarnings = Array.isArray(data.warnings) ? data.warnings : [data.warnings].filter(Boolean);
    return {
      title: compactText(data.title || `${knowledgeBase.name}营销软文`, 120),
      summary: compactMultiline(data.summary, 360),
      article: compactMultiline(article, 5200),
      sellingPoints: uniqueStrings(data.sellingPoints).map((item) => cleanTrainingText(item)).filter(Boolean).slice(0, 8),
      sourceRefs: normalizedSourceRefs,
      warnings: uniqueStrings([...warnings, ...modelWarnings]).slice(0, 8),
      sources: sourceObjects(chunks).filter((source) => normalizedSourceRefs.includes(source.sourceRef)),
      knowledgeBase: {
        id: knowledgeBase.id,
        name: knowledgeBase.name,
      },
      generatedBy: result.source || "openclaw",
      thinking: result.thinking || profile.thinking,
      model: result.model || profile.model,
      sessionPatch: result.sessionPatch,
      runId: result.runId,
      repaired: result.repaired === true,
      retrievalMode: retrievalModeFromChunks(chunks),
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    throw modelRequiredError("营销软文生成", error);
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
  } catch (error) {
    throw modelRequiredError("培训讲义生成", error);
  }
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
