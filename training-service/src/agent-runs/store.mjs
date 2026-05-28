import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../store.mjs";
import { isSqliteStorage, openTrainingDatabase } from "../sqlite-store.mjs";

export const agentRunsPath = path.join(dataDir, "agent-runs.jsonl");

const RUN_STATUSES = new Set(["running", "succeeded", "failed"]);
const STEP_STATUSES = new Set(["running", "succeeded", "failed", "skipped"]);

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return compact(value, depth ? 360 : 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (/token|api[_-]?key|password|secret/i.test(key)) {
        output[key] = item ? "[redacted]" : item;
      } else {
        output[key] = sanitizeValue(item, depth + 1);
      }
    }
    return output;
  }
  return compact(value);
}

function normalizeStatus(value, fallback = "running") {
  const status = String(value || fallback).toLowerCase();
  return RUN_STATUSES.has(status) ? status : fallback;
}

function normalizeStepStatus(value, fallback = "succeeded") {
  const status = String(value || fallback).toLowerCase();
  return STEP_STATUSES.has(status) ? status : fallback;
}

function normalizeRun(run = {}) {
  const createdAt = run.createdAt || nowIso();
  return {
    id: String(run.id || makeId("run")),
    sessionId: compact(run.sessionId || "", 120),
    transport: compact(run.transport || "http", 40),
    route: compact(run.route || "", 120),
    messageHash: run.messageHash || hash(run.message || ""),
    messagePreview: compact(run.messagePreview || run.message || "", 240),
    messageLength: Number(run.messageLength ?? String(run.message || "").length) || 0,
    status: normalizeStatus(run.status),
    intent: compact(run.intent || "", 80),
    skill: compact(run.skill || "", 80),
    action: compact(run.action || "", 80),
    confirmedSkill: compact(run.confirmedSkill || "", 80),
    confirmationTokenPresent: run.confirmationTokenPresent === true,
    confirmationVerified: run.confirmationVerified === true,
    latencyMs: Number(run.latencyMs) || 0,
    error: run.error ? compact(run.error, 500) : "",
    createdAt,
    finishedAt: run.finishedAt || "",
    summary: sanitizeValue(run.summary || {}),
    steps: Array.isArray(run.steps) ? run.steps.map(normalizeStep) : [],
  };
}

function normalizeStep(step = {}) {
  const startedAt = step.startedAt || nowIso();
  const finishedAt = step.finishedAt || startedAt;
  return {
    id: String(step.id || makeId("step")),
    runId: String(step.runId || ""),
    type: compact(step.type || "event", 80),
    name: compact(step.name || step.type || "event", 120),
    status: normalizeStepStatus(step.status),
    startedAt,
    finishedAt,
    latencyMs: Number(step.latencyMs) || Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) || 0,
    summary: sanitizeValue(step.summary || {}),
    error: step.error ? compact(step.error, 500) : "",
    stepOrder: Number(step.stepOrder) || Date.now(),
  };
}

