import { searchEmployees } from "../../domain/index.mjs";
import { classifyTrainingIntent, isConfirmedSkillAllowed } from "../../ai/index.mjs";
import { appendAgentTrace } from "../../agent-trace.mjs";
import {
  failRun,
  finishRun,
  recordRunStep,
  startRun,
} from "../../agent-runs/store.mjs";
import { createIntentConfirmationToken, verifyIntentConfirmationToken } from "../../intent-confirmation.mjs";
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
  getWebSkill,
  summarizeToolInput,
  summarizeToolResult,
} from "../../tools/registry.mjs";
import { readBody } from "../request.mjs";
import { sendJson } from "../response.mjs";

export async function handleEmployees(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/api/employees") return false;
  const state = await loadState();
  sendJson(res, 200, { employees: searchEmployees(state, url.searchParams.get("q") || "") });
  return true;
}

function intentLabel(skill) {
  return getWebSkill(skill)?.label || "执行操作";
}

export function intentConfirmPayload(message, decision) {
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
      risk: getWebSkill(decision.skill)?.risk || (decision.skill === "delete_training_records" ? "high" : "normal"),
    },
  };
}

export function validateConfirmedSkill({ confirmedSkill, confirmationToken, message }, status = 400) {
  if (!confirmedSkill) return null;
  if (!isConfirmedSkillAllowed(confirmedSkill)) {
    return { status, error: "unsupported confirmedSkill" };
  }
  const verification = verifyIntentConfirmationToken(confirmationToken, { message, skill: confirmedSkill });
  if (!verification.ok) {
    return {
      status: status === 400 ? 409 : status,
      error: "invalid intent confirmation",
      reason: verification.reason,
    };
  }
  return { ok: true, verification };
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
    })
  ), (result) => ({
    skill,
    input: summarizeToolInput(skill, { state, message, decision, memoryContext: options.memoryContext }),
    result: summarizeToolResult(skill, result),
  }));
  const status = payload.action === "chat" && payload.error ? 503 : 200;
  return { status, payload, toolSummary: summarizeToolResult(skill, payload) };
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
    alternatives: (decision.alternatives || []).map((item) => ({
      skill: item.skill || item.intent || "",
      confidence: Number(item.confidence) || 0,
    })),
  };
}

async function appendTraceAndFinishRun({
  run,
  startedAt,
  transport,
  route,
  message,
  confirmedSkill,
  confirmationToken,
  confirmation,
  decision,
  payload,
  error,
}) {
  const latencyMs = Date.now() - startedAt;
  const payloadError = payload?.error ? String(payload.error) : "";
  if (payload) {
    await recordRunStep(run.id, "result_output", payload?.action || "response", async () => payload, (result) => ({
      action: result?.action || "",
      statusCode: result?.error ? 503 : 200,
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
    transport,
    route,
    message,
    confirmedSkill,
    confirmationTokenPresent: Boolean(confirmationToken),
    confirmationVerified: confirmation?.ok === true,
    decision,
    result: payload,
    error: error ? (error instanceof Error ? error.message : String(error)) : payloadError || undefined,
    latencyMs,
  });
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
    sendJson(res, 200, { draft: draftPayload.draft });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/dispatch") {
    const startedAt = Date.now();
    const body = await readBody(req);
    const message = body.message || body.instruction || "";
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
    ), (result) => ({
      confirmedSkill,
      tokenPresent: Boolean(confirmationToken),
      verified: result?.ok === true,
      reason: result?.reason || "",
    }));

    if (confirmation && !confirmation.ok) {
      const payload = { error: confirmation.error, reason: confirmation.reason };
      sendJson(res, confirmation.status, payload);
      await appendTraceAndFinishRun({
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
    ), (result) => ({ matched: Boolean(result), action: result?.action || "" }));

    if (memoryOnlyPayload) {
      const payload = await applyMemoryAfterTurn({ message, payload: memoryOnlyPayload, memoryContext, sessionId, memoryMode });
      sendJson(res, 200, payload);
      await appendTraceAndFinishRun({
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

    const state = await recordRunStep(run.id, "state_load", "load_state", loadState, (value) => ({
      knowledgeBases: value.knowledgeBases?.length || 0,
      tasks: value.tasks?.length || 0,
      employees: value.employees?.length || 0,
    }));
    const decision = await recordRunStep(run.id, "intent_route", "classify_training_intent", async () => (
      await classifyTrainingIntent(state, message, {
        confirmedSkill,
        memoryHint: renderIntentMemoryHint(memoryContext),
      })
    ), decisionSummary);

    try {
      const { status, payload: rawPayload } = await buildDecisionResult(state, message, decision, { memoryContext, runId: run.id });
      const payload = await recordRunStep(run.id, "memory_write", "apply_memory_after_turn", async () => (
        await applyMemoryAfterTurn({ message, payload: rawPayload, memoryContext, sessionId, memoryMode })
      ), (result) => ({
        action: result?.action || "",
        saved: result?.memory?.saved?.length || 0,
        candidates: result?.memory?.candidates?.length || 0,
      }));
      sendJson(res, status, payload);
      await appendTraceAndFinishRun({
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
      await appendTraceAndFinishRun({
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
    const run = await startRun({
      sessionId,
      transport: "http",
      route: "/api/chat",
      message,
    });
    const memoryContext = await recordRunStep(run.id, "memory_recall", "build_memory_context", async () => (
      await buildMemoryContext({ sessionId, message, memoryMode })
    ), memorySummary);
    const decision = { intent: "answer_general_chat", skill: "answer_general_chat", confidence: 1, source: "direct_chat", reason: "用户选择普通聊天入口。", needsConfirmation: false };
    try {
      const payload = await recordRunStep(run.id, "tool_execute", "answer_general_chat", async () => (
        await executeWebSkill("answer_general_chat", { message, decision, memoryContext, state: null })
      ), (result) => ({
        skill: "answer_general_chat",
        result: summarizeToolResult("answer_general_chat", result),
      }));
      const withMemory = await recordRunStep(run.id, "memory_write", "apply_memory_after_turn", async () => (
        await applyMemoryAfterTurn({ message, payload, memoryContext, sessionId, memoryMode })
      ), (result) => ({ action: result?.action || "" }));
      const status = withMemory.error ? 503 : 200;
      sendJson(res, status, withMemory);
      await appendTraceAndFinishRun({
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
      sendJson(res, 503, withMemory);
      await appendTraceAndFinishRun({
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
