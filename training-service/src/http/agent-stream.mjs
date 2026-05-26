import { classifyTrainingIntent, generateMarketingArticle, isConfirmedSkillAllowed } from "../ai/index.mjs";
import { appendAgentTrace } from "../agent-trace.mjs";
import { streamGeneralChat } from "../chat/general-chat.mjs";
import { createTaskDraft, deleteTrainingRecords, getTaskStatus } from "../domain/index.mjs";
import { getRuntimeHealth, getVectorIndexStatus } from "../health.mjs";
import { createIntentConfirmationToken, verifyIntentConfirmationToken } from "../intent-confirmation.mjs";
import { getKnowledgeBaseQuality } from "../quality.mjs";
import { loadState, mutateState } from "../store.mjs";
import { isAuthenticated } from "./auth.mjs";
import { acceptWebSocket, closeWebSocket, createWebSocketParser, sendWsJson } from "./websocket.mjs";

function rejectUpgrade(socket, status = 404, message = "Not Found") {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function parseClientPayload(raw) {
  const payload = JSON.parse(raw);
  return {
    message: String(payload.message || payload.instruction || "").trim(),
    confirmedSkill: String(payload.confirmedSkill || "").trim(),
    confirmationToken: String(payload.confirmationToken || "").trim(),
  };
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
    return { status: 1008, error: "unsupported confirmedSkill" };
  }
  const verification = verifyIntentConfirmationToken(confirmationToken, { message, skill: confirmedSkill });
  if (!verification.ok) {
    return {
      status: 1008,
      error: "invalid intent confirmation",
      reason: verification.reason,
    };
  }
  return { ok: true, verification };
}

