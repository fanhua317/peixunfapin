import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-import-eval-"));
process.env.TRAINING_DATA_DIR = tempDir;
process.env.TRAINING_STORAGE = "sqlite";
process.env.TRAINING_IMPORT_MAX_UPLOAD_MB = "10";

const { closeTrainingDatabase } = await import("../src/sqlite-store.mjs");
const { loadMemoryStore, upsertMemory } = await import("../src/memory/store.mjs");
const { importFromDirectory, importUploadedFiles, getImportOverview } = await import("../src/import/service.mjs");
const { loadState, mutateState } = await import("../src/store.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  await writeFile(path.join(dir, "sales.txt"), `销售介绍时不要单一讲专业知识，要结合客户痛点、产品优势和售后服务承诺。`, "utf8");
}

function countFor(state, kbId) {
  return {
    documents: state.documents.filter((item) => item.knowledgeBaseId === kbId).length,
    chunks: state.chunks.filter((item) => item.knowledgeBaseId === kbId).length,
    parents: (state.chunkParents || []).filter((item) => item.knowledgeBaseId === kbId).length,
  };
}

const results = [];

try {
  const cleanDir = path.join(tempDir, "clean-one");
  await writeSampleCleanDir(cleanDir);
  const first = await importFromDirectory({
    inputDir: cleanDir,
    kbName: "导入评测资料库",
    aliases: "导入评测,电机评测",
    cleanMode: "direct",
  });
  assert(first.imported.kbId === "kb-导入评测资料库", "unexpected first kb id");
  assert(first.imported.fileCount === 2, "expected two imported clean files");
  assert(first.imported.parentCount > 0 && first.imported.chunkCount > 0, "expected semantic parents and chunks");
  results.push({ name: "directory direct import", ok: true, imported: first.imported });

  await mutateState((state) => {
    state.tasks.push({ id: "task-import-eval", title: "Import eval task", status: "published" });
    state.invites.push({ id: "invite-import-eval", taskId: "task-import-eval", token: "import-token" });
    state.quizzes.push({ id: "quiz-import-eval", taskId: "task-import-eval", questions: [] });
    state.attempts.push({ id: "attempt-import-eval", quizId: "quiz-import-eval", score: 100 });
  });
  await upsertMemory({
    id: "mem-import-eval",
    type: "preference",
    key: "marketing.channel",
    scope: "boss",
    status: "active",
    text: "导入评测记忆",
    value: { channel: "公众号" },
    source: "eval",
  });

  await writeSampleCleanDir(cleanDir, "v2");
  const overwrite = await importFromDirectory({
    inputDir: cleanDir,
    kbName: "导入评测资料库",
    aliases: "导入评测",
    cleanMode: "direct",
  });
  const stateAfterOverwrite = await loadState();
  const counts = countFor(stateAfterOverwrite, overwrite.imported.kbId);
  assert(counts.documents === 2, `expected overwritten docs to stay at 2, got ${counts.documents}`);
  assert(stateAfterOverwrite.tasks.some((item) => item.id === "task-import-eval"), "task should survive import overwrite");
  assert(stateAfterOverwrite.invites.some((item) => item.id === "invite-import-eval"), "invite should survive import overwrite");
  assert(stateAfterOverwrite.quizzes.some((item) => item.id === "quiz-import-eval"), "quiz should survive import overwrite");
  assert(stateAfterOverwrite.attempts.some((item) => item.id === "attempt-import-eval"), "attempt should survive import overwrite");
  const memoryAfterOverwrite = await loadMemoryStore();
  assert(memoryAfterOverwrite.memories.some((item) => item.id === "mem-import-eval"), "memory should survive import overwrite");
  results.push({ name: "overwrite preserves business state and memory", ok: true, counts });

  const upload = await importUploadedFiles({
    kbName: "上传评测资料库",
    aliases: "上传评测",
    cleanMode: "auto",
    files: [
      {
        filename: "intro.md",
        relativePath: "docs/intro.md",
        content: Buffer.from("# 上传资料\n\n定子绕组通过输入电流，在空气隙内产生旋转磁场。\n", "utf8"),
      },
      {
        filename: "models.csv",
        relativePath: "tables/models.csv",
        content: Buffer.from("系列,能效,级数,功率范围\nYE3,IE3,4,0.75-315kw\nYE4,IE4,6,0.75-250kw\n", "utf8"),
      },
    ],
  });
  assert(upload.mode === "cleaned", "csv upload should be cleaned before import");
  assert(upload.imported.fileCount >= 2, "expected upload clean files imported");
  assert(upload.imported.tableRowParentCount >= 1, "expected csv rows to become table row parents");
  assert(upload.embedCommands?.knowledgeBase?.includes(upload.imported.kbId), "expected kb-specific embed command");
  results.push({ name: "multipart-style upload import", ok: true, imported: upload.imported });

  const overview = await getImportOverview();
  assert(overview.knowledgeBases.some((kb) => kb.id === first.imported.kbId), "overview should include directory kb");
  assert(overview.knowledgeBases.some((kb) => kb.id === upload.imported.kbId), "overview should include upload kb");
  assert(overview.config.vectorRebuild === "async-job", "expected async vector rebuild config");
  results.push({ name: "import overview", ok: true, knowledgeBases: overview.knowledgeBases.length });

  console.log(JSON.stringify({ ok: true, tempDir, total: results.length, results }, null, 2));
} finally {
  closeTrainingDatabase();
  await rm(tempDir, { recursive: true, force: true });
}
