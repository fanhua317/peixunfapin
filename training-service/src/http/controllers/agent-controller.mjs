import { createTaskDraft, deleteTrainingRecords, getTaskStatus, searchEmployees } from "../../domain/index.mjs";
import { classifyTrainingIntent, generateMarketingArticle, isConfirmedSkillAllowed } from "../../ai/index.mjs";
import { appendAgentTrace } from "../../agent-trace.mjs";
import { answerGeneralChat } from "../../chat/general-chat.mjs";
import { getRuntimeHealth, getVectorIndexStatus } from "../../health.mjs";
import { createIntentConfirmationToken, verifyIntentConfirmationToken } from "../../intent-confirmation.mjs";
import { getKnowledgeBaseQuality } from "../../quality.mjs";
import { loadState, mutateState } from "../../store.mjs";
import { readBody } from "../request.mjs";
import { sendJson } from "../response.mjs";

export async function handleEmployees(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/api/employees") return false;
  const state = await loadState();
  sendJson(res, 200, { employees: searchEmployees(state, url.searchParams.get("q") || "") });
  return true;
}

async function sendGeneralChat(res, message, decision = null) {
  try {
    sendJson(res, 200, {
      action: "chat",
      ...(decision ? { decision } : {}),
      ...(await answerGeneralChat(message)),
    });
  } catch (error) {
    sendJson(res, 503, {
      action: "chat",
      ...(decision ? { decision } : {}),
      error: error instanceof Error ? error.message : String(error),
      source: "llm-api",
      route: "general_chat",
      llmConfigured: false,
    });
  }
}

async function createEnrichedTaskDraft(state, instruction) {
  const draft = createTaskDraft(state, instruction);
  const knowledgeBaseId = draft.knowledgeBase?.id;
  if (!knowledgeBaseId) return draft;
  const runtime = await getRuntimeHealth(state);
  const vectorIndex = await getVectorIndexStatus(state, knowledgeBaseId, runtime);
  draft.knowledgeBase.quality = getKnowledgeBaseQuality(state, knowledgeBaseId, vectorIndex);
  return draft;
}

function intentLabel(skill) {
  return {
    create_training_draft: "创建培训草稿",
    show_training_status: "查询培训进度",
    delete_training_records: "删除培训记录",
    generate_marketing_article: "生成营销软文",
  }[skill] || "执行操作";
}

function intentConfirmPayload(message, decision) {
  const confirmation = createIntentConfirmationToken(message, decision.skill);
  return {
    action: "intent_confirm",
    message,
    decision,
    confirmation: {
      skill: decision.skill,
      token: confirmation.token,
      expiresAt: confirmation.expiresAt,
      title: decision.skill === "delete_training_records" ? "确认删除培训记录？" : `确认${intentLabel(decision.skill)}？`,
      description: decision.skill === "delete_training_records"
        ? "删除会移除匹配的培训任务、学习链接、试卷和答题记录；知识库和员工名单不会删除。"
        : `我理解你想${intentLabel(decision.skill)}。为避免误操作，请确认后再执行。`,
      risk: decision.skill === "delete_training_records" ? "high" : "normal",
    },
  };
}

function validateConfirmedSkill({ confirmedSkill, confirmationToken, message }) {
  if (!confirmedSkill) return null;
  if (!isConfirmedSkillAllowed(confirmedSkill)) {
    return { status: 400, error: "unsupported confirmedSkill" };
  }
  const verification = verifyIntentConfirmationToken(confirmationToken, { message, skill: confirmedSkill });
  if (!verification.ok) {
    return {
      status: 409,
      error: "invalid intent confirmation",
      reason: verification.reason,
    };
  }
  return { ok: true, verification };
}

async function buildDecisionResult(state, message, decision) {
  if (decision.needsConfirmation) {
    return { status: 200, payload: intentConfirmPayload(message, decision) };
  }
  if (decision.skill === "create_training_draft" || decision.intent === "create_training_draft") {
    return { status: 200, payload: {
      action: "draft",
      decision,
      draft: await createEnrichedTaskDraft(state, message),
    } };
  }
  if (decision.skill === "show_training_status" || decision.intent === "show_training_status") {
    return { status: 200, payload: {
      action: "status",
      decision,
      tasks: state.tasks.map((task) => getTaskStatus(state, task.id)),
    } };
  }
  if (decision.skill === "delete_training_records" || decision.intent === "delete_training_records") {
    const result = await mutateState((currentState) => deleteTrainingRecords(currentState, { instruction: message }));
    return { status: 200, payload: {
      ...result,
      decision,
    } };
  }
  if (decision.skill === "generate_marketing_article" || decision.intent === "generate_marketing_article") {
    return { status: 200, payload: {
      action: "marketing_article",
      decision,
      article: await generateMarketingArticle(state, { instruction: message }),
    } };
  }
  try {
    return { status: 200, payload: {
      action: "chat",
      decision,
      ...(await answerGeneralChat(message)),
    } };
  } catch (error) {
    return { status: 503, payload: {
      action: "chat",
      decision,
      error: error instanceof Error ? error.message : String(error),
      source: "llm-api",
      route: "general_chat",
      llmConfigured: false,
    } };
  }
}

export async function handleAgent(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/agent/draft") {
    const body = await readBody(req);
    const state = await loadState();
    sendJson(res, 200, { draft: await createEnrichedTaskDraft(state, body.instruction || "") });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/dispatch") {
    const startedAt = Date.now();
    const body = await readBody(req);
    const message = body.message || body.instruction || "";
    const confirmedSkill = String(body.confirmedSkill || "").trim();
    const confirmationToken = String(body.confirmationToken || "").trim();
    const confirmation = validateConfirmedSkill({ confirmedSkill, confirmationToken, message });
    if (confirmation && !confirmation.ok) {
      const payload = { error: confirmation.error, reason: confirmation.reason };
      sendJson(res, confirmation.status, payload);
      await appendAgentTrace({
        transport: "http",
        route: "/api/agent/dispatch",
        message,
        confirmedSkill,
        confirmationTokenPresent: Boolean(confirmationToken),
        error: `${confirmation.error}:${confirmation.reason || ""}`,
        result: payload,
        latencyMs: Date.now() - startedAt,
      });
      return true;
    }
    const state = await loadState();
    const decision = await classifyTrainingIntent(state, message, { confirmedSkill });
    try {
      const { status, payload } = await buildDecisionResult(state, message, decision);
      sendJson(res, status, payload);
      await appendAgentTrace({
        transport: "http",
        route: "/api/agent/dispatch",
        message,
        confirmedSkill,
        confirmationTokenPresent: Boolean(confirmationToken),
        confirmationVerified: confirmation?.ok === true,
        decision,
        result: payload,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      await appendAgentTrace({
        transport: "http",
        route: "/api/agent/dispatch",
        message,
        confirmedSkill,
        confirmationTokenPresent: Boolean(confirmationToken),
        confirmationVerified: confirmation?.ok === true,
        decision,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const body = await readBody(req);
    await sendGeneralChat(res, body.message || "");
    return true;
  }

  return false;
}
