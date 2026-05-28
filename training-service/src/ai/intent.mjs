import { AI_PROFILE } from "./config.mjs";
import { askLlmJson } from "./llm-json.mjs";

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

function appendDecisionReason(decision, reason) {
  const current = String(decision.reason || "").trim();
  decision.reason = current ? `${current} ${reason}` : reason;
}

function applyIntentConflictGuard(decision, local) {
  if (!decision || !OPERATION_INTENT_SKILLS.has(decision.skill)) return decision;
  if (HIGH_RISK_INTENT_SKILLS.has(decision.skill)) {
    decision.needsConfirmation = true;
    return decision;
  }
  if (!local || local.skill === decision.skill) return decision;
  decision.needsConfirmation = true;
  if (local.skill === "answer_general_chat") {
    appendDecisionReason(decision, "该操作仅由 LLM 路由识别，已要求用户确认以避免误触发。");
    return decision;
  }
  decision.alternatives = normalizeAlternatives([local, ...(decision.alternatives || [])], decision.skill);
  appendDecisionReason(decision, `本地规则候选为 ${local.skill}，已要求用户确认。`);
  return decision;
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
    /(查询|查看|看一下|看看|查一下).*(培训|学习|考试|任务).*(进度|完成情况|成绩|报表|状态|谁完成|谁没完成|未完成|完成率|平均分)/.test(value) ||
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
${String(options.memoryHint || "").trim() ? `本地记忆提示：${String(options.memoryHint).trim()}\n` : ""}
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
    if (decision.skill) return applyIntentConflictGuard(decision, local);
  } catch {
  }
  return local;
}
