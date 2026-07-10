import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const workerMode = process.argv.find((arg) => arg.startsWith("--worker="))?.split("=")[1];
if (workerMode) {
  const tempDir = process.env.TRAINING_DATA_DIR;
  process.env.TRAINING_STORAGE = workerMode;
  process.env.TRAINING_AUTH_DISABLED = "1";
  const { closeTrainingDatabase } = await import("../src/sqlite-store.mjs");
  const { appendBossChatMessages, getBossChatSession } = await import("../src/boss-chat/store.mjs");
  const { commitQuiz } = await import("../src/domain/quizzes.mjs");
  const { defaultMemoryStore, mutateMemoryStore, saveMemoryStore } = await import("../src/memory/store.mjs");
  const { defaultState, loadState, mutateState, saveState } = await import("../src/store.mjs");

  const state = defaultState();
  state.tasks.push({ id: "task-concurrency", knowledgeBaseId: "kb-test", quizCount: 1, passScore: 80, createdAt: new Date().toISOString() });
  await saveState(state);
  await saveMemoryStore(defaultMemoryStore());

  await Promise.all([
    mutateState(async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      value.events.push({ id: "event-slow", type: "test", createdAt: new Date().toISOString() });
    }),
    mutateState(async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      value.events.push({ id: "event-fast", type: "test", createdAt: new Date().toISOString() });
    }),
  ]);

  await Promise.all(Array.from({ length: 12 }, (_, index) => mutateMemoryStore(async (store) => {
    if (index % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 3));
    store.memories.push({ id: `memory-${index}`, key: `test.${index}`, text: `memory ${index}`, status: "active" });
  })));

  await Promise.all(Array.from({ length: 10 }, (_, index) => appendBossChatMessages("parallel-session", [{
    id: `message-${index}`,
    role: index % 2 ? "assistant" : "user",
    content: `message ${index}`,
  }])));

  const prepared = (id) => ({
    quiz: {
      id,
      taskId: "task-concurrency",
      questions: [{ id: `${id}-question`, prompt: "test", options: ["A"], correctAnswer: "A" }],
      createdAt: new Date().toISOString(),
    },
    taskRevision: JSON.stringify(["task-concurrency", "kb-test", 1, 80, state.tasks[0].createdAt]),
  });
  await Promise.all([
    mutateState((value) => commitQuiz(value, prepared("quiz-a"))),
    mutateState((value) => commitQuiz(value, prepared("quiz-b"))),
  ]);

  const finalState = await loadState();
  const memory = await import("../src/memory/store.mjs").then((module) => module.loadMemoryStore());
  const chat = await getBossChatSession("parallel-session");
  assert(finalState.events.some((event) => event.id === "event-slow"), `${workerMode}: slow state mutation lost`);
  assert(finalState.events.some((event) => event.id === "event-fast"), `${workerMode}: fast state mutation lost`);
  assert(memory.memories.length === 12, `${workerMode}: memory mutation lost`);
  assert(chat?.messages.length === 10, `${workerMode}: boss chat mutation lost`);
  assert(finalState.quizzes.filter((quiz) => quiz.taskId === "task-concurrency").length === 1, `${workerMode}: duplicate quiz committed`);
  closeTrainingDatabase(tempDir);
  console.log(JSON.stringify({ mode: workerMode, events: finalState.events.length, memories: memory.memories.length, messages: chat.messages.length, quizzes: finalState.quizzes.length }));
  process.exit(0);
}

const results = [];
for (const mode of ["json", "sqlite"]) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `juzhou-concurrency-${mode}-`));
  try {
    const run = spawnSync(process.execPath, [process.argv[1], `--worker=${mode}`], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, TRAINING_DATA_DIR: tempDir },
      encoding: "utf8",
    });
    if (run.status !== 0) throw new Error(run.stderr || run.stdout || `${mode} worker failed`);
    results.push(JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
