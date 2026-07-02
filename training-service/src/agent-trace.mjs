import crypto from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./store.mjs";

const tracePath = path.join(dataDir, "agent-traces.jsonl");

function nowIso() {
  return new Date().toISOString();
}

function compact(value, limit = 240) {
  const text = String(value || "")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function sanitizeDecision(decision) {
  if (!decision) return null;
  return {
    intent: decision.intent || "",
    skill: decision.skill || "",
    confidence: Number(decision.confidence) || 0,
    source: decision.source || "",
    reason: compact(decision.reason, 160),
    needsConfirmation: decision.needsConfirmation === true,
    model: decision.model || undefined,
    runId: decision.runId || undefined,
    alternatives: Array.isArray(decision.alternatives)
      ? decision.alternatives.map((item) => ({
          skill: item.skill || item.intent || "",
          confidence: Number(item.confidence) || 0,
          reason: compact(item.reason, 120),
        }))
      : [],
  };
}

function summarizeResult(result) {
  if (!result || typeof result !== "object") return {};
  const action = result.action || "";
  if (action === "draft") {
    return {
      action,
      draftId: result.draft?.id,
      employeeCount: result.draft?.employees?.length || 0,
      hasKnowledgeBase: Boolean(result.draft?.knowledgeBase?.id),
      warningCount: result.draft?.warnings?.length || 0,
    };
  }
  if (action === "status") {
    return { action, taskCount: result.tasks?.length || 0 };
  }
  if (action === "delete_records") {
    return {
      action,
      deleted: result.deleted || {},
      taskCount: result.taskIds?.length || 0,
      remainingTasks: result.remainingTasks,
    };
  }
  if (action === "marketing_article") {
    return {
      action,
      insufficient: result.article?.insufficient === true,
      sourceCount: result.article?.sourceRefs?.length || 0,
      warningCount: result.article?.warnings?.length || 0,
      uniquenessStatus: result.article?.uniqueness?.overallStatus,
      aiWritingScoreMax: result.article?.uniqueness?.aiWritingScoreMax,
      retrievalMode: result.article?.retrievalMode,
    };
  }
  if (action === "intent_confirm") {
    return {
      action,
      skill: result.confirmation?.skill,
      risk: result.confirmation?.risk,
      tokenIssued: Boolean(result.confirmation?.token),
    };
  }
  if (action === "chat") {
    return { action, source: result.source, route: result.route, hasAnswer: Boolean(result.answer) };
  }
  return { action };
}

export async function appendAgentTrace(entry = {}) {
  if (["0", "false", "off", "no"].includes(String(process.env.TRAINING_AGENT_TRACE || "1").toLowerCase())) return;
  const message = String(entry.message || "");
  const record = {
    id: `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    runId: entry.runId || "",
    createdAt: nowIso(),
    transport: entry.transport || "http",
    route: entry.route || "",
    messageHash: hash(message),
    messagePreview: compact(message),
    messageLength: message.length,
    confirmedSkill: entry.confirmedSkill || "",
    confirmationTokenPresent: entry.confirmationTokenPresent === true,
    confirmationVerified: entry.confirmationVerified === true,
    decision: sanitizeDecision(entry.decision),
    result: summarizeResult(entry.result),
    error: entry.error ? compact(entry.error, 240) : undefined,
    latencyMs: Number(entry.latencyMs) || 0,
  };
  try {
    await mkdir(path.dirname(tracePath), { recursive: true });
    await appendFile(tracePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Tracing must never break the user-facing Agent flow.
  }
}

export { tracePath as agentTracePath };
