import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../store.mjs";
import { isSqliteStorage, openTrainingDatabase } from "../sqlite-store.mjs";
import { writeJsonAtomic } from "../storage/atomic-json.mjs";

export const JOB_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
export const jobsPath = path.join(dataDir, "jobs.json");

let jsonWriteLock = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function makeJobId() {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function compact(value, limit = 300) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function normalizeStatus(value) {
  const status = String(value || "queued").toLowerCase();
  return JOB_STATUSES.has(status) ? status : "queued";
}

function normalizeProgress(progress = {}) {
  return {
    percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
    stage: compact(progress.stage || "", 80),
    label: compact(progress.label || "", 120),
    detail: compact(progress.detail || "", 220),
    updatedAt: progress.updatedAt || nowIso(),
  };
}

export function summarizeJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    title: job.title,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || "",
    finishedAt: job.finishedAt || "",
    progress: job.progress,
    inputSummary: job.inputSummary || {},
    resultSummary: job.resultSummary || {},
    error: job.error || "",
    parentJobId: job.parentJobId || "",
    childJobIds: Array.isArray(job.childJobIds) ? job.childJobIds : [],
    cancelRequested: job.cancelRequested === true,
  };
}

export function normalizeJob(job = {}) {
  const createdAt = job.createdAt || nowIso();
  return {
    id: String(job.id || makeJobId()),
    type: String(job.type || "unknown"),
    status: normalizeStatus(job.status),
    title: compact(job.title || job.type || "任务", 160),
    createdAt,
    updatedAt: job.updatedAt || createdAt,
    startedAt: job.startedAt || "",
    finishedAt: job.finishedAt || "",
    progress: normalizeProgress(job.progress || {}),
    input: job.input && typeof job.input === "object" ? job.input : {},
    inputSummary: job.inputSummary && typeof job.inputSummary === "object" ? job.inputSummary : {},
    result: job.result && typeof job.result === "object" ? job.result : null,
    resultSummary: job.resultSummary && typeof job.resultSummary === "object" ? job.resultSummary : {},
    error: job.error ? compact(job.error, 500) : "",
    parentJobId: job.parentJobId || "",
    childJobIds: Array.isArray(job.childJobIds) ? job.childJobIds.map(String) : [],
    cancelRequested: job.cancelRequested === true,
    events: Array.isArray(job.events) ? job.events.slice(-200) : [],
  };
}

function rowFields(job) {
  return {
    id: job.id,
    knowledgeBaseId: job.input?.kbId || job.input?.kbName || job.resultSummary?.kbId || "",
    documentId: "",
    taskId: job.parentJobId || "",
    employeeId: "",
    inviteId: "",
    token: "",
    parentId: job.parentJobId || "",
    status: job.status,
    type: job.type,
    key: job.title || "",
    scope: "jobs",
    createdAt: job.createdAt || "",
    updatedAt: job.updatedAt || "",
    rowOrder: Date.parse(job.createdAt || "") || Date.now(),
    json: JSON.stringify(job),
  };
}

async function readJsonStore() {
  try {
    const raw = await readFile(jobsPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      meta: parsed.meta || { version: 1 },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map(normalizeJob) : [],
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { meta: { version: 1, createdAt: nowIso(), updatedAt: nowIso() }, jobs: [] };
  }
}

async function writeJsonStore(store) {
  const value = {
    meta: {
      ...(store.meta || {}),
      version: 1,
      updatedAt: nowIso(),
    },
    jobs: Array.isArray(store.jobs) ? store.jobs.map(normalizeJob) : [],
  };
  await writeJsonAtomic(jobsPath, value);
}

async function withJsonStore(mutator) {
  const run = async () => {
    const store = await readJsonStore();
    const result = await mutator(store);
    await writeJsonStore(store);
    return result;
  };
  jsonWriteLock = jsonWriteLock.then(run, run);
  return await jsonWriteLock;
}

function upsertSqliteJob(job) {
  const db = openTrainingDatabase(dataDir);
  const fields = rowFields(job);
  db.prepare(`
    INSERT INTO jobs (
      id, knowledgeBaseId, documentId, taskId, employeeId, inviteId, token, parentId,
      status, type, key, scope, createdAt, updatedAt, rowOrder, json
    ) VALUES (
      @id, @knowledgeBaseId, @documentId, @taskId, @employeeId, @inviteId, @token, @parentId,
      @status, @type, @key, @scope, @createdAt, @updatedAt, @rowOrder, @json
    )
    ON CONFLICT(id) DO UPDATE SET
      knowledgeBaseId = excluded.knowledgeBaseId,
      taskId = excluded.taskId,
      parentId = excluded.parentId,
      status = excluded.status,
      type = excluded.type,
      key = excluded.key,
      updatedAt = excluded.updatedAt,
      rowOrder = excluded.rowOrder,
      json = excluded.json
  `).run(fields);
}

function readSqliteJob(jobId) {
  const db = openTrainingDatabase(dataDir);
  const row = db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId);
  return row ? normalizeJob(JSON.parse(row.json)) : null;
}

