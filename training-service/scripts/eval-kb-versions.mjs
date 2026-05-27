import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-kb-versions-eval-"));
process.env.TRAINING_DATA_DIR = tempDir;
process.env.TRAINING_STORAGE = "sqlite";
process.env.TRAINING_IMPORT_MAX_UPLOAD_MB = "10";
process.env.TRAINING_JOB_CONCURRENCY = "1";

const { closeTrainingDatabase } = await import("../src/sqlite-store.mjs");
const { loadMemoryStore, upsertMemory } = await import("../src/memory/store.mjs");
const { importFromDirectory } = await import("../src/import/service.mjs");
const { listKnowledgeBaseVersions, knowledgeBaseVersionsFileExists } = await import("../src/knowledge-base-versions.mjs");
const { enqueueJob, startJobScheduler } = await import("../src/jobs/scheduler.mjs");
const { getJob } = await import("../src/jobs/store.mjs");
const { loadState, mutateState } = await import("../src/store.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForJob(jobId, timeoutMs = 35_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJob(jobId);
    if (job && ["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`job ${jobId} did not finish`);
}

async function writeVersionOne(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "motor-guide.md"), `# Motor guide

## Structure
Stator and rotor are core parts of the motor.

Version: v1
`, "utf8");
  await writeFile(path.join(dir, "sales.txt"), "Sales should explain efficiency, reliability and service promise.\n", "utf8");
}

async function writeVersionTwo(dir) {
  await writeFile(path.join(dir, "motor-guide.md"), `# Motor guide

## Structure
Stator, rotor, frame, bearing and fan are core parts of the motor.

Version: v2
`, "utf8");
  await unlink(path.join(dir, "sales.txt"));
  await writeFile(path.join(dir, "quality.md"), `# Quality

Rotor bar testing and iron-loss testing help prevent quality defects.
`, "utf8");
}

function docsFor(state, kbId) {
  return state.documents
    .filter((doc) => doc.knowledgeBaseId === kbId)
    .map((doc) => doc.sourcePath)
    .sort();
}

const results = [];

try {
  await startJobScheduler();
  const cleanDir = path.join(tempDir, "clean");
  await writeVersionOne(cleanDir);
  const first = await importFromDirectory({
    inputDir: cleanDir,
    kbName: "版本评测知识库",
    aliases: "版本评测",
    cleanMode: "direct",
  });
  const kbId = first.imported.kbId;
  let versions = await listKnowledgeBaseVersions(kbId);
  assert(versions.current, "first import should create current version");
  assert(!versions.previous, "first import should not create previous version for a new kb");
  assert(versions.current.diffFromPrevious.counts.added === 2, "first import should mark all docs as added");
  results.push({ name: "first import creates current version", ok: true, versionNo: versions.current.versionNo });

  await mutateState((state) => {
    state.tasks.push({ id: "task-kbv-eval", title: "KB version eval task", status: "published" });
    state.invites.push({ id: "invite-kbv-eval", taskId: "task-kbv-eval", token: "kbv-token" });
    state.quizzes.push({ id: "quiz-kbv-eval", taskId: "task-kbv-eval", questions: [] });
    state.attempts.push({ id: "attempt-kbv-eval", quizId: "quiz-kbv-eval", score: 100 });
  });
  await upsertMemory({
    id: "mem-kbv-eval",
    type: "preference",
    key: "kb.version.eval",
    scope: "boss",
    status: "active",
    text: "KB version eval memory",
    value: { ok: true },
    source: "eval",
  });

  await writeVersionTwo(cleanDir);
  const second = await importFromDirectory({
    inputDir: cleanDir,
    kbName: "版本评测知识库",
    aliases: "版本评测",
    cleanMode: "direct",
  });
  versions = await listKnowledgeBaseVersions(kbId);
  assert(second.imported.versionId === versions.current.id, "import result should expose current version id");
  assert(versions.current && versions.previous, "second import should keep current and previous");
  assert(versions.current.diffFromPrevious.counts.added === 1, "second import should detect one added document");
  assert(versions.current.diffFromPrevious.counts.removed === 1, "second import should detect one removed document");
  assert(versions.current.diffFromPrevious.counts.changed === 1, "second import should detect one changed document");
  results.push({ name: "second import records document diff", ok: true, diff: versions.current.diffFromPrevious.counts });

  const rollbackJob = await enqueueJob({
    type: "rollback_knowledge_base",
    title: "Rollback version eval kb",
    input: {
      kbId,
      versionId: versions.previous.id,
      autoEmbed: true,
    },
    inputSummary: { kbId, targetVersionId: versions.previous.id, autoEmbed: true },
  });
  const completedRollback = await waitForJob(rollbackJob.id);
  assert(completedRollback.status === "succeeded", `rollback should succeed: ${completedRollback.error}`);
  assert(completedRollback.childJobIds.length === 1, "rollback should create embedding child job");
  const child = await waitForJob(completedRollback.childJobIds[0]);
  assert(["succeeded", "failed"].includes(child.status), "embedding child should finish cleanly");

  const stateAfterRollback = await loadState();
  const restoredDocs = docsFor(stateAfterRollback, kbId);
  assert(restoredDocs.includes("sales.txt"), "rollback should restore removed document");
  assert(!restoredDocs.includes("quality.md"), "rollback should remove document added after target version");
  assert(stateAfterRollback.tasks.some((item) => item.id === "task-kbv-eval"), "task should survive rollback");
  assert(stateAfterRollback.invites.some((item) => item.id === "invite-kbv-eval"), "invite should survive rollback");
  assert(stateAfterRollback.quizzes.some((item) => item.id === "quiz-kbv-eval"), "quiz should survive rollback");
  assert(stateAfterRollback.attempts.some((item) => item.id === "attempt-kbv-eval"), "attempt should survive rollback");
  const memoryAfterRollback = await loadMemoryStore();
  assert(memoryAfterRollback.memories.some((item) => item.id === "mem-kbv-eval"), "memory should survive rollback");
  versions = await listKnowledgeBaseVersions(kbId);
  assert(versions.current.source === "rollback", "rollback should create a new current rollback version");
  assert(versions.previous.source === "import", "previous slot should keep the pre-rollback current import");
  results.push({ name: "rollback restores content and preserves business data", ok: true, childStatus: child.status });

  closeTrainingDatabase();
  process.env.TRAINING_STORAGE = "json";
  const jsonDir = path.join(tempDir, "json-clean");
  await writeVersionOne(jsonDir);
  const jsonImport = await importFromDirectory({
    inputDir: jsonDir,
    kbName: "JSON 版本评测知识库",
    aliases: "JSON版本评测",
    cleanMode: "direct",
  });
  const jsonVersions = await listKnowledgeBaseVersions(jsonImport.imported.kbId);
  assert(knowledgeBaseVersionsFileExists(), "json storage should write knowledge-base-versions.json");
  assert(jsonVersions.current, "json storage should create current version");
  results.push({ name: "json version store", ok: true });

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
