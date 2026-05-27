import {
  appendJobEvent,
  createJob,
  getJob,
  listJobs,
  requestJobCancel,
  resetInterruptedJobs,
  saveJob,
  setJobProgress,
  updateJob,
} from "./store.mjs";
import { getJobHandler } from "./handlers.mjs";

const running = new Map();
let started = false;
let scheduling = false;

function nowIso() {
  return new Date().toISOString();
}

function concurrency() {
  const value = Number(process.env.TRAINING_JOB_CONCURRENCY || 1);
  return Math.max(1, Math.min(Number.isFinite(value) ? value : 1, 4));
}

function isCancelError(error) {
  return error?.code === "JOB_CANCELLED" || /取消|cancel/i.test(String(error?.message || error || ""));
}

function compactError(error) {
  return error instanceof Error ? error.message : String(error || "任务失败");
}

async function finishJob(jobId, patch) {
  return await updateJob(jobId, (job) => ({
    ...job,
    ...patch,
    finishedAt: patch.finishedAt || nowIso(),
    progress: patch.progress || job.progress,
  }));
}

async function runOne(job) {
  const handler = getJobHandler(job.type);
  if (!handler) {
    await finishJob(job.id, {
      status: "failed",
      error: `不支持的任务类型：${job.type}`,
      progress: { percent: 100, stage: "failed", label: "任务失败", detail: `不支持的任务类型：${job.type}` },
    });
    return;
  }
  const controller = new AbortController();
  running.set(job.id, controller);
  await updateJob(job.id, (value) => ({
    ...value,
    status: "running",
    startedAt: value.startedAt || nowIso(),
    progress: { ...value.progress, percent: Math.max(value.progress?.percent || 0, 1), stage: "running", label: "开始执行", updatedAt: nowIso() },
  }));
  await appendJobEvent(job.id, { message: "任务开始执行" });
  try {
    const result = await handler(await getJob(job.id), {
      signal: controller.signal,
      progress: async (progress) => {
        const current = await getJob(job.id);
        if (current?.cancelRequested) controller.abort();
        if (controller.signal.aborted) {
          const error = new Error("任务已取消");
          error.code = "JOB_CANCELLED";
          throw error;
        }
        await setJobProgress(job.id, progress);
      },
      enqueueChild: async (childInput) => {
        const child = await enqueueJob({ ...childInput, parentJobId: job.id });
        await updateJob(job.id, (value) => ({
          ...value,
          childJobIds: [...new Set([...(value.childJobIds || []), child.id])],
        }));
        return child;
      },
    });
    await finishJob(job.id, {
      status: "succeeded",
      result: result?.result || null,
      resultSummary: result?.resultSummary || {},
      error: "",
      progress: { percent: 100, stage: "succeeded", label: "任务完成", detail: "", updatedAt: nowIso() },
    });
    await appendJobEvent(job.id, { message: "任务执行成功" });
  } catch (error) {
    const cancelled = isCancelError(error);
    await finishJob(job.id, {
      status: cancelled ? "cancelled" : "failed",
      error: cancelled ? "" : compactError(error),
      progress: {
        percent: 100,
        stage: cancelled ? "cancelled" : "failed",
        label: cancelled ? "任务已取消" : "任务失败",
        detail: cancelled ? "" : compactError(error),
        updatedAt: nowIso(),
      },
    });
    await appendJobEvent(job.id, { level: cancelled ? "warn" : "error", message: cancelled ? "任务已取消" : compactError(error) });
  } finally {
    running.delete(job.id);
    scheduleJobs().catch(() => {});
  }
}

export async function scheduleJobs() {
  if (scheduling) return;
  scheduling = true;
  try {
    while (running.size < concurrency()) {
      const queued = (await listJobs({ status: "queued", limit: 500 }))
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
      const next = queued.find((job) => !running.has(job.id));
      if (!next) break;
      runOne(next).catch(() => {});
    }
  } finally {
    scheduling = false;
  }
}

export async function enqueueJob(input) {
  const job = await createJob(input);
  await appendJobEvent(job.id, { message: "任务已入队" });
  scheduleJobs().catch(() => {});
  return job;
}

export async function cancelJob(jobId) {
  const job = await requestJobCancel(jobId);
  const controller = running.get(String(jobId || ""));
  if (controller) controller.abort();
  scheduleJobs().catch(() => {});
  return job;
}

export async function startJobScheduler() {
  if (started) return;
  started = true;
  await resetInterruptedJobs();
  await scheduleJobs();
}

export function runningJobIds() {
  return [...running.keys()];
}