export async function saveJob(job) {
  const value = normalizeJob({ ...job, updatedAt: nowIso() });
  if (isSqliteStorage()) {
    upsertSqliteJob(value);
    return value;
  }
  return await withJsonStore((store) => {
    const index = store.jobs.findIndex((item) => item.id === value.id);
    if (index >= 0) store.jobs[index] = value;
    else store.jobs.push(value);
    return value;
  });
}

export async function createJob(input = {}) {
  return await saveJob(normalizeJob({
    id: input.id || makeJobId(),
    type: input.type,
    title: input.title,
    input: input.input || {},
    inputSummary: input.inputSummary || {},
    parentJobId: input.parentJobId || "",
    progress: input.progress || { percent: 0, stage: "queued", label: "等待执行" },
  }));
}

export async function getJob(jobId) {
  if (isSqliteStorage()) return readSqliteJob(String(jobId || ""));
  const store = await readJsonStore();
  return store.jobs.find((job) => job.id === String(jobId || "")) || null;
}

export async function listJobs(filters = {}) {
  const limit = Math.max(1, Math.min(Number(filters.limit) || 100, 500));
  let jobs;
  if (isSqliteStorage()) {
    const db = openTrainingDatabase(dataDir);
    jobs = db.prepare("SELECT json FROM jobs ORDER BY createdAt DESC, id DESC LIMIT ?").all(limit * 3)
      .map((row) => normalizeJob(JSON.parse(row.json)));
  } else {
    const store = await readJsonStore();
    jobs = store.jobs.slice().sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }
  const status = String(filters.status || "").trim();
  const type = String(filters.type || "").trim();
  return jobs
    .filter((job) => !status || job.status === status)
    .filter((job) => !type || job.type === type)
    .slice(0, limit);
}

export async function updateJob(jobId, updater) {
  const existing = await getJob(jobId);
  if (!existing) return null;
  const next = normalizeJob(await updater({ ...existing, events: [...existing.events] }) || existing);
  return await saveJob(next);
}

export async function appendJobEvent(jobId, event = {}) {
  return await updateJob(jobId, (job) => {
    job.events.push({
      at: nowIso(),
      level: event.level || "info",
      message: compact(event.message || "", 300),
      data: event.data && typeof event.data === "object" ? event.data : undefined,
    });
    job.events = job.events.slice(-200);
    return job;
  });
}

export async function setJobProgress(jobId, progress = {}) {
  return await updateJob(jobId, (job) => {
    job.progress = normalizeProgress({
      ...job.progress,
      ...progress,
      updatedAt: nowIso(),
    });
    return job;
  });
}

export async function requestJobCancel(jobId) {
  return await updateJob(jobId, (job) => {
    if (job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = nowIso();
      job.progress = normalizeProgress({ percent: 100, stage: "cancelled", label: "已取消" });
      job.events.push({ at: nowIso(), level: "warn", message: "任务在排队时被取消" });
    } else if (job.status === "running") {
      job.cancelRequested = true;
      job.events.push({ at: nowIso(), level: "warn", message: "已请求取消，运行中的任务会在下一个安全点停止" });
    }
    return job;
  });
}

export async function resetInterruptedJobs() {
  const running = await listJobs({ status: "running", limit: 500 });
  const failed = [];
  for (const job of running) {
    const next = await updateJob(job.id, (value) => {
      value.status = "failed";
      value.error = "服务重启时任务仍在运行，已标记为失败。";
      value.finishedAt = nowIso();
      value.progress = normalizeProgress({ ...value.progress, stage: "interrupted", label: "服务重启中断" });
      value.events.push({ at: nowIso(), level: "error", message: value.error });
      return value;
    });
    if (next) failed.push(next);
  }
  return failed;
}

export function jobsFileExists() {
  return existsSync(jobsPath);
}
