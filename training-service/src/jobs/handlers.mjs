import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { restoreKnowledgeBaseVersion } from "../knowledge-base-versions.mjs";
import { importPreparedDirectory, runExclusiveImport } from "../import/service.mjs";
import { buildLocalVectorIndex, localVectorBuildDefaults } from "../local-vector-build.mjs";
import { dataDir } from "../store.mjs";

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function parseAliases(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function assertDirectory(dir) {
  const resolved = path.resolve(dir || "");
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`${resolved} 不是目录`);
  return resolved;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error("任务已取消");
    error.code = "JOB_CANCELLED";
    throw error;
  }
}

function importSummary(imported = {}) {
  return {
    kbId: imported.kbId || "",
    kbName: imported.kbName || "",
    fileCount: imported.fileCount || 0,
    parentCount: imported.parentCount || 0,
    chunkCount: imported.chunkCount || 0,
    tableRowParentCount: imported.tableRowParentCount || 0,
    maxChildChars: imported.maxChildChars || 0,
    versionId: imported.versionId || imported.version?.current?.id || "",
    versionNo: imported.versionNo || imported.version?.current?.versionNo || 0,
    diffSummary: imported.diffSummary || imported.version?.diffSummary || null,
  };
}

async function runImportJob(job, context) {
  const input = job.input || {};
  const sourceDir = await assertDirectory(input.sourceDir || input.inputDir);
  const stagingDir = input.stagingDir || path.join(dataDir, "imports", `${job.type}-${timestampId()}-${job.id}`);
  await mkdir(stagingDir, { recursive: true });
  throwIfCancelled(context.signal);
  const result = await runExclusiveImport(job.type, async () => await importPreparedDirectory({
    sourceDir,
    kbName: input.kbName || path.basename(sourceDir),
    aliases: parseAliases(input.aliases),
    cleanMode: input.cleanMode || "auto",
    stagingDir,
    signal: context.signal,
    onProgress: context.progress,
  }));
  const summary = importSummary(result.imported);
  if (input.autoEmbed !== false && summary.kbId) {
    const child = await context.enqueueChild({
      type: "embed_local",
      title: `重建向量索引：${summary.kbName || summary.kbId}`,
      input: {
        kbId: summary.kbId,
        model: input.embeddingModel || "",
        full: false,
      },
      inputSummary: {
        kbId: summary.kbId,
        kbName: summary.kbName,
        model: input.embeddingModel || "默认模型",
      },
    });
    result.embeddingJobId = child.id;
    summary.embeddingJobId = child.id;
  }
  return { result, resultSummary: summary };
}

async function runRollbackKnowledgeBaseJob(job, context) {
  const input = job.input || {};
  const kbId = String(input.kbId || input.knowledgeBaseId || "").trim();
  const versionId = String(input.versionId || "").trim();
  if (!kbId || !versionId) throw new Error("Missing kbId or versionId for rollback.");
  throwIfCancelled(context.signal);
  await context.progress({
    percent: 18,
    stage: "prepare",
    label: "准备回滚知识库",
    detail: kbId,
  });
  const result = await restoreKnowledgeBaseVersion({ knowledgeBaseId: kbId, versionId, jobId: job.id });
  throwIfCancelled(context.signal);
  await context.progress({
    percent: 72,
    stage: "restored",
    label: "知识库已回滚",
    detail: result.current?.summary?.kbName || kbId,
  });
  const summary = {
    kbId,
    kbName: result.current?.summary?.kbName || "",
    restoredFromVersionId: result.restoredFrom?.id || versionId,
    versionId: result.current?.id || "",
    versionNo: result.current?.versionNo || 0,
    diffSummary: result.diffSummary || null,
  };
  if (input.autoEmbed !== false) {
    const child = await context.enqueueChild({
      type: "embed_local",
      title: `重建向量索引：${summary.kbName || kbId}`,
      input: {
        kbId,
        model: input.embeddingModel || "",
        full: false,
      },
      inputSummary: {
        kbId,
        kbName: summary.kbName,
        model: input.embeddingModel || "默认模型",
      },
    });
    result.embeddingJobId = child.id;
    summary.embeddingJobId = child.id;
  }
  return { result, resultSummary: summary };
}

async function runEmbedLocalJob(job, context) {
  const input = job.input || {};
  const defaults = localVectorBuildDefaults({
    kbId: input.kbId || input.knowledgeBaseId || "",
    model: input.model || "",
    full: input.full === true,
    forceAll: input.full === true || input.forceAll === true,
    outputPath: input.outputPath || "",
  });
  const result = await buildLocalVectorIndex({
    ...defaults,
    signal: context.signal,
    onProgress: context.progress,
  });
  return {
    result,
    resultSummary: {
      kbId: result.filterKb || "",
      model: result.model,
      totalChunks: result.totalChunks || 0,
      reused: result.reused || 0,
      embedded: result.embedded || 0,
      outputPath: result.outputPath,
    },
  };
}

const handlers = {
  import_directory: runImportJob,
  import_upload: runImportJob,
  rollback_knowledge_base: runRollbackKnowledgeBaseJob,
  embed_local: runEmbedLocalJob,
};

export function getJobHandler(type) {
  return handlers[type] || null;
}

export const supportedJobTypes = Object.keys(handlers);
