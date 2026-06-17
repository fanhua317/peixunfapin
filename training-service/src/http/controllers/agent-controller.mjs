import { searchEmployees } from "../../domain/index.mjs";
import { classifyTrainingIntent, detectKnowledgeAnswerIntent } from "../../ai/index.mjs";
import { recordRunStep, startRun } from "../../agent-runs/store.mjs";
import { intentConfirmPayload, validateConfirmedSkill } from "../../agent/confirmation.mjs";
import { finalizeAgentRun } from "../../agent/run-lifecycle.mjs";
import { appendBossChatTurn } from "../../boss-chat/store.mjs";
import {
  confirmationSummary,
  decisionSummary,
  memoryInstructionSummary,
  memorySummary,
  memoryWriteSummary,
  stateSummary,
  toolExecutionSummary,
} from "../../agent/summaries.mjs";
import {
  buildMemoryContext,
  normalizeMemoryMode,
  normalizeSessionId,
  renderIntentMemoryHint,
} from "../../memory/index.mjs";
import { applyMemoryAfterTurn, processMemoryInstruction } from "../../memory/flow.mjs";
import { loadState } from "../../store.mjs";
import {
  executeWebSkill,
  summarizeToolInput,
  summarizeToolResult,
} from "../../tools/registry.mjs";
import { readBody } from "../request.mjs";
import { sendJson } from "../response.mjs";

async function persistBossTurn({ sessionId, message, payload, runId }) {
  try {
    await appendBossChatTurn({ sessionId, message, payload, runId });
  } catch (error) {
    console.warn("boss chat persistence failed:", error instanceof Error ? error.message : String(error));
  }
}

export async function handleEmployees(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/api/employees") return false;
  const state = await loadState();
  sendJson(res, 200, { employees: searchEmployees(state, url.searchParams.get("q") || "") });
  return true;
}

async function buildDecisionResult(state, message, decision, options = {}) {
  if (decision.needsConfirmation) {
    return { status: 200, payload: intentConfirmPayload(message, decision), toolSummary: { action: "intent_confirm" } };
  }
  const skill = decision.skill || decision.intent || "answer_general_chat";
  const payload = await recordRunStep(options.runId, "tool_execute", skill, async () => (
    await executeWebSkill(skill, {
      state,
      message,
      decision,
      memoryContext: options.memoryContext,
      sessionId: options.sessionId,
    })
  ), toolExecutionSummary(
    skill,
    summarizeToolInput(skill, { state, message, decision, memoryContext: options.memoryContext, sessionId: options.sessionId }),
  ));
  const status = payload.action === "chat" && payload.error ? 503 : 200;
  return { status, payload, toolSummary: summarizeToolResult(skill, payload) };
}

