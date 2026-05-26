import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-memory-eval-"));
process.env.TRAINING_DATA_DIR = tempDir;

const { createTaskDraft } = await import("../src/domain/drafts.mjs");
const { verifyIntentConfirmationToken } = await import("../src/intent-confirmation.mjs");
const { extractMemoryCandidates } = await import("../src/memory/extractor.mjs");
const { processMemoryInstruction } = await import("../src/memory/flow.mjs");
const {
  buildMemoryContext,
  clearMemories,
  deleteMemory,
  listMemoryItems,
  marketingPreferencesFromMemory,
  trainingDefaultsFromMemory,
  updateMemory,
} = await import("../src/memory/index.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const state = {
  knowledgeBases: [
    {
      id: "kb-motor",
      name: "电机培训资料库",
      aliases: ["电机", "电机培训"],
      status: "ready",
    },
  ],
  documents: [],
  chunks: [],
  chunkParents: [],
  employees: [
    {
      id: "emp-wang-xiaoming",
      name: "王小明",
      department: "销售部",
      role: "销售",
      status: "active",
    },
  ],
};

const results = [];

try {
  const marketingSave = await processMemoryInstruction("以后软文默认短一点，偏公众号", {
    sessionId: "boss-a",
    memoryMode: "auto",
  });
  assert(marketingSave.action === "memory_saved", "expected marketing memory to save directly");
  assert((marketingSave.memory?.saved || []).some((item) => item.key === "marketing.length"), "expected marketing length memory");
  assert((marketingSave.memory?.saved || []).some((item) => item.key === "marketing.channel"), "expected marketing channel memory");
  results.push({ name: "explicit marketing preference", ok: true });

  const marketingContext = await buildMemoryContext({
    sessionId: "boss-b",
    message: "写一篇电机软文",
    memoryMode: "auto",
  });
  const marketingPrefs = marketingPreferencesFromMemory("写一篇电机软文", marketingContext);
  assert(marketingPrefs.lengthInstruction === "300-600字", "expected remembered short article length");
  assert(marketingPrefs.channel === "公众号", "expected remembered article channel");
  const overridePrefs = marketingPreferencesFromMemory("写一篇电机软文，这次写长一点", marketingContext);
  assert(!overridePrefs.lengthInstruction, "current explicit length should override memory default");
  results.push({ name: "marketing recall and override", ok: true });

  const trainingSave = await processMemoryInstruction("以后培训默认 10 道题 80 分", {
    sessionId: "boss-a",
    memoryMode: "auto",
  });
  assert(trainingSave.action === "memory_saved", "expected training memory to save directly");
  const trainingContext = await buildMemoryContext({
    sessionId: "boss-c",
    message: "给王小明发布电机培训",
    memoryMode: "auto",
  });
  const trainingDefaults = trainingDefaultsFromMemory(trainingContext);
  const draft = createTaskDraft(state, "给王小明发布电机培训", { memoryDefaults: trainingDefaults });
  assert(draft.quizCount === 10, `expected remembered quiz count 10, got ${draft.quizCount}`);
  assert(draft.passScore === 80, `expected remembered pass score 80, got ${draft.passScore}`);
  results.push({ name: "training defaults", ok: true });

  assert(extractMemoryCandidates("记住 sk-1234567890abcdef 是我的 API Key").length === 0, "API key should not become memory");
  assert(extractMemoryCandidates("以后删除所有培训记录").length === 0, "delete operation should not become memory");
  results.push({ name: "sensitive and high-risk blocklist", ok: true });

  const pending = await processMemoryInstruction("我喜欢软文自然一点", {
    sessionId: "boss-a",
    memoryMode: "auto",
  });
  assert(pending.action === "memory_confirm", "implicit preference should require confirmation");
  const candidate = pending.memory?.candidates?.[0];
  assert(candidate?.memory?.id && candidate?.token, "pending memory should include confirmation token");
  const verification = verifyIntentConfirmationToken(candidate.token, {
    message: candidate.memory.id,
    skill: "confirm_memory",
  });
  assert(verification.ok, "pending memory confirmation token should verify");
  await updateMemory(candidate.memory.id, { status: "active" });
  results.push({ name: "pending confirmation token", ok: true });

  const list = await listMemoryItems();
  assert(list.length >= 4, "expected memory list to include saved items");
  const deleted = await deleteMemory(candidate.memory.id);
  assert(deleted === 1, "expected one memory deleted");
  const cleared = await clearMemories();
  assert(cleared.deleted >= 3, "expected remaining memories cleared");
  results.push({ name: "list delete clear", ok: true });

  console.log(JSON.stringify({
    ok: true,
    total: results.length,
    results,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    results,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
