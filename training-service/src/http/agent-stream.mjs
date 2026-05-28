import { classifyTrainingIntent } from "../ai/index.mjs";
import {
  appendRunStep,
  recordRunStep,
  startRun,
} from "../agent-runs/store.mjs";
import { intentConfirmPayload, validateConfirmedSkill } from "../agent/confirmation.mjs";
import { finalizeAgentRun } from "../agent/run-lifecycle.mjs";
import {
  confirmationSummary,
  decisionSummary,
  memoryInstructionSummary,
  memorySummary,
  memoryWriteSummary,
  stateSummary,
  toolExecutionSummary,
} from "../agent/summaries.mjs";
import { streamGeneralChat } from "../chat/general-chat.mjs";
import {
  buildMemoryContext,
  normalizeMemoryMode,
  normalizeSessionId,
  renderIntentMemoryHint,
} from "../memory/index.mjs";
import { applyMemoryAfterTurn, processMemoryInstruction } from "../memory/flow.mjs";
import { loadState } from "../store.mjs";
import {
  executeWebSkill,
  summarizeToolInput,
  summarizeToolResult,
} from "../tools/registry.mjs";
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
    sessionId: normalizeSessionId(payload.sessionId),
    memoryMode: normalizeMemoryMode(payload.memoryMode),
    confirmedSkill: String(payload.confirmedSkill || "").trim(),
    confirmationToken: String(payload.confirmationToken || "").trim(),
  };
}

async function traceAndFinish({ run, startedAt, body, decision, payload, confirmation, error }) {
  await finalizeAgentRun({
    run,
    startedAt,
    transport: "ws",
    route: "/api/agent/stream",
    message: body.message,
    confirmedSkill: body.confirmedSkill,
    confirmationToken: body.confirmationToken,
    confirmation,
    decision,
    payload,
    error,
  });
}

async function executeSkillForStream(socket, run, state, body, decision, memoryContext) {
  const skill = decision.skill || decision.intent || "answer_general_chat";
  if (skill === "generate_marketing_article") {
    sendWsJson(socket, {
      type: "start",
      action: "marketing_article",
      decision,
      source: "llm-api",
      route: "marketing_article",
    });
  }
  const payload = await recordRunStep(run.id, "tool_execute", skill, async () => (
    await executeWebSkill(skill, { state, message: body.message, decision, memoryContext })
  ), toolExecutionSummary(skill, summarizeToolInput(skill, { state, message: body.message, decision, memoryContext })));
  return payload;
}

