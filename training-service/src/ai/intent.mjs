import { AI_PROFILE } from "./config.mjs";
import { askLlmJson } from "./llm-json.mjs";
import { getBossChatSession } from "../boss-chat/store.mjs";
import { matchKnowledgeBase } from "../domain/knowledge.mjs";
import { searchKnowledgeContexts } from "../rag.mjs";

const KNOWN_INTENT_SKILLS = new Set([
  "create_training_draft",
  "show_training_status",
  "delete_training_records",
  "generate_marketing_article",
  "translate_text",
  "answer_knowledge_question",
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
const FOLLOW_UP_RE = /^(有吗|有具体(?:型号)?吗?|具体型号(?:吗)?|还有吗|继续|展开|详细点|有哪些|多少|区别呢|那这个呢|这个呢|参数呢|型号呢)[？?。.\s]*$/i;
const SYSTEM_CHAT_RE = /(这个系统|本系统|这个项目|你是谁|怎么工作|功能|页面|聊天助手|agent|Agent)/i;
const KNOWLEDGE_QUESTION_RE = /(是什么|为什么|怎么|如何|哪些|多少|有什么|有啥|区别|优势|作用|含义|解释|介绍|参数|范围|型号|效率|结构|工艺|选型|标准|系列|组成|原理|关系|检索|搜索|查询|查找|资料|相关知识|\?|？)/i;
const MOTOR_DOMAIN_RE = /(电机|电动机|异步|三相|单相|定子|转子|绕组|铁芯|铸铝|机座|铭牌|能效|YE\d|Y2|IE\d|WONDER|motor|rotor|stator|power|efficiency|frame|pole)/i;
const PUMP_DOMAIN_RE = /(水泵|泵|离心泵|增压泵|自吸泵|喷射泵|射流泵|旋涡泵|漩涡泵|管道泵|潜水泵|污水泵|多级泵|扬程|流量|吸程|口径|叶轮|YINJIA|银嘉|pump|centrifugal|peripheral|jet|booster|submersible)/i;
const PUMP_MODEL_RE = /\b(?:VM|IDB|QB|WZB|SPM|APM|PM|JLM|JETB|JSW|JSM|JETS|CM|CM2|CDL|CDLF|CPM|SCM|CHM|YMP|YMPV|PS|QDX|WQD|4SKM|SKM)\d*[A-Z0-9-]*\b/i;
const SHORT_PUBLISH_CONFIRM_RE = /^(确认发布|确认|可以|可以了|发吧|发布吧|没问题|就这样|好的|好|ok|OK|yes|Yes)[。.!！\s]*$/;
const TEXT_EDIT_DELETE_RE = /(?:这句(?:话)?|这段(?:话|文字)?|文本|句子|标题|文案|文章)[\s\S]{0,40}(?:字|词|字符|措辞)[\s\S]{0,20}(?:删除|删掉|去掉|移除)|(?:删除|删掉|去掉|移除)[\s\S]{0,40}(?:这句(?:话)?|这段(?:话|文字)?|文本|句子|标题|文案|文章|字|词|字符|措辞)/i;
const DOMAIN_CORRECTION_RE = /(?:(?:这是|应该是)\s*(?:水泵|泵|电机).{0,12}(?:不是|而不是|别用|不要用)\s*(?:水泵|泵|电机)|(?:不是|别用|不要用)\s*(?:水泵|泵|电机).{0,12}(?:是|而是|应该是)\s*(?:水泵|泵|电机))/i;

function normalizeIntentSkill(value) {
  const skill = String(value || "").trim();
  if (skill === "query_training_status") return "show_training_status";
  if (skill === "general_chat") return "answer_general_chat";
  if (skill === "knowledge_answer") return "answer_knowledge_question";
  if (skill === "translation" || skill === "translate") return "translate_text";
  return KNOWN_INTENT_SKILLS.has(skill) ? skill : "";
}

function normalizeAlternatives(value, selectedSkill) {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((item) => {
      if (typeof item === "string") {
        const skill = normalizeIntentSkill(item);
        return skill && skill !== selectedSkill ? { skill, intent: skill, confidence: 0 } : null;
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

function isIntentRouterEnabled() {
  return !["0", "false", "off", "no"].includes(String(process.env.TRAINING_LLM_INTENT_ROUTER || "on").toLowerCase());
}

function isStatusIntent(text) {
  const value = String(text || "");
  return (
    /(查询|查看|看一下|看看|查一下).*(培训|学习|考试|任务).*(进度|完成情况|成绩|报表|状态|谁完成|谁没完成|未完成|完成率|平均分)/.test(value) ||
    /(培训|学习|考试|任务).*(进度|完成情况|成绩|报表|状态|谁完成|谁没完成|未完成|完成率|平均分)/.test(value) ||
    /(谁完成|谁没完成|未完成|完成率|平均分|培训报表|学习报表|考试成绩)/.test(value)
  );
}

function isTrainingDraftIntent(text) {
  const value = String(text || "");
  return (
    /(发布|安排|创建|新建|布置|分配|指派|制定|给).*(培训|学习|考试|课程|题|计划|考核)/.test(value) ||
    /给.+(培训|学习|考试|课程|考核)/.test(value) ||
    /(出|生成|做)\s*\d+\s*(道)?\s*(题|考题|试题)/.test(value) ||
    /(全部|所有|全员|全体).*(培训|学习|考试|课程|考核)/.test(value) ||
    /(培训|学习|考试|课程).*(全部|所有|全员|全体|员工|人员)/.test(value) ||
    /(及格|通过分数|截止时间|员工专属链接)/.test(value)
  );
}

function isMarketingArticleIntent(text) {
  const value = String(text || "");
  if (/(培训|考试|试题|考题|学习|课程)/.test(value)) return false;
  const hasMarketingTerm = /(软文|营销文章|推广文案|公众号文章|产品介绍|宣传文案|客户文章|宣传文章|营销文|官网文章|独立站|独立站文章|推文|B2B\s*文案|b2b\s*文案|英文文章|blog|article|copywriting|marketing copy)/i.test(value);
  const asksWriting = /(写|生成|做|来|出|整理|创作|撰写|输出|帮我|请帮我|write|generate|create|produce)/i.test(value);
  const articleShape = /(\d+\s*篇|三篇|两篇|一篇|500\s*词|五百词|标题如下|文章标题|中英双语|附带中文翻译|英文)/i.test(value);
  return hasMarketingTerm || (asksWriting && articleShape && /(文章|宣传|营销|推广|独立站|官网|水泵|泵|电机|产品)/i.test(value));
}

function isPrimaryTranslationIntent(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (isMarketingArticleIntent(value) && /(附带中文翻译|中文翻译|中英双语|同时.*翻译|翻译版)/.test(value)) return false;
  if (/^(翻译|帮我翻译|请翻译|译成|译为|translate\s+(?:to|into)\b|translation\b)/i.test(value)) return true;
  if (/^把[\s\S]{1,12000}?翻译成[^\n：:]+/i.test(value)) return true;
  if (/^[\s\S]{1,12000}?\s+(翻译成|译成|translate\s+(?:to|into))\s*[^\n：:]+$/i.test(value) && !/(文章|软文|宣传|营销|文案)/.test(value)) return true;
  return false;
}

function localIntent(message) {
  const text = String(message || "");
  if (/(删除|删掉|清空|清除|清理|移除|作废|撤销).*(培训记录|培训任务|任务记录|学习记录|考试记录|记录)|(?:培训记录|培训任务|任务记录|学习记录|考试记录).*(删除|删掉|清空|清除|清理|移除|作废|撤销)/.test(text)) {
    return normalizeIntentDecision({ intent: "delete_training_records", confidence: 0.95, skill: "delete_training_records", source: "local", reason: "命中删除培训记录关键词。" });
  }
  if (isStatusIntent(text)) {
    return normalizeIntentDecision({ intent: "show_training_status", confidence: 0.82, skill: "show_training_status", source: "local", reason: "命中培训进度或成绩查询关键词。" });
  }
  if (isPrimaryTranslationIntent(text)) {
    return normalizeIntentDecision({ intent: "translate_text", confidence: 0.9, skill: "translate_text", source: "local", reason: "命中明确翻译请求。" });
  }
  if (isMarketingArticleIntent(text)) {
    return normalizeIntentDecision({ intent: "generate_marketing_article", confidence: 0.82, skill: "generate_marketing_article", source: "local", reason: "命中营销文章生成语义。" });
  }
  if (isTrainingDraftIntent(text)) {
    return normalizeIntentDecision({ intent: "create_training_draft", confidence: 0.84, skill: "create_training_draft", source: "local", reason: "命中培训发布或出题安排关键词。" });
  }
  return normalizeIntentDecision({ intent: "answer_general_chat", confidence: 0.6, skill: "answer_general_chat", source: "local", reason: "未命中高置信本地操作意图。" });
}

function shortPublishConfirmationDecision(message) {
  if (!SHORT_PUBLISH_CONFIRM_RE.test(String(message || "").trim())) return null;
  return normalizeIntentDecision({
    intent: "answer_general_chat",
    skill: "answer_general_chat",
    confidence: 1,
    source: "confirmation_guard",
    reason: "短确认语由前端草稿卡片处理；没有 confirmedSkill 时后端不执行发布或创建草稿。",
    needsConfirmation: false,
  });
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function knowledgeNames(kb = {}) {
  return uniqueStrings([
    kb.name,
    String(kb.name || "").replace(/资料库|培训资料库|培训/g, ""),
    kb.description,
    ...(kb.aliases || []),
  ]).filter((value) => value.length >= 2);
}

function explicitlyMentionsKnowledgeBase(kb, text) {
  const value = String(text || "").toLowerCase();
  return knowledgeNames(kb).some((name) => value.includes(name.toLowerCase()));
}

function kbText(kb = {}) {
  return `${kb.id || ""} ${kb.name || ""} ${kb.description || ""} ${(kb.aliases || []).join(" ")}`.toLowerCase();
}

function isPumpKnowledgeBase(kb) {
  return /(水泵|泵|银嘉|yinjia|pump)/i.test(kbText(kb));
}

function isMotorKnowledgeBase(kb) {
  return /(电机|电动机|motor|wonder)/i.test(kbText(kb));
}

function queryHints(text, options = {}) {
  const value = String(text || "");
  const recentKbId = String(options.recentKnowledgeBaseId || "");
  const motorNegated = /(不是|非|别用|不要用|不是.*而是|这是).{0,8}(电机|motor)|(?:电机|motor).{0,8}(不是|不对|错了)/i.test(value);
  const pumpPositive = PUMP_DOMAIN_RE.test(value) || PUMP_MODEL_RE.test(value) || /(这是|用|按|基于).{0,8}(水泵|泵|银嘉|YINJIA)/i.test(value);
  const motorPositive = MOTOR_DOMAIN_RE.test(value) && !motorNegated;
  return {
    motorNegated,
    pumpPositive,
    motorPositive,
    followUp: FOLLOW_UP_RE.test(value),
    recentKnowledgeBaseId: recentKbId,
  };
}

function safeState(state = {}) {
  return {
    ...state,
    knowledgeBases: Array.isArray(state.knowledgeBases) ? state.knowledgeBases : [],
    chunks: Array.isArray(state.chunks) ? state.chunks : [],
    chunkParents: Array.isArray(state.chunkParents) ? state.chunkParents : [],
    employees: Array.isArray(state.employees) ? state.employees : [],
  };
}

function knowledgeHitScore(hit = {}) {
  hit = hit || {};
  const score = Number(hit.score || 0);
  const bm25 = Number(hit.bm25Score || hit.keywordScore || 0);
  const semantic = Number(hit.semanticScore || 0);
  const exactIdentifierBoost = Number(hit.exactIdentifierBoost || 0);
  const evidenceSufficient = hit.evidenceSufficiency?.sufficient === true;
  const retrieval = String(hit.retrieval || "");
  if (/(semantic|hybrid|local-vector|vector)/.test(retrieval)) {
    return Math.max(score, semantic, bm25 >= 4 ? 0.7 : 0, exactIdentifierBoost > 0 ? 0.78 : 0, evidenceSufficient ? 0.68 : 0);
  }
  return Math.max(score >= 4 ? 0.72 : 0, bm25 >= 4 ? 0.72 : 0, exactIdentifierBoost > 0 ? 0.78 : 0, evidenceSufficient ? 0.68 : 0);
}

function hasKnowledgeIntentSignal(text, explicitMatch, hints = {}) {
  const value = String(text || "");
  if (!value.trim()) return false;
  if (SYSTEM_CHAT_RE.test(value) && !MOTOR_DOMAIN_RE.test(value) && !PUMP_DOMAIN_RE.test(value) && !PUMP_MODEL_RE.test(value) && !explicitMatch && !hints.followUp) return false;
  return explicitMatch
    || ((MOTOR_DOMAIN_RE.test(value) || PUMP_DOMAIN_RE.test(value) || PUMP_MODEL_RE.test(value)) && KNOWLEDGE_QUESTION_RE.test(value))
    || (hints.followUp && Boolean(hints.recentKnowledgeBaseId));
}

function hintMatchesKnowledgeBase(kb, hint) {
  const value = String(hint || "").toLowerCase();
  if (!value) return false;
  return knowledgeNames(kb).some((name) => value.includes(name.toLowerCase()) || name.toLowerCase().includes(value));
}

function knowledgeBaseIdFromPayload(payload = {}) {
  return payload.knowledgeBase?.id
    || payload.article?.knowledgeBase?.id
    || payload.draft?.knowledgeBase?.id
    || payload.result?.knowledgeBase?.id
    || payload.decision?.knowledgeBaseId
    || payload.article?.decision?.knowledgeBaseId
    || payload.draft?.decision?.knowledgeBaseId
    || "";
}

function knowledgeBaseIdFromText(state, value) {
  const text = String(value || "").toLowerCase();
  if (!text) return "";
  for (const kb of safeState(state).knowledgeBases) {
    if (knowledgeNames(kb).some((name) => {
      const item = String(name || "").toLowerCase().trim();
      return item && text.includes(item);
    })) {
      return kb.id;
    }
  }
  return "";
}

async function recentKnowledgeBaseIdFromBossChat(sessionId, state) {
  if (!sessionId) return "";
  try {
    const session = await getBossChatSession(sessionId);
    const messages = session?.messages || [];
    for (const message of [...messages].reverse()) {
      const payload = message.payload || {};
      const id = knowledgeBaseIdFromPayload(payload) || knowledgeBaseIdFromText(state, message.content);
      if (id) return String(id);
    }
  } catch {
  }
  return "";
}

async function selectKnowledgeBaseForQuestion(state, message, options = {}) {
  const currentState = safeState(state);
  const ready = currentState.knowledgeBases.filter((kb) => kb.status === "ready");
  if (!ready.length || !currentState.chunks.length) return null;

  const text = String(message || "").trim();
  const hints = queryHints(text, options);
  const targetHint = String(options.targetKnowledgeBaseHint || options.routerDecision?.targetKnowledgeBaseHint || "").trim();
  const directMatch = matchKnowledgeBase(currentState, text);
  const scored = [];

  for (const kb of ready) {
    const explicitMatch = explicitlyMentionsKnowledgeBase(kb, text) || hintMatchesKnowledgeBase(kb, targetHint) || directMatch?.id === kb.id;
    if (!hasKnowledgeIntentSignal(text, explicitMatch, hints)) continue;
    const followUpContext = hints.followUp && hints.recentKnowledgeBaseId === kb.id
      ? knowledgeNames(kb).join(" ")
      : "";
    const query = [text, targetHint, followUpContext].filter(Boolean).join("\n");
    let hits = [];
    try {
      hits = await searchKnowledgeContexts(currentState, { knowledgeBaseId: kb.id, query, limit: 4 });
    } catch {
      hits = [];
    }
    const top = hits[0] || null;
    let confidence = knowledgeHitScore(top);
    if (explicitMatch) confidence += 0.12;
    if (hints.recentKnowledgeBaseId === kb.id && hints.followUp) confidence += 0.2;
    if (hints.pumpPositive && isPumpKnowledgeBase(kb)) confidence += 0.25;
    if (hints.motorPositive && isMotorKnowledgeBase(kb)) confidence += 0.16;
    if (hints.motorNegated && isMotorKnowledgeBase(kb)) confidence -= 0.5;
    if (hints.pumpPositive && isMotorKnowledgeBase(kb) && !PUMP_DOMAIN_RE.test(kbText(kb))) confidence -= 0.18;
    if (top && confidence >= (explicitMatch || hints.followUp ? 0.45 : 0.62)) {
      scored.push({ kb, top, confidence: Math.max(0, Math.min(1, confidence)), explicitMatch, hints });
    }
  }
  if (!scored.length && (targetHint || (hints.followUp && hints.recentKnowledgeBaseId))) {
    const preferred = ready.filter((kb) => (
      kb.id === hints.recentKnowledgeBaseId || hintMatchesKnowledgeBase(kb, targetHint)
    ));
    for (const kb of preferred) {
      let hits = [];
      try {
        hits = await searchKnowledgeContexts(currentState, {
          knowledgeBaseId: kb.id,
          query: [text, targetHint].filter(Boolean).join("\n"),
          limit: 4,
        });
      } catch {
        hits = [];
      }
      const top = hits[0] || null;
      if (!top) continue;
      const explicitMatch = hintMatchesKnowledgeBase(kb, targetHint);
      let confidence = knowledgeHitScore(top);
      if (explicitMatch) confidence += 0.12;
      if (hints.followUp && kb.id === hints.recentKnowledgeBaseId) confidence += 0.2;
      if (confidence >= 0.45) {
        scored.push({ kb, top, confidence: Math.max(0, Math.min(1, confidence)), explicitMatch, hints });
      }
    }
  }
  scored.sort((left, right) => right.confidence - left.confidence);
  return scored[0] || null;
}

function preferredKnowledgeBaseForQuestion(state, message, options = {}) {
  const currentState = safeState(state);
  const ready = currentState.knowledgeBases.filter((kb) => kb.status === "ready");
  if (!ready.length) return null;
  const text = String(message || "").trim();
  const hints = queryHints(text, options);
  const targetHint = String(options.targetKnowledgeBaseHint || options.routerDecision?.targetKnowledgeBaseHint || "").trim();
  if (hints.pumpPositive && hints.motorNegated) {
    const correctedPump = ready.find(isPumpKnowledgeBase);
    if (correctedPump) return correctedPump;
  }
  const targetMatch = targetHint ? matchKnowledgeBase(currentState, targetHint) : null;
  if (targetMatch && ready.some((kb) => kb.id === targetMatch.id)) return targetMatch;
  if (hints.followUp && hints.recentKnowledgeBaseId) {
    const recent = ready.find((kb) => kb.id === hints.recentKnowledgeBaseId);
    if (recent) return recent;
  }
  if (hints.pumpPositive) {
    const pump = ready.find(isPumpKnowledgeBase);
    if (pump) return pump;
  }
  if (hints.motorPositive) {
    const motor = ready.find(isMotorKnowledgeBase);
    if (motor) return motor;
  }
  const direct = matchKnowledgeBase(currentState, text);
  if (direct && ready.some((kb) => kb.id === direct.id)) return direct;
  return null;
}

export async function detectKnowledgeAnswerIntent(state, message, options = {}) {
  if (options.skipKnowledgeAnswer) return null;
  const text = String(message || "").trim();
  const selected = await selectKnowledgeBaseForQuestion(state, text, options);
  if (!selected) return null;
  return normalizeIntentDecision({
    intent: "answer_knowledge_question",
    skill: "answer_knowledge_question",
    confidence: Math.max(0.78, Math.min(0.96, selected.confidence)),
    source: selected.explicitMatch ? "knowledge_alias" : "knowledge_retrieval",
    reason: `命中知识库“${selected.kb.name}”相关资料，转为基于来源的答疑。`,
    needsConfirmation: false,
  }, {
    knowledgeBaseId: selected.kb.id,
    knowledgeBaseName: selected.kb.name,
    matchedSourceRef: selected.top.sourceRef || "",
    retrievalScore: Number(selected.top.score || 0),
    retrieval: selected.top.retrieval || "",
  });
}

function applySafetyGate(decision, local) {
  if (!decision) return decision;
  if (
    decision.skill === "answer_knowledge_question"
    && DOMAIN_CORRECTION_RE.test(String(decision.originalMessage || ""))
    && !KNOWLEDGE_QUESTION_RE.test(String(decision.originalMessage || ""))
  ) {
    return normalizeIntentDecision({
      intent: "answer_general_chat",
      skill: "answer_general_chat",
      confidence: 0.98,
      source: "router_guard",
      reason: "用户是在纠正资料领域，不是在提出新的事实问题；先确认纠正并由会话连续性保留新领域。",
      needsConfirmation: false,
    });
  }
  if (decision.skill === "delete_training_records" && TEXT_EDIT_DELETE_RE.test(String(decision.originalMessage || ""))) {
    return normalizeIntentDecision({
      intent: "answer_general_chat",
      skill: "answer_general_chat",
      confidence: 0.98,
      source: "router_guard",
      reason: "用户是在编辑文本，不是删除培训任务或记录。",
      needsConfirmation: false,
    });
  }
  if (HIGH_RISK_INTENT_SKILLS.has(decision.skill)) {
    decision.needsConfirmation = true;
    return decision;
  }
  if (OPERATION_INTENT_SKILLS.has(decision.skill) && Number(decision.confidence || 0) < DIRECT_OPERATION_CONFIDENCE) {
    decision.needsConfirmation = true;
  }
  if (decision.skill === "translate_text" && !isPrimaryTranslationIntent(decision.originalMessage || "")) {
    const text = String(decision.originalMessage || "");
    if (isMarketingArticleIntent(text)) {
      return normalizeIntentDecision({
        intent: "generate_marketing_article",
        skill: "generate_marketing_article",
        confidence: Math.max(0.78, Number(decision.confidence || 0)),
        source: "router_guard",
        reason: "请求包含文章生成和附带翻译要求，归入营销文章 skill。",
      });
    }
  }
  if (
    local?.skill
    && local.skill !== "answer_general_chat"
    && decision.skill === "answer_general_chat"
    && Number(local.confidence || 0) >= 0.8
    && Number(decision.confidence || 0) <= 0.65
  ) {
    return local;
  }
  return decision;
}

function fallbackDecision(state, message, local, options = {}) {
  if (local.skill !== "answer_general_chat") return local;
  return detectKnowledgeAnswerIntent(state, message, options).then((knowledge) => knowledge || local);
}

function routerKnowledgeList(state) {
  return (state.knowledgeBases || [])
    .filter((kb) => kb.status === "ready")
    .map((kb) => ({
      id: kb.id,
      name: kb.name,
      aliases: kb.aliases || [],
      description: kb.description || "",
    }));
}

function routerEmployeeList(state) {
  return (state.employees || [])
    .filter((employee) => employee.status === "active")
    .map((employee) => ({
      name: employee.name,
      department: employee.department,
      role: employee.role,
      aliases: employee.aliases || [],
    }));
}

async function callFastIntentRouter(state, message, local, options = {}) {
  const profile = AI_PROFILE.intent;
  const recentLines = (options.memoryContext?.recentMessages || [])
    .slice(-6)
    .map((entry) => `${entry.role === "assistant" ? "assistant" : "user"}: ${entry.content}`)
    .join("\n");
  const prompt = `你是企业本地 Agent 的快速意图路由器。只输出 JSON，不要输出 Markdown。

可选 skill：
1. create_training_draft：发布、安排、创建培训/学习/考试/出题草稿。
2. show_training_status：查询培训进度、完成情况、成绩和报表。
3. delete_training_records：删除、清空、作废培训任务或培训记录。
4. generate_marketing_article：写软文、宣传文章、独立站文章、官网文章、B2B 文案、产品介绍、推广文案；“附带中文翻译/中英双语/英文文章/多篇文章”仍属于这个 skill 的参数，不是 translate_text。
5. translate_text：纯文本翻译，例如“翻译成英文：xxx”“把 xxx 翻译成法语”。如果用户是在要求写文章并附带翻译，不要选这个。
6. answer_knowledge_question：询问已导入知识库里的产品、型号、参数、工艺、结构、选型、标准、系列、资料内容；比如“检索 CM2 相关知识”“VM22 功率多少”。
7. answer_general_chat：普通聊天、系统说明、非资料库事实咨询。

安全规则：
- 删除记录必须选 delete_training_records，但后端会再次确认。
- 删除句子中的字词、字符或措辞属于文本编辑，不是 delete_training_records。
- 重新输入完整培训安排是 create_training_draft，不是确认发布。
- 用户说“不是电机，是水泵”时，不能选择电机知识库。
- 如果是后续追问，例如“有具体型号吗”，参考最近会话的资料领域。

输出格式：
{"skill":"create_training_draft|show_training_status|delete_training_records|generate_marketing_article|translate_text|answer_knowledge_question|answer_general_chat","confidence":0到1,"targetKnowledgeBaseHint":"水泵/电机/具体知识库名，可空","articleCount":数字或null,"targetLanguage":"目标语言，可空","bilingual":true或false,"reason":"一句话原因","alternatives":[{"skill":"备选skill","confidence":0到1,"reason":"一句话原因"}]}

已导入知识库：${JSON.stringify(routerKnowledgeList(state))}
员工：${JSON.stringify(routerEmployeeList(state))}
本地规则提示（仅参考，不要盲从）：${JSON.stringify(local)}
最近会话摘要：${recentLines || "无"}
记忆提示：${String(options.memoryHint || "").trim() || "无"}
用户输入：${JSON.stringify(String(message || ""))}`;
  const result = await askLlmJson({ purpose: "intent", prompt, profile });
  const skill = normalizeIntentSkill(result.data?.skill || result.data?.intent);
  if (!skill) return null;
  return normalizeIntentDecision(result.data, {
    source: result.source || "llm",
    runId: result.runId,
    thinking: result.thinking,
    model: result.model,
    sessionPatch: result.sessionPatch,
    targetKnowledgeBaseHint: String(result.data?.targetKnowledgeBaseHint || ""),
    articleCount: Number(result.data?.articleCount) || null,
    targetLanguage: String(result.data?.targetLanguage || ""),
    bilingual: result.data?.bilingual === true,
    originalMessage: String(message || ""),
  });
}

export async function classifyTrainingIntent(state, message, options = {}) {
  const confirmed = confirmedIntentDecision(options.confirmedSkill);
  if (confirmed) return confirmed;
  const shortConfirm = shortPublishConfirmationDecision(message);
  if (shortConfirm) return shortConfirm;

  const currentState = safeState(state);
  const local = localIntent(message);
  const recentKnowledgeBaseId = options.recentKnowledgeBaseId
    || await recentKnowledgeBaseIdFromBossChat(options.sessionId || options.memoryContext?.sessionId || "", currentState);
  const knowledgeOptions = {
    ...options,
    recentKnowledgeBaseId,
  };

  if (!isIntentRouterEnabled()) {
    return await fallbackDecision(currentState, message, local, knowledgeOptions);
  }

  try {
    let decision = await callFastIntentRouter(currentState, message, local, {
      ...knowledgeOptions,
      memoryContext: options.memoryContext,
    });
    if (!decision) return await fallbackDecision(currentState, message, local, knowledgeOptions);

    decision = applySafetyGate(decision, local);
    if (decision.skill === "answer_general_chat" && Number(decision.confidence || 0) <= 0.65) {
      const fallback = await fallbackDecision(currentState, message, local, knowledgeOptions);
      if (fallback.skill !== "answer_general_chat") return fallback;
    }
    if (decision.skill === "answer_knowledge_question") {
      const knowledge = await detectKnowledgeAnswerIntent(currentState, message, {
        ...knowledgeOptions,
        targetKnowledgeBaseHint: decision.targetKnowledgeBaseHint,
        routerDecision: decision,
      });
      if (knowledge) {
        return normalizeIntentDecision({
          ...decision,
          confidence: Math.max(Number(decision.confidence || 0), Number(knowledge.confidence || 0)),
          reason: `${decision.reason || "快速路由判定为知识库答疑"} 已通过 RAG 证据校验。`,
          needsConfirmation: false,
        }, {
          source: decision.source === "local" ? knowledge.source : `${decision.source}+rag`,
          knowledgeBaseId: knowledge.knowledgeBaseId,
          knowledgeBaseName: knowledge.knowledgeBaseName,
          matchedSourceRef: knowledge.matchedSourceRef,
          retrievalScore: knowledge.retrievalScore,
          retrieval: knowledge.retrieval,
        });
      }
      const preferredKnowledgeBase = preferredKnowledgeBaseForQuestion(currentState, message, {
        ...knowledgeOptions,
        targetKnowledgeBaseHint: decision.targetKnowledgeBaseHint,
        routerDecision: decision,
      });
      if (preferredKnowledgeBase) {
        return normalizeIntentDecision({
          ...decision,
          confidence: Math.max(0.72, Number(decision.confidence || 0)),
          reason: `${decision.reason || "快速路由判定为知识库答疑"} 已锁定资料域；证据充分性由答疑工具继续校验。`,
          needsConfirmation: false,
        }, {
          source: `${decision.source || "router"}+kb_hint`,
          knowledgeBaseId: preferredKnowledgeBase.id,
          knowledgeBaseName: preferredKnowledgeBase.name,
          matchedSourceRef: "",
          retrievalScore: 0,
          retrieval: "kb_hint",
        });
      }
      return normalizeIntentDecision({
        intent: "answer_general_chat",
        skill: "answer_general_chat",
        confidence: 0.55,
        source: "router_rag_guard",
        reason: "快速路由判断为知识库问题，但本地 RAG 没有足够证据，改为普通聊天/澄清。",
      });
    }
    return decision;
  } catch {
    return await fallbackDecision(currentState, message, local, knowledgeOptions);
  }
}
