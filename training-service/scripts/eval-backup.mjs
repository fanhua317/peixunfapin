import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-backup-eval-"));
process.env.TRAINING_DATA_DIR = tempDir;
process.env.TRAINING_STORAGE = "sqlite";

const { createDataBackup, restoreDataBackup, verifyDataBackup } = await import("../src/data-backup.mjs");
const { closeTrainingDatabase } = await import("../src/sqlite-store.mjs");
const { loadMemoryStore, upsertMemory, appendConversationEntries } = await import("../src/memory/store.mjs");
const { loadState, mutateState } = await import("../src/store.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

const results = [];

try {
  await mutateState((state) => {
    state.tasks.push({
      id: "task-backup-eval",
      title: "Backup eval task",
      status: "published",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });
  await upsertMemory({
    id: "mem-backup-eval",
    type: "preference",
    key: "marketing.channel",
    scope: "boss",
    status: "active",
    text: "Prefer public account articles",
    value: { channel: "公众号" },
    source: "eval",
    confidence: 1,
  });
  await appendConversationEntries([
    { sessionId: "backup-eval", role: "user", content: "备份测试消息", action: "eval" },
  ]);
  await writeFile(path.join(tempDir, "agent-traces.jsonl"), `${JSON.stringify({ id: "trace-backup-eval" })}\n`, "utf8");
  await writeFile(path.join(tempDir, "agent-runs.jsonl"), `${JSON.stringify({ id: "run-backup-eval" })}\n`, "utf8");
  await writeFile(path.join(tempDir, "vector-index-bge-m3.json"), JSON.stringify({ model: "bge-m3", items: [1] }), "utf8");
  results.push({ name: "seed data", ok: true });

  const backup = await createDataBackup();
  assert(backup.ok && backup.backupPath.endsWith(".zip"), "expected backup zip");
  assert(backup.manifest.files.some((file) => file.path === "training.db"), "expected sqlite snapshot in backup");
  assert(backup.manifest.files.some((file) => file.path === "conversation-history.jsonl"), "expected conversation history in backup");
  assert(backup.manifest.files.some((file) => file.path === "agent-runs.jsonl"), "expected agent runs in backup");
  results.push({ name: "backup created", ok: true });

  const verified = await verifyDataBackup({ from: backup.backupPath });
  assert(verified.ok && verified.verifiedFiles.includes("training.db"), "expected verified sqlite backup");
  results.push({ name: "backup verified", ok: true });

  const retentionDir = path.join(tempDir, "retention-backups");
  const oldBackup = await createDataBackup({
    out: retentionDir,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const keepBackup = await createDataBackup({
    out: retentionDir,
    createdAt: "2026-01-10T00:00:00.000Z",
  });
  const retentionBackup = await createDataBackup({
    out: retentionDir,
    createdAt: "2026-01-20T00:00:00.000Z",
    now: "2026-01-20T00:00:00.000Z",
    retentionDays: 7,
    keepLast: 2,
  });
  assert(retentionBackup.retention?.deleted?.some((item) => item.path === oldBackup.backupPath), "expected old backup to be pruned");
  assert(!(await fileExists(oldBackup.backupPath)), "old backup should be deleted");
  assert(await fileExists(keepBackup.backupPath), "keep-last backup should be retained");
  assert(await fileExists(retentionBackup.backupPath), "new backup should be retained");
  results.push({ name: "backup retention prunes old files and keeps latest", ok: true });

  const dryRestore = await restoreDataBackup({ from: backup.backupPath });
  assert(dryRestore.ok && !dryRestore.restored && dryRestore.requiresForce, "restore without force should only verify");
  results.push({ name: "restore requires force", ok: true });

  await mutateState((state) => {
    state.tasks = [];
  });
  await writeFile(path.join(tempDir, "conversation-history.jsonl"), "", "utf8");
  await writeFile(path.join(tempDir, "agent-runs.jsonl"), "", "utf8");
  await writeFile(path.join(tempDir, "vector-index-bge-m3.json"), JSON.stringify({ items: [] }), "utf8");
  const restored = await restoreDataBackup({ from: backup.backupPath, force: true });
  assert(restored.restored && restored.safetyBackupPath, "expected forced restore with safety backup");
  results.push({ name: "backup restored", ok: true });

  const state = await loadState();
  const memory = await loadMemoryStore();
  const history = await readFile(path.join(tempDir, "conversation-history.jsonl"), "utf8");
  const runs = await readFile(path.join(tempDir, "agent-runs.jsonl"), "utf8");
  const vectorIndex = JSON.parse(await readFile(path.join(tempDir, "vector-index-bge-m3.json"), "utf8"));
  assert(state.tasks.some((task) => task.id === "task-backup-eval"), "restored task missing");
  assert(memory.memories.some((item) => item.id === "mem-backup-eval"), "restored memory missing");
  assert(/备份测试消息/.test(history), "restored conversation history missing");
  assert(/run-backup-eval/.test(runs), "restored agent runs missing");
  assert(vectorIndex.items?.[0] === 1, "restored vector index missing");
  results.push({ name: "restored data readable", ok: true });

  console.log(JSON.stringify({ ok: true, total: results.length, results }, null, 2));
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
