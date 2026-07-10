import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-import-lifecycle-"));
process.env.TRAINING_DATA_DIR = path.join(tempDir, "data");
process.env.TRAINING_STORAGE = "json";
process.env.TRAINING_AUTH_DISABLED = "1";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const service = await import("../src/import/service.mjs");
const { getJobHandler } = await import("../src/jobs/handlers.mjs");
const sourceDir = path.join(tempDir, "user-source");
await mkdir(sourceDir, { recursive: true });
await writeFile(path.join(sourceDir, "guide.md"), "# Guide\n\nThis source directory must never be deleted.\n", "utf8");

try {
  const stagingDirs = await Promise.all(Array.from({ length: 20 }, () => service.createImportStagingDir("parallel")));
  assert(new Set(stagingDirs).size === stagingDirs.length, "staging directories collided");
  await Promise.all(stagingDirs.map((dir) => service.removeImportStagingDir(dir)));

  const traversalDir = await service.createImportStagingDir("traversal");
  try {
    const staged = await service.stageUploadedFiles({
      stagingDir: traversalDir,
      files: [{ filename: "escape.md", relativePath: "../../outside.md", content: Buffer.from("safe") }],
    });
    assert((await readdir(staged.uploadDir)).includes("outside.md"), "sanitized upload missing");
    assert(!(await exists(path.join(path.dirname(traversalDir), "outside.md"))), "upload escaped staging boundary");
  } finally {
    await service.removeImportStagingDir(traversalDir);
  }

  await service.importFromDirectory({ inputDir: sourceDir, kbName: "生命周期成功", cleanMode: "direct" });
  assert(await exists(sourceDir), "successful import deleted user source directory");

  let failed = false;
  try {
    await service.importUploadedFiles({
      kbName: "生命周期失败",
      files: [{ filename: "bad.exe", content: Buffer.from("bad") }],
    });
  } catch {
    failed = true;
  }
  assert(failed, "unsupported upload should fail");

  const cancelledStaging = await service.createImportStagingDir("cancelled");
  const controller = new AbortController();
  controller.abort();
  const handler = getJobHandler("import_upload");
  try {
    await handler({ id: "job-cancel", type: "import_upload", input: { sourceDir, stagingDir: cancelledStaging, stagingOwned: true } }, {
      signal: controller.signal,
      progress: async () => {},
      enqueueChild: async () => { throw new Error("unexpected child"); },
    });
  } catch (error) {
    assert(error.code === "JOB_CANCELLED", "cancelled job returned wrong error");
  }
  assert(!(await exists(cancelledStaging)), "cancelled job left staging directory behind");
  assert(await exists(sourceDir), "cancelled job deleted user source directory");

  const importsRoot = path.join(process.env.TRAINING_DATA_DIR, "imports");
  const leftovers = await readdir(importsRoot).catch(() => []);
  assert(leftovers.length === 0, `staging leftovers remain: ${leftovers.join(", ")}`);
  console.log(JSON.stringify({ ok: true, uniqueStagingDirs: stagingDirs.length, sourcePreserved: true, leftovers: 0 }, null, 2));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