async function streamChat(socket, run, body, decision, memoryContext, abortController) {
  sendWsJson(socket, {
    type: "start",
    action: "chat",
    decision,
    source: "llm-api",
    route: "general_chat",
  });
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  try {
    const result = await streamGeneralChat(body.message, {
      memoryContext,
      signal: abortController.signal,
      onDelta: (delta) => sendWsJson(socket, { type: "delta", delta }),
    });
    const payload = {
      action: "chat",
      decision,
      ...result,
    };
    await appendRunStep(run.id, {
      type: "tool_execute",
      name: "answer_general_chat",
      status: "succeeded",
      startedAt,
      finishedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedMs,
      summary: {
        skill: "answer_general_chat",
        result: summarizeToolResult("answer_general_chat", payload),
      },
    });
    return payload;
  } catch (error) {
    await appendRunStep(run.id, {
      type: "tool_execute",
      name: "answer_general_chat",
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedMs,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function handleStreamMessage(socket, raw, abortController) {
  const startedAt = Date.now();
  const body = parseClientPayload(raw);
  const run = await startRun({
    sessionId: body.sessionId,
    transport: "ws",
    route: "/api/agent/stream",
    message: body.message,
    confirmedSkill: body.confirmedSkill,
    confirmationTokenPresent: Boolean(body.confirmationToken),
  });
  let confirmation = null;
  let decision = null;
  try {
    confirmation = await recordRunStep(run.id, "confirmation_verify", body.confirmedSkill ? body.confirmedSkill : "none", async () => (
      validateConfirmedSkill(body, 1008)
    ), confirmationSummary(body));
    if (confirmation && !confirmation.ok) {
      const payload = { action: "error", error: confirmation.error, reason: confirmation.reason };
      sendWsJson(socket, { type: "error", error: confirmation.error, reason: confirmation.reason });
      await traceAndFinish({ run, startedAt, body, payload, confirmation, error: `${confirmation.error}:${confirmation.reason || ""}` });
      closeWebSocket(socket, confirmation.status, confirmation.error);
      return;
    }

    const memoryContext = await recordRunStep(run.id, "memory_recall", "build_memory_context", async () => (
      await buildMemoryContext({
        sessionId: body.sessionId,
        message: body.message,
        memoryMode: body.memoryMode,
      })
    ), memorySummary);
    const memoryOnlyPayload = await recordRunStep(run.id, "memory_instruction", "process_memory_instruction", async () => (
      await processMemoryInstruction(body.message, {
        sessionId: body.sessionId,
        memoryMode: body.memoryMode,
      })
    ), memoryInstructionSummary);
    if (memoryOnlyPayload) {
      const payload = await recordRunStep(run.id, "memory_write", "apply_memory_after_turn", async () => (
        await applyMemoryAfterTurn({
          message: body.message,
          payload: memoryOnlyPayload,
          memoryContext,
          sessionId: body.sessionId,
          memoryMode: body.memoryMode,
        })
      ), memoryWriteSummary);
      sendWsJson(socket, { type: "result", payload });
      sendWsJson(socket, { type: "done", action: payload.action });
      await traceAndFinish({ run, startedAt, body, payload, confirmation });
      closeWebSocket(socket);
      return;
    }

    const state = await recordRunStep(run.id, "state_load", "load_state", loadState, stateSummary);
    decision = await recordRunStep(run.id, "intent_route", "classify_training_intent", async () => (
      await classifyTrainingIntent(state, body.message, {
        confirmedSkill: body.confirmedSkill,
        memoryHint: renderIntentMemoryHint(memoryContext),
      })
    ), decisionSummary);

    if (decision.needsConfirmation) {
      const payload = await recordRunStep(run.id, "memory_write", "apply_memory_after_turn", async () => (
        await applyMemoryAfterTurn({
          message: body.message,
          payload: intentConfirmPayload(body.message, decision),
          memoryContext,
          sessionId: body.sessionId,
          memoryMode: body.memoryMode,
        })
      ), memoryWriteSummary);
      sendWsJson(socket, { type: "result", payload });
      sendWsJson(socket, { type: "done", action: "intent_confirm" });
      await traceAndFinish({ run, startedAt, body, decision, payload, confirmation });
      closeWebSocket(socket);
      return;
    }

    const rawPayload = (decision.skill || decision.intent) === "answer_general_chat"
      ? await streamChat(socket, run, body, decision, memoryContext, abortController)
      : await executeSkillForStream(socket, run, state, body, decision, memoryContext);
    const payload = await recordRunStep(run.id, "memory_write", "apply_memory_after_turn", async () => (
      await applyMemoryAfterTurn({
        message: body.message,
        payload: rawPayload,
        memoryContext,
        sessionId: body.sessionId,
        memoryMode: body.memoryMode,
      })
    ), memoryWriteSummary);

    if (payload.action === "chat") {
      sendWsJson(socket, { type: "done", action: "chat", payload });
    } else {
      sendWsJson(socket, { type: "result", payload });
      sendWsJson(socket, { type: "done", action: payload.action });
    }
    await traceAndFinish({ run, startedAt, body, decision, payload, confirmation });
    closeWebSocket(socket);
  } catch (error) {
    await traceAndFinish({ run, startedAt, body, decision, confirmation, error });
    throw error;
  }
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
