import { classifyTrainingIntent } from "../ai/index.mjs";
import { appendAgentTrace } from "../agent-trace.mjs";
import {
  appendRunStep,
  failRun,
  finishRun,
  recordRunStep,
  startRun,
} from "../agent-runs/store.mjs";
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
import { intentConfirmPayload, validateConfirmedSkill } from "./controllers/agent-controller.mjs";
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

function memorySummary(memoryContext = {}) {
  return {
    enabled: memoryContext.enabled === true,
    sessionId: memoryContext.sessionId || "",
    recentMessages: memoryContext.recentMessages?.length || 0,
    longTerm: memoryContext.longTerm?.length || 0,
    used: memoryContext.used?.map((memory) => ({ id: memory.id, key: memory.key, type: memory.type })) || [],
  };
}

function decisionSummary(decision = {}) {
  return {
    intent: decision.intent || "",
    skill: decision.skill || "",
    confidence: Number(decision.confidence) || 0,
    source: decision.source || "",
    reason: decision.reason || "",
    needsConfirmation: decision.needsConfirmation === true,
  };
}

async function traceAndFinish({ run, startedAt, body, decision, payload, confirmation, error }) {
  const latencyMs = Date.now() - startedAt;
  const payloadError = payload?.error ? String(payload.error) : "";
  if (payload) {
    await recordRunStep(run.id, "result_output", payload?.action || "response", async () => payload, (result) => ({
      action: result?.action || "",
    }));
  }
  if (error || payloadError) {
    await failRun(run.id, error || payloadError, { decision, latencyMs });
  } else {
    await finishRun(run.id, {
      decision,
      result: payload,
      action: payload?.action || "",
      confirmationVerified: confirmation?.ok === true,
      latencyMs,
      summary: {
        reason: decision?.reason || "",
      },
    });
  }
  await appendAgentTrace({
    runId: run.id,
    transport: "ws",
    route: "/api/agent/stream",
    message: body.message,
    confirmedSkill: body.confirmedSkill,
    confirmationTokenPresent: Boolean(body.confirmationToken),
    confirmationVerified: confirmation?.ok === true,
    decision,
    result: payload,
    error: error ? (error instanceof Error ? error.message : String(error)) : payloadError || undefined,
    latencyMs,
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
  ), (result) => ({
    skill,
    input: summarizeToolInput(skill, { state, message: body.message, decision, memoryContext }),
    result: summarizeToolResult(skill, result),
  }));
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
    ), (result) => ({
      confirmedSkill: body.confirmedSkill,
      tokenPresent: Boolean(body.confirmationToken),
      verified: result?.ok === true,
      reason: result?.reason || "",
    }));
    if (confirmation && !confirmation.ok) {
      const payload = { action: "error", error: confirmation.error, reason: confirmation.reason };
      sendWsJson(socket, { type: "error", error: confirmation.error, reason: confirmation.reason });
      await traceAndFinish({ run, startedAt, body, payload, confirmation, error: `${confirmation.error}:${confirmation.reason || ""}` });
      closeWebSocket(socket, confirmation.status, confirmation.error);
      return;
    }

    const state = await recordRunStep(run.id, "state_load", "load_state", loadState, (value) => ({
      knowledgeBases: value.knowledgeBases?.length || 0,
      tasks: value.tasks?.length || 0,
      employees: value.employees?.length || 0,
    }));
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
    ), (result) => ({ matched: Boolean(result), action: result?.action || "" }));
    if (memoryOnlyPayload) {
      const payload = await recordRunStep(run.id, "memory_write", "apply_memory_after_turn", async () => (
        await applyMemoryAfterTurn({
          message: body.message,
          payload: memoryOnlyPayload,
          memoryContext,
          sessionId: body.sessionId,
          memoryMode: body.memoryMode,
        })
      ), (result) => ({ action: result?.action || "" }));
      sendWsJson(socket, { type: "result", payload });
      sendWsJson(socket, { type: "done", action: payload.action });
      await traceAndFinish({ run, startedAt, body, payload, confirmation });
      closeWebSocket(socket);
      return;
    }

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
      ), (result) => ({ action: result?.action || "" }));
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
    ), (result) => ({
      action: result?.action || "",
      saved: result?.memory?.saved?.length || 0,
      candidates: result?.memory?.candidates?.length || 0,
    }));

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
