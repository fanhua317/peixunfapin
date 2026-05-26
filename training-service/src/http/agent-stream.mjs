import { classifyTrainingIntent, generateMarketingArticle, isConfirmedSkillAllowed } from "../ai/index.mjs";
import { streamGeneralChat } from "../chat/general-chat.mjs";
import { createTaskDraft, deleteTrainingRecords, getTaskStatus } from "../domain/index.mjs";
import { getRuntimeHealth, getVectorIndexStatus } from "../health.mjs";
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

async function handleStreamMessage(socket, raw, abortController) {
  const body = parseClientPayload(raw);
  if (body.confirmedSkill && !isConfirmedSkillAllowed(body.confirmedSkill)) {
    sendWsJson(socket, { type: "error", error: "unsupported confirmedSkill" });
    closeWebSocket(socket, 1008, "unsupported confirmedSkill");
    return;
  }
  const state = await loadState();
  const decision = await classifyTrainingIntent(state, body.message, { confirmedSkill: body.confirmedSkill });

  if (decision.needsConfirmation) {
    sendWsJson(socket, {
      type: "result",
      payload: intentConfirmPayload(body.message, decision),
    });
    sendWsJson(socket, { type: "done", action: "intent_confirm" });
    closeWebSocket(socket);
    return;
  }

  if (decision.skill === "create_training_draft" || decision.intent === "create_training_draft") {
    sendWsJson(socket, {
      type: "result",
      payload: {
        action: "draft",
        decision,
        draft: await createEnrichedTaskDraft(state, body.message),
      },
    });
    sendWsJson(socket, { type: "done", action: "draft" });
    closeWebSocket(socket);
    return;
  }

  if (decision.skill === "show_training_status" || decision.intent === "show_training_status") {
    sendWsJson(socket, {
      type: "result",
      payload: {
        action: "status",
        decision,
        tasks: state.tasks.map((task) => getTaskStatus(state, task.id)),
      },
    });
    sendWsJson(socket, { type: "done", action: "status" });
    closeWebSocket(socket);
    return;
  }

  if (decision.skill === "delete_training_records" || decision.intent === "delete_training_records") {
    const result = await mutateState((currentState) => deleteTrainingRecords(currentState, { instruction: body.message }));
    sendWsJson(socket, {
      type: "result",
      payload: {
        ...result,
        decision,
      },
    });
    sendWsJson(socket, { type: "done", action: "delete_records" });
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
    sendWsJson(socket, {
      type: "result",
      payload: {
        action: "marketing_article",
        decision,
        article: await generateMarketingArticle(state, { instruction: body.message }),
      },
    });
    sendWsJson(socket, { type: "done", action: "marketing_article" });
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
  sendWsJson(socket, {
    type: "done",
    action: "chat",
    payload: {
      action: "chat",
      decision,
      ...result,
    },
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