export async function handleAgent(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/agent/draft") {
    const body = await readBody(req);
    const state = await loadState();
    const memoryMode = normalizeMemoryMode(body.memoryMode);
    const memoryContext = await buildMemoryContext({
      sessionId: normalizeSessionId(body.sessionId),
      message: body.instruction || "",
      memoryMode,
    });
    const draftPayload = await executeWebSkill("create_training_draft", {
      state,
      message: body.instruction || "",
      decision: null,
      memoryContext,
    });
    await persistBossTurn({
      sessionId: normalizeSessionId(body.sessionId),
      message: body.instruction || "",
      payload: draftPayload,
    });
    sendJson(res, 200, { draft: draftPayload.draft });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/dispatch") {
    const startedAt = Date.now();
    const body = await readBody(req);
    const message = body.message || body.instruction || "";
    const displayMessage = body.displayMessage || message;
    const sessionId = normalizeSessionId(body.sessionId);
    const memoryMode = normalizeMemoryMode(body.memoryMode);
    const confirmedSkill = String(body.confirmedSkill || "").trim();
    const confirmationToken = String(body.confirmationToken || "").trim();
    const run = await startRun({
      sessionId,
      transport: "http",
      route: "/api/agent/dispatch",
      message,
      confirmedSkill,
      confirmationTokenPresent: Boolean(confirmationToken),
    });

    const confirmation = await recordRunStep(run.id, "confirmation_verify", confirmedSkill ? confirmedSkill : "none", async () => (
      validateConfirmedSkill({ confirmedSkill, confirmationToken, message })
    ), confirmationSummary({ confirmedSkill, confirmationToken }));

    if (confirmation && !confirmation.ok) {
      const payload = { action: "error", error: confirmation.error, reason: confirmation.reason };
      await persistBossTurn({ sessionId, message: displayMessage, payload, runId: run.id });
      sendJson(res, confirmation.status, payload);
      await finalizeAgentRun({
        run,
        startedAt,
        transport: "http",
        route: "/api/agent/dispatch",
        message,
        confirmedSkill,
        confirmationToken,
        confirmation,
        payload,
        error: `${confirmation.error}:${confirmation.reason || ""}`,
      });
      return true;
    }

    const memoryContext = await recordRunStep(run.id, "memory_recall", "build_memory_context", async () => (
      await buildMemoryContext({ sessionId, message, memoryMode })
    ), memorySummary);

    const memoryOnlyPayload = await recordRunStep(run.id, "memory_instruction", "process_memory_instruction", async () => (
      await processMemoryInstruction(message, { sessionId, memoryMode })
    ), memoryInstructionSummary);

    if (memoryOnlyPayload) {
      const payload = await recordRunStep(run.id, "memory_write", "apply_memory_after_turn", async () => (
        await applyMemoryAfterTurn({ message, payload: memoryOnlyPayload, memoryContext, sessionId, memoryMode })
      ), memoryWriteSummary);
      await persistBossTurn({ sessionId, message: displayMessage, payload, runId: run.id });
      sendJson(res, 200, payload);
      await finalizeAgentRun({
        run,
        startedAt,
        transport: "http",
        route: "/api/agent/dispatch",
        message,
        confirmedSkill,
        confirmationToken,
        confirmation,
        payload,
      });
      return true;
    }

    const state = await recordRunStep(run.id, "state_load", "load_state", loadState, stateSummary);
    const decision = await recordRunStep(run.id, "intent_route", "classify_training_intent", async () => (
      await classifyTrainingIntent(state, message, {
        confirmedSkill,
        memoryHint: renderIntentMemoryHint(memoryContext),
      })
    ), decisionSummary);

    try {
      const { status, payload: rawPayload } = await buildDecisionResult(state, message, decision, { memoryContext, runId: run.id, sessionId });
      const payload = await recordRunStep(run.id, "memory_write", "apply_memory_after_turn", async () => (
        await applyMemoryAfterTurn({ message, payload: rawPayload, memoryContext, sessionId, memoryMode })
      ), memoryWriteSummary);
      await persistBossTurn({ sessionId, message: displayMessage, payload, runId: run.id });
      sendJson(res, status, payload);
      await finalizeAgentRun({
        run,
        startedAt,
        transport: "http",
        route: "/api/agent/dispatch",
        message,
        confirmedSkill,
        confirmationToken,
        confirmation,
        decision,
        payload,
      });
    } catch (error) {
      await finalizeAgentRun({
        run,
        startedAt,
        transport: "http",
        route: "/api/agent/dispatch",
        message,
        confirmedSkill,
        confirmationToken,
        confirmation,
        decision,
        error,
      });
      throw error;
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const startedAt = Date.now();
    const body = await readBody(req);
    const sessionId = normalizeSessionId(body.sessionId);
    const memoryMode = normalizeMemoryMode(body.memoryMode);
    const message = body.message || "";
    const displayMessage = body.displayMessage || message;
    const forceGeneralChat = body.forceGeneralChat === true || ["1", "true", "yes", "on"].includes(String(body.forceGeneralChat || "").toLowerCase());
    const run = await startRun({
      sessionId,
      transport: "http",
      route: "/api/chat",
      message,
    });
    const memoryContext = await recordRunStep(run.id, "memory_recall", "build_memory_context", async () => (
      await buildMemoryContext({ sessionId, message, memoryMode })
    ), memorySummary);
    let state = null;
    let decision = { intent: "answer_general_chat", skill: "answer_general_chat", confidence: 1, source: "direct_chat", reason: forceGeneralChat ? "用户明确选择普通聊天，已跳过知识库答疑探测。" : "用户选择普通聊天入口。", needsConfirmation: false };
    try {
      if (!forceGeneralChat) {
        state = await recordRunStep(run.id, "state_load", "load_state", loadState, stateSummary);
        const knowledgeDecision = await recordRunStep(run.id, "intent_route", "detect_knowledge_answer", async () => (
          await detectKnowledgeAnswerIntent(state, message)
        ), decisionSummary);
        if (knowledgeDecision) decision = knowledgeDecision;
      }
      const skill = decision.skill || decision.intent || "answer_general_chat";
      const payload = await recordRunStep(run.id, "tool_execute", skill, async () => (
        await executeWebSkill(skill, { message, decision, memoryContext, state, sessionId })
      ), (result) => ({
        skill,
        result: summarizeToolResult(skill, result),
      }));
      const withMemory = await recordRunStep(run.id, "memory_write", "apply_memory_after_turn", async () => (
        await applyMemoryAfterTurn({ message, payload, memoryContext, sessionId, memoryMode })
      ), memoryWriteSummary);
      const status = withMemory.action === "chat" && withMemory.error ? 503 : 200;
      await persistBossTurn({ sessionId, message: displayMessage, payload: withMemory, runId: run.id });
      sendJson(res, status, withMemory);
      await finalizeAgentRun({
        run,
        startedAt,
        transport: "http",
        route: "/api/chat",
        message,
        decision,
        payload: withMemory,
      });
    } catch (error) {
      const payload = {
        action: "chat",
        error: error instanceof Error ? error.message : String(error),
        source: "llm-api",
        route: "general_chat",
        llmConfigured: false,
      };
      const withMemory = await applyMemoryAfterTurn({ message, payload, memoryContext, sessionId, memoryMode });
      await persistBossTurn({ sessionId, message: displayMessage, payload: withMemory, runId: run.id });
      sendJson(res, 503, withMemory);
      await finalizeAgentRun({
        run,
        startedAt,
        transport: "http",
        route: "/api/chat",
        message,
        decision,
        payload: withMemory,
        error,
      });
    }
    return true;
  }

  return false;
}
