import { createTaskDraft, deleteTrainingRecords, getTaskStatus, searchEmployees } from "../../domain/index.mjs";
import { classifyTrainingIntent, generateMarketingArticle, isConfirmedSkillAllowed } from "../../ai/index.mjs";
import { answerGeneralChat } from "../../chat/general-chat.mjs";
import { getRuntimeHealth, getVectorIndexStatus } from "../../health.mjs";
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
  return {
    action: "intent_confirm",
    message,
    decision,
    confirmation: {
      skill: decision.skill,
      title: decision.skill === "delete_training_records" ? "确认删除培训记录？" : `确认${intentLabel(decision.skill)}？`,
      description: decision.skill === "delete_training_records"
        ? "删除会移除匹配的培训任务、学习链接、试卷和答题记录；知识库和员工名单不会删除。"
        : `我理解你想${intentLabel(decision.skill)}。为避免误操作，请确认后再执行。`,
      risk: decision.skill === "delete_training_records" ? "high" : "normal",
    },
  };
}

async function sendDecisionResult(res, state, message, decision) {
  if (decision.needsConfirmation) {
    sendJson(res, 200, intentConfirmPayload(message, decision));
    return true;
  }
  if (decision.skill === "create_training_draft" || decision.intent === "create_training_draft") {
    sendJson(res, 200, {
      action: "draft",
      decision,
      draft: await createEnrichedTaskDraft(state, message),
    });
    return true;
  }
  if (decision.skill === "show_training_status" || decision.intent === "show_training_status") {
    sendJson(res, 200, {
      action: "status",
      decision,
      tasks: state.tasks.map((task) => getTaskStatus(state, task.id)),
    });
    return true;
  }
  if (decision.skill === "delete_training_records" || decision.intent === "delete_training_records") {
    const result = await mutateState((currentState) => deleteTrainingRecords(currentState, { instruction: message }));
    sendJson(res, 200, {
      ...result,
      decision,
    });
    return true;
  }
  if (decision.skill === "generate_marketing_article" || decision.intent === "generate_marketing_article") {
    sendJson(res, 200, {
      action: "marketing_article",
      decision,
      article: await generateMarketingArticle(state, { instruction: message }),
    });
    return true;
  }
  await sendGeneralChat(res, message, decision);
  return true;
}

export async function handleAgent(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/agent/draft") {
    const body = await readBody(req);
    const state = await loadState();
    sendJson(res, 200, { draft: await createEnrichedTaskDraft(state, body.instruction || "") });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/dispatch") {
    const body = await readBody(req);
    const message = body.message || body.instruction || "";
    const confirmedSkill = String(body.confirmedSkill || "").trim();
    if (confirmedSkill && !isConfirmedSkillAllowed(confirmedSkill)) {
      sendJson(res, 400, { error: "unsupported confirmedSkill" });
      return true;
    }
    const state = await loadState();
    const decision = await classifyTrainingIntent(state, message, { confirmedSkill });
    await sendDecisionResult(res, state, message, decision);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const body = await readBody(req);
    await sendGeneralChat(res, body.message || "");
    return true;
  }

  return false;
}