async function handleStreamMessage(socket, raw, abortController) {
  const startedAt = Date.now();
  const body = parseClientPayload(raw);
  const confirmation = validateConfirmedSkill(body);
  if (confirmation && !confirmation.ok) {
    sendWsJson(socket, { type: "error", error: confirmation.error, reason: confirmation.reason });
    await appendAgentTrace({
      transport: "ws",
      route: "/api/agent/stream",
      message: body.message,
      confirmedSkill: body.confirmedSkill,
      confirmationTokenPresent: Boolean(body.confirmationToken),
      error: `${confirmation.error}:${confirmation.reason || ""}`,
      result: { action: "error" },
      latencyMs: Date.now() - startedAt,
    });
    closeWebSocket(socket, confirmation.status, confirmation.error);
    return;
  }
  const state = await loadState();
  const decision = await classifyTrainingIntent(state, body.message, { confirmedSkill: body.confirmedSkill });

  if (decision.needsConfirmation) {
    const payload = intentConfirmPayload(body.message, decision);
    sendWsJson(socket, {
      type: "result",
      payload,
    });
    sendWsJson(socket, { type: "done", action: "intent_confirm" });
    await appendAgentTrace({
      transport: "ws",
      route: "/api/agent/stream",
      message: body.message,
      confirmedSkill: body.confirmedSkill,
      confirmationTokenPresent: Boolean(body.confirmationToken),
      confirmationVerified: confirmation?.ok === true,
      decision,
      result: payload,
      latencyMs: Date.now() - startedAt,
    });
    closeWebSocket(socket);
    return;
  }

  if (decision.skill === "create_training_draft" || decision.intent === "create_training_draft") {
    const payload = {
      action: "draft",
      decision,
      draft: await createEnrichedTaskDraft(state, body.message),
    };
    sendWsJson(socket, {
      type: "result",
      payload,
    });
    sendWsJson(socket, { type: "done", action: "draft" });
    await appendAgentTrace({
      transport: "ws",
      route: "/api/agent/stream",
      message: body.message,
      confirmedSkill: body.confirmedSkill,
      confirmationTokenPresent: Boolean(body.confirmationToken),
      confirmationVerified: confirmation?.ok === true,
      decision,
      result: payload,
      latencyMs: Date.now() - startedAt,
    });
    closeWebSocket(socket);
    return;
  }

  if (decision.skill === "show_training_status" || decision.intent === "show_training_status") {
    const payload = {
      action: "status",
      decision,
      tasks: state.tasks.map((task) => getTaskStatus(state, task.id)),
    };
    sendWsJson(socket, {
      type: "result",
      payload,
    });
    sendWsJson(socket, { type: "done", action: "status" });
    await appendAgentTrace({
      transport: "ws",
      route: "/api/agent/stream",
      message: body.message,
      confirmedSkill: body.confirmedSkill,
      confirmationTokenPresent: Boolean(body.confirmationToken),
      confirmationVerified: confirmation?.ok === true,
      decision,
      result: payload,
      latencyMs: Date.now() - startedAt,
    });
    closeWebSocket(socket);
    return;
  }

  if (decision.skill === "delete_training_records" || decision.intent === "delete_training_records") {
    const result = await mutateState((currentState) => deleteTrainingRecords(currentState, { instruction: body.message }));
    const payload = {
      ...result,
      decision,
    };
    sendWsJson(socket, {
      type: "result",
      payload,
    });
    sendWsJson(socket, { type: "done", action: "delete_records" });
    await appendAgentTrace({
      transport: "ws",
      route: "/api/agent/stream",
      message: body.message,
      confirmedSkill: body.confirmedSkill,
      confirmationTokenPresent: Boolean(body.confirmationToken),
      confirmationVerified: confirmation?.ok === true,
      decision,
      result: payload,
      latencyMs: Date.now() - startedAt,
    });
    closeWebSocket(socket);
    return;
  }

  if (decision.skill === "generate_marketing_article" || decision.intent === "generate_marketing_article") {
    sendWsJson(socket, {
      type: "start",
      action: "marketing_article",
      decision,
      source: "llm-api",
      route: "marketing_article",
    });
    const payload = {
      action: "marketing_article",
      decision,
      article: await generateMarketingArticle(state, { instruction: body.message }),
    };
    sendWsJson(socket, {
      type: "result",
      payload,
    });
    sendWsJson(socket, { type: "done", action: "marketing_article" });
    await appendAgentTrace({
      transport: "ws",
      route: "/api/agent/stream",
      message: body.message,
      confirmedSkill: body.confirmedSkill,
      confirmationTokenPresent: Boolean(body.confirmationToken),
      confirmationVerified: confirmation?.ok === true,
      decision,
      result: payload,
      latencyMs: Date.now() - startedAt,
    });
    closeWebSocket(socket);
    return;
  }

  sendWsJson(socket, {
    type: "start",
    action: "chat",
    decision,
    source: "llm-api",
    route: "general_chat",
  });
  const result = await streamGeneralChat(body.message, {
    signal: abortController.signal,
    onDelta: (delta) => sendWsJson(socket, { type: "delta", delta }),
  });
  const payload = {
    action: "chat",
    decision,
    ...result,
  };
  sendWsJson(socket, {
    type: "done",
    action: "chat",
    payload,
  });
  await appendAgentTrace({
    transport: "ws",
    route: "/api/agent/stream",
    message: body.message,
    confirmedSkill: body.confirmedSkill,
    confirmationTokenPresent: Boolean(body.confirmationToken),
    confirmationVerified: confirmation?.ok === true,
    decision,
    result: payload,
    latencyMs: Date.now() - startedAt,
  });
  closeWebSocket(socket);
}

export function handleAgentStreamUpgrade(req, socket, head, context = {}) {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${context.host || "127.0.0.1"}:${context.port || 8787}`}`);
  if (url.pathname !== "/api/agent/stream") return false;
  if (!isAuthenticated(req)) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return true;
  }
  if (!acceptWebSocket(req, socket)) return true;

  const abortController = new AbortController();
  let started = false;
  const parser = createWebSocketParser({
    onText: (raw) => {
      if (started) return;
      started = true;
      handleStreamMessage(socket, raw, abortController).catch((error) => {
        sendWsJson(socket, {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        closeWebSocket(socket, 1011, "stream failed");
      });
    },
    onClose: () => abortController.abort(),
    onPing: () => sendWsJson(socket, { type: "pong" }),
  });
  socket.on("close", () => abortController.abort());
  socket.on("error", () => abortController.abort());
  socket.on("data", parser);
  if (head?.length) parser(head);
  return true;
}
