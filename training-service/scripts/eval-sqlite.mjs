import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-sqlite-eval-"));
process.env.TRAINING_DATA_DIR = tempDir;
process.env.TRAINING_STORAGE = "sqlite";

const { dataDir, defaultState, loadState, mutateState, statePath } = await import("../src/store.mjs");
const { defaultMemoryStore, loadMemoryStore, memoryPath, upsertMemory } = await import("../src/memory/store.mjs");
const { closeTrainingDatabase, exportSqliteToJson, migrateJsonToSqlite, sqlitePathFor } = await import("../src/sqlite-store.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const seedState = {
  ...defaultState(),
  tasks: [
    {
      id: "task-sqlite-eval",
      title: "SQLite eval task",
      status: "published",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
};

const seedMemory = {
  ...defaultMemoryStore(),
  memories: [
    {
      id: "mem-sqlite-eval",
      type: "preference",
      key: "marketing.length",
      scope: "boss",
      status: "active",
      text: "Prefer short marketing articles",
      value: { lengthInstruction: "short" },
      tags: ["marketing"],
      source: "eval",
      confidence: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  sessions: {
    "boss-eval": {
      summary: "SQLite memory session eval",
      updatedAt: new Date().toISOString(),
    },
  },
};

const results = [];

try {
  await writeFile(statePath, `${JSON.stringify(seedState, null, 2)}\n`, "utf8");
  await writeFile(memoryPath, `${JSON.stringify(seedMemory, null, 2)}\n`, "utf8");

  const dry = migrateJsonToSqlite({
    dataDir,
    statePath,
    memoryPath,
    defaultState,
    defaultMemoryStore,
    dryRun: true,
  });
  assert(dry.dryRun && dry.counts.tasks === 1 && dry.counts.memories === 1, "dry-run summary mismatch");
  results.push({ name: "dry run", ok: true });

  const migrated = migrateJsonToSqlite({
    dataDir,
    statePath,
    memoryPath,
    defaultState,
    defaultMemoryStore,
  });
  assert(migrated.imported.state && migrated.imported.memory, "expected state and memory import");
  assert(migrated.sqlitePath === sqlitePathFor(dataDir), "sqlite path mismatch");
  results.push({ name: "json to sqlite migration", ok: true });

  const state = await loadState();
  const memory = await loadMemoryStore();
  assert(state.tasks.some((task) => task.id === "task-sqlite-eval"), "state task missing after migration");
  assert(memory.memories.some((item) => item.id === "mem-sqlite-eval"), "memory missing after migration");
  assert(memory.sessions["boss-eval"], "memory session missing after migration");
  results.push({ name: "sqlite load equivalence", ok: true });

  await mutateState((value) => {
    value.events.push({ id: "evt-sqlite-eval", type: "eval", createdAt: new Date().toISOString(), payload: {} });
  });
  await upsertMemory({
    id: "mem-sqlite-upsert",
    type: "preference",
    key: "training.quizCount",
    scope: "boss",
    status: "active",
    text: "Default quiz count 10",
    value: { quizCount: 10 },
    source: "eval",
    confidence: 1,
  });
  const updatedState = await loadState();
  const updatedMemory = await loadMemoryStore();
  assert(updatedState.events.some((event) => event.id === "evt-sqlite-eval"), "sqlite state mutation missing");
  assert(updatedMemory.memories.some((item) => item.id === "mem-sqlite-upsert"), "sqlite memory mutation missing");
  results.push({ name: "sqlite mutations", ok: true });

  const exported = exportSqliteToJson({ dataDir, statePath, memoryPath });
  assert(exported.counts.tasks === 1 && exported.counts.memories >= 2, "export counts mismatch");
  const exportedState = JSON.parse(await readFile(statePath, "utf8"));
  const exportedMemory = JSON.parse(await readFile(memoryPath, "utf8"));
  assert(exportedState.events.some((event) => event.id === "evt-sqlite-eval"), "exported state missing event");
  assert(exportedMemory.memories.some((item) => item.id === "mem-sqlite-upsert"), "exported memory missing upsert");
  results.push({ name: "sqlite export to json", ok: true });

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