function ensureRunTables() {
  const db = openTrainingDatabase(dataDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      sessionId TEXT,
      transport TEXT,
      route TEXT,
      messageHash TEXT,
      messagePreview TEXT,
      status TEXT,
      intent TEXT,
      skill TEXT,
      action TEXT,
      confirmedSkill TEXT,
      hasError INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT,
      finishedAt TEXT,
      latencyMs INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at ON agent_runs(createdAt);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_skill ON agent_runs(skill);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_action ON agent_runs(action);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_transport ON agent_runs(transport);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_has_error ON agent_runs(hasError);

    CREATE TABLE IF NOT EXISTS agent_steps (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      stepOrder INTEGER NOT NULL DEFAULT 0,
      type TEXT,
      name TEXT,
      status TEXT,
      startedAt TEXT,
      finishedAt TEXT,
      latencyMs INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(runId, stepOrder);
    CREATE INDEX IF NOT EXISTS idx_agent_steps_type ON agent_steps(type);
    CREATE INDEX IF NOT EXISTS idx_agent_steps_status ON agent_steps(status);
  `);
  return db;
}

function sqliteRunFields(run) {
  return {
    id: run.id,
    sessionId: run.sessionId,
    transport: run.transport,
    route: run.route,
    messageHash: run.messageHash,
    messagePreview: run.messagePreview,
    status: run.status,
    intent: run.intent,
    skill: run.skill,
    action: run.action,
    confirmedSkill: run.confirmedSkill,
    hasError: run.error ? 1 : 0,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    latencyMs: run.latencyMs,
    error: run.error,
    json: JSON.stringify({ ...run, steps: undefined }),
  };
}

function saveSqliteRun(run) {
  const db = ensureRunTables();
  db.prepare(`
    INSERT INTO agent_runs (
      id, sessionId, transport, route, messageHash, messagePreview, status,
      intent, skill, action, confirmedSkill, hasError, createdAt, finishedAt,
      latencyMs, error, json
    ) VALUES (
      @id, @sessionId, @transport, @route, @messageHash, @messagePreview, @status,
      @intent, @skill, @action, @confirmedSkill, @hasError, @createdAt, @finishedAt,
      @latencyMs, @error, @json
    )
    ON CONFLICT(id) DO UPDATE SET
      sessionId = excluded.sessionId,
      transport = excluded.transport,
      route = excluded.route,
      messageHash = excluded.messageHash,
      messagePreview = excluded.messagePreview,
      status = excluded.status,
      intent = excluded.intent,
      skill = excluded.skill,
      action = excluded.action,
      confirmedSkill = excluded.confirmedSkill,
      hasError = excluded.hasError,
      finishedAt = excluded.finishedAt,
      latencyMs = excluded.latencyMs,
      error = excluded.error,
      json = excluded.json
  `).run(sqliteRunFields(run));
  return run;
}

function saveSqliteStep(step) {
  const db = ensureRunTables();
  db.prepare(`
    INSERT INTO agent_steps (
      id, runId, stepOrder, type, name, status, startedAt, finishedAt,
      latencyMs, error, json
    ) VALUES (
      @id, @runId, @stepOrder, @type, @name, @status, @startedAt, @finishedAt,
      @latencyMs, @error, @json
    )
    ON CONFLICT(id) DO UPDATE SET
      stepOrder = excluded.stepOrder,
      type = excluded.type,
      name = excluded.name,
      status = excluded.status,
      startedAt = excluded.startedAt,
      finishedAt = excluded.finishedAt,
      latencyMs = excluded.latencyMs,
      error = excluded.error,
      json = excluded.json
  `).run({
    ...step,
    json: JSON.stringify(step),
  });
  return step;
}

async function appendJsonSnapshot(run) {
  await mkdir(path.dirname(agentRunsPath), { recursive: true });
  await appendFile(agentRunsPath, `${JSON.stringify({ type: "run_snapshot", run })}\n`, "utf8");
}

async function readJsonRuns() {
  if (!existsSync(agentRunsPath)) return [];
  const raw = await readFile(agentRunsPath, "utf8");
  const byId = new Map();
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      const run = normalizeRun(parsed.run || parsed);
      if (run.id) byId.set(run.id, run);
    } catch {
      // Ignore malformed lines in append-only diagnostics.
    }
  }
  return [...byId.values()];
}

async function saveRun(run) {
  const value = normalizeRun(run);
  if (isSqliteStorage()) return saveSqliteRun(value);
  await appendJsonSnapshot(value);
  return value;
}

async function readRun(runId) {
  if (isSqliteStorage()) {
    const db = ensureRunTables();
    const row = db.prepare("SELECT json FROM agent_runs WHERE id = ?").get(String(runId || ""));
    if (!row) return null;
    const run = normalizeRun(JSON.parse(row.json));
    run.steps = db.prepare("SELECT json FROM agent_steps WHERE runId = ? ORDER BY stepOrder ASC, startedAt ASC")
      .all(run.id)
      .map((item) => normalizeStep(JSON.parse(item.json)));
    return run;
  }
  return (await readJsonRuns()).find((run) => run.id === String(runId || "")) || null;
}

export async function startRun(input = {}) {
  return await saveRun(normalizeRun({
    ...input,
    status: "running",
    createdAt: nowIso(),
  }));
}

export async function appendRunStep(runId, step = {}) {
  if (!runId) return null;
  const run = await readRun(runId);
  if (!run) return null;
  const value = normalizeStep({ ...step, runId });
  if (isSqliteStorage()) {
    saveSqliteStep(value);
    return value;
  }
  run.steps.push(value);
  await saveRun(run);
  return value;
}

export async function finishRun(runId, update = {}) {
  const run = await readRun(runId);
  if (!run) return null;
  const finishedAt = nowIso();
  const decision = update.decision || {};
  const result = update.result || {};
  const next = normalizeRun({
    ...run,
    status: "succeeded",
    intent: update.intent || decision.intent || run.intent,
    skill: update.skill || decision.skill || run.skill,
    action: update.action || result.action || run.action,
    confirmationVerified: update.confirmationVerified ?? run.confirmationVerified,
    finishedAt,
    latencyMs: update.latencyMs ?? Math.max(0, Date.parse(finishedAt) - Date.parse(run.createdAt)),
    summary: {
      ...run.summary,
      ...(update.summary || {}),
    },
  });
  return await saveRun(next);
}

export async function failRun(runId, error, update = {}) {
  const run = await readRun(runId);
  if (!run) return null;
  const finishedAt = nowIso();
  const next = normalizeRun({
    ...run,
    status: "failed",
    intent: update.intent || update.decision?.intent || run.intent,
    skill: update.skill || update.decision?.skill || run.skill,
    action: update.action || run.action || "error",
    error: error instanceof Error ? error.message : String(error || ""),
    finishedAt,
    latencyMs: update.latencyMs ?? Math.max(0, Date.parse(finishedAt) - Date.parse(run.createdAt)),
    summary: {
      ...run.summary,
      ...(update.summary || {}),
    },
  });
  return await saveRun(next);
}

function includesText(value, q) {
  return String(value || "").toLowerCase().includes(q);
}

function normalizeLimit(value) {
  return Math.max(1, Math.min(Number(value) || 100, 500));
}

export async function listRuns(filters = {}) {
  const limit = normalizeLimit(filters.limit);
  const status = String(filters.status || "").trim();
  const skill = String(filters.skill || "").trim();
  const action = String(filters.action || "").trim();
  const transport = String(filters.transport || "").trim();
  const hasError = filters.hasError === true || String(filters.hasError || "").toLowerCase() === "true";
  const q = String(filters.q || "").trim().toLowerCase();
  let runs;
  if (isSqliteStorage()) {
    const db = ensureRunTables();
    runs = db.prepare("SELECT json FROM agent_runs ORDER BY createdAt DESC, id DESC LIMIT ?")
      .all(limit * 4)
      .map((row) => normalizeRun(JSON.parse(row.json)));
  } else {
    runs = (await readJsonRuns()).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }
  return runs
    .filter((run) => !status || run.status === status)
    .filter((run) => !skill || run.skill === skill || run.confirmedSkill === skill)
    .filter((run) => !action || run.action === action)
    .filter((run) => !transport || run.transport === transport)
    .filter((run) => !hasError || Boolean(run.error))
    .filter((run) => !q || includesText(run.messagePreview, q) || includesText(run.summary?.reason, q) || includesText(run.error, q))
    .slice(0, limit)
    .map((run) => ({ ...run, steps: undefined }));
}

export async function getRun(runId) {
  return await readRun(runId);
}

export async function recordRunStep(runId, type, name, fn, summaryFn) {
  const startedAt = nowIso();
  const startedMs = Date.now();
  try {
    const result = await fn();
    await appendRunStep(runId, {
      type,
      name,
      status: "succeeded",
      startedAt,
      finishedAt: nowIso(),
      latencyMs: Date.now() - startedMs,
      summary: typeof summaryFn === "function" ? summaryFn(result) : {},
    });
    return result;
  } catch (error) {
    await appendRunStep(runId, {
      type,
      name,
      status: "failed",
      startedAt,
      finishedAt: nowIso(),
      latencyMs: Date.now() - startedMs,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
