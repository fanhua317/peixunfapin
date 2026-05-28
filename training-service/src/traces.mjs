import { readFile } from "node:fs/promises";
import { agentTracePath } from "./agent-trace.mjs";

function traceEnabled() {
  return !["0", "false", "off", "no"].includes(String(process.env.TRAINING_AGENT_TRACE || "1").toLowerCase());
}

function normalizeLimit(value) {
  return Math.max(1, Math.min(Number(value) || 100, 500));
}

function compactTrace(record = {}) {
  return {
    id: record.id || "",
    runId: record.runId || "",
    createdAt: record.createdAt || "",
    transport: record.transport || "",
    route: record.route || "",
    messageHash: record.messageHash || "",
    messagePreview: record.messagePreview || "",
    messageLength: record.messageLength || 0,
    confirmedSkill: record.confirmedSkill || "",
    confirmationTokenPresent: record.confirmationTokenPresent === true,
    confirmationVerified: record.confirmationVerified === true,
    decision: record.decision || null,
    result: record.result || {},
    error: record.error || "",
    latencyMs: Number(record.latencyMs) || 0,
  };
}

async function readTraceRecords() {
  if (!traceEnabled()) return { enabled: false, records: [] };
  try {
    const raw = await readFile(agentTracePath, "utf8");
    const records = raw.split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return compactTrace(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { enabled: true, records };
  } catch (error) {
    if (error?.code === "ENOENT") return { enabled: true, records: [] };
    throw error;
  }
}

function includesText(value, q) {
  if (!q) return true;
  return String(value || "").toLowerCase().includes(q);
}

export async function listAgentTraces(filters = {}) {
  const { enabled, records } = await readTraceRecords();
  const limit = normalizeLimit(filters.limit);
  const q = String(filters.q || "").trim().toLowerCase();
  const skill = String(filters.skill || "").trim();
  const action = String(filters.action || "").trim();
  const transport = String(filters.transport || "").trim();
  const hasError = filters.hasError === true || String(filters.hasError || "").toLowerCase() === "true";
  const filtered = records
    .reverse()
    .filter((trace) => !skill || trace.decision?.skill === skill || trace.confirmedSkill === skill)
    .filter((trace) => !action || trace.result?.action === action)
    .filter((trace) => !transport || trace.transport === transport)
    .filter((trace) => !hasError || Boolean(trace.error))
    .filter((trace) => !q || includesText(trace.messagePreview, q) || includesText(trace.decision?.reason, q))
    .slice(0, limit);
  return {
    enabled,
    path: agentTracePath,
    traces: filtered,
  };
}

export async function getAgentTrace(traceId) {
  const { enabled, records } = await readTraceRecords();
  return {
    enabled,
    path: agentTracePath,
    trace: records.find((record) => record.id === traceId) || null,
  };
}
