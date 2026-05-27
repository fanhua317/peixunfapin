import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-jobs-eval-"));
process.env.TRAINING_DATA_DIR = tempDir;
process.env.TRAINING_STORAGE = "sqlite";
process.env.TRAINING_IMPORT_MAX_UPLOAD_MB = "10";
process.env.TRAINING_JOB_CONCURRENCY = "1";

const { closeTrainingDatabase } = await import("../src/sqlite-store.mjs");
const { loadMemoryStore, upsertMemory } = await import("../src/memory/store.mjs");
const { loadState, mutateState } = await import("../src/store.mjs");
const { enqueueJob, startJobScheduler, cancelJob } = await import("../src/jobs/scheduler.mjs");
const { createJob, getJob, jobsFileExists, listJobs, resetInterruptedJobs, saveJob } = await import("../src/jobs/store.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForJob(jobId, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJob(jobId);
    if (job && ["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`job ${jobId} did not finish`);
}

async function writeSampleCleanDir(dir, version = "v1") {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "motor-guide.md"), `# 电机培训资料

来源文件：motor-guide.md

## 定子与转子

三相异步电动机主要包括定子、转子、机座、端盖、轴承和风扇。

## 质量控制

铁损检测仪用于控制硅钢片质量，铸铝断条检测仪用于避免不良转子流出。

版本：${version}
`, "utf8");
}

const results = [];

try {
  await startJobScheduler();
  const cleanDir = path.join(tempDir, "clean-one");
  await writeSampleCleanDir(cleanDir);
  await mutateState((state) => {
    state.tasks.push({ id: "task-jobs-eval", title: "Jobs eval task", status: "published" });
    state.invites.push({ id: "invite-jobs-eval", taskId: "task-jobs-eval", token: "jobs-token" });
    state.quizzes.push({ id: "quiz-jobs-eval", taskId: "task-jobs-eval", questions: [] });
    state.attempts.push({ id: "attempt-jobs-eval", quizId: "quiz-jobs-eval", score: 100 });
  });
  await upsertMemory({
    id: "mem-jobs-eval",
    type: "preference",
    key: "marketing.channel",
    scope: "boss",
    status: "active",
    text: "任务评测记忆",
    value: { channel: "公众号" },
    source: "eval",
  });

  const importJob = await enqueueJob({
    type: "import_directory",
    title: "导入任务评测资料库",
    input: {
      sourceDir: cleanDir,
      kbName: "任务评测资料库",
      aliases: "任务评测,电机",
      cleanMode: "direct",
      autoEmbed: true,
    },
    inputSummary: { source: "directory", kbName: "任务评测资料库", autoEmbed: true },
  });
  const completedImport = await waitForJob(importJob.id);
  assert(completedImport.status === "succeeded", `expected import succeeded, got ${completedImport.status}: ${completedImport.error}`);
  assert(completedImport.resultSummary.kbId, "import job should expose kb id");
  assert(completedImport.childJobIds.length === 1, "import job should create one embedding child job");
  results.push({ name: "async directory import", ok: true, resultSummary: completedImport.resultSummary });

  const stateAfterImport = await loadState();
  const memoryAfterImport = await loadMemoryStore();
  assert(stateAfterImport.tasks.some((item) => item.id === "task-jobs-eval"), "task should survive async import");
  assert(stateAfterImport.invites.some((item) => item.id === "invite-jobs-eval"), "invite should survive async import");
  assert(stateAfterImport.quizzes.some((item) => item.id === "quiz-jobs-eval"), "quiz should survive async import");
  assert(stateAfterImport.attempts.some((item) => item.id === "attempt-jobs-eval"), "attempt should survive async import");
  assert(memoryAfterImport.memories.some((item) => item.id === "mem-jobs-eval"), "memory should survive async import");
  results.push({ name: "async import preserves business state and memory", ok: true });

  const child = await waitForJob(completedImport.childJobIds[0], 40_000);
  assert(["succeeded", "failed"].includes(child.status), "embedding child should finish as succeeded or failed");
  if (child.status === "failed") assert(child.error, "failed embedding child should expose clear error");
  results.push({ name: "auto embedding child job", ok: true, status: child.status, error: child.error || "" });

  const queued = await createJob({
    type: "embed_local",
    title: "取消排队任务",
    input: { kbId: completedImport.resultSummary.kbId },
    inputSummary: { kbId: completedImport.resultSummary.kbId },
  });
  const cancelled = await cancelJob(queued.id);
  assert(cancelled.status === "cancelled", "queued job should be cancelled");
  results.push({ name: "queued cancel", ok: true });

  const interrupted = await saveJob({
    id: "job-interrupted-eval",
    type: "embed_local",
    title: "中断任务",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: { percent: 50, stage: "embedding", label: "运行中" },
  });
  assert(interrupted.status === "running", "interrupted seed should be running");
  const reset = await resetInterruptedJobs();
  const resetJob = await getJob("job-interrupted-eval");
  assert(reset.some((job) => job.id === "job-interrupted-eval"), "reset should include interrupted job");
  assert(resetJob.status === "failed", "running job should become failed after reset");
  results.push({ name: "restart recovery", ok: true });

  process.env.TRAINING_STORAGE = "json";
  const jsonJob = await createJob({
    type: "embed_local",
    title: "JSON 模式任务",
    input: { kbId: completedImport.resultSummary.kbId },
    inputSummary: { kbId: completedImport.resultSummary.kbId },
  });
  const jsonJobs = await listJobs({ limit: 10 });
  assert(jobsFileExists(), "jobs.json should exist in json storage mode");
  assert(jsonJobs.some((job) => job.id === jsonJob.id), "json storage should list created job");
  results.push({ name: "json jobs store", ok: true });

  console.log(JSON.stringify({ ok: true, tempDir, total: results.length, results }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    results,
  }, null, 2));
  process.exitCode = 1;
} finally {
  closeTrainingDatabase();
  await rm(tempDir, { recursive: true, force: true });
}
