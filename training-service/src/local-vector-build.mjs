import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEmbeddingClient, EMBEDDING_DEFAULT_MODEL } from "./embedding.mjs";
import { isUsableTrainingChunk } from "./quality.mjs";
import { loadState } from "./store.mjs";
import {
  chunkEmbeddingVersion,
  localVectorIndexPath,
  LOCAL_VECTOR_INDEX_VERSION,
} from "./local-vector-index.mjs";

function chunkText(chunk) {
  const heading = chunk.heading ? `${chunk.heading}\n\n` : "";
  return `${heading}${chunk.searchText || chunk.content || ""}`.trim();
}

async function readExistingIndex(filePath, modelName) {
  try {
    const raw = await readFile(filePath, "utf8");
    const index = JSON.parse(raw);
    if (index.version !== LOCAL_VECTOR_INDEX_VERSION || index.model !== modelName) return new Map();
    return new Map((index.chunks || []).map((entry) => [String(entry.chunkId), entry]));
  } catch {
    return new Map();
  }
}

function buildEntry(chunk, vector, modelName) {
  return {
    chunkId: chunk.id,
    knowledgeBaseId: chunk.knowledgeBaseId,
    documentId: chunk.documentId,
    sourcePath: chunk.sourcePath || "",
    sourceRef: chunk.sourceRef || "",
    parentId: chunk.parentId || null,
    childType: chunk.childType || "",
    contentHash: chunk.contentHash || "",
    embeddingVersion: chunkEmbeddingVersion(chunk, modelName),
    vector,
  };
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error("任务已取消");
    error.code = "JOB_CANCELLED";
    throw error;
  }
}

export function localVectorBuildDefaults(options = {}) {
  const modelName = options.model || process.env.TRAINING_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || EMBEDDING_DEFAULT_MODEL;
  return {
    knowledgeBaseId: options.knowledgeBaseId || options.kbId || "",
    modelName,
    outputPath: path.resolve(options.outputPath || process.env.TRAINING_LOCAL_VECTOR_INDEX_PATH || localVectorIndexPath(modelName)),
    forceAll: options.forceAll === true || options.full === true,
    dryRun: options.dryRun === true,
  };
}

export async function buildLocalVectorIndex(options = {}) {
  const {
    knowledgeBaseId,
    modelName,
    outputPath,
    forceAll,
    dryRun,
  } = localVectorBuildDefaults(options);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : async () => {};
  const signal = options.signal;
  throwIfCancelled(signal);

  const state = await loadState();
  const chunks = (state.chunks || [])
    .filter((chunk) => !knowledgeBaseId || chunk.knowledgeBaseId === knowledgeBaseId)
    .filter(isUsableTrainingChunk);

  await onProgress({
    percent: 8,
    stage: "scan",
    label: "扫描可用子块",
    detail: `${chunks.length} 个可向量化子块`,
  });

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      outputPath,
      model: modelName,
      usableChunks: chunks.length,
      filterKb: knowledgeBaseId,
    };
  }

  throwIfCancelled(signal);
  const existing = forceAll ? new Map() : await readExistingIndex(outputPath, modelName);
  const entries = [];
  const toEmbed = [];
  let reused = 0;
  for (const chunk of chunks) {
    const existingEntry = existing.get(String(chunk.id));
    if (existingEntry?.embeddingVersion === chunkEmbeddingVersion(chunk, modelName) && Array.isArray(existingEntry.vector)) {
      entries.push(existingEntry);
      reused += 1;
    } else {
      toEmbed.push(chunk);
    }
  }

  await onProgress({
    percent: 18,
    stage: "prepare",
    label: "准备向量化",
    detail: `复用 ${reused} 个，新增 ${toEmbed.length} 个`,
  });

  const embedding = createEmbeddingClient({ model: modelName });
  await embedding.ping();
  const batchSize = Number(process.env.EMBED_BATCH_SIZE || process.env.EMBEDDING_BATCH_SIZE || 16);
  let dimension = entries.find((entry) => Array.isArray(entry.vector))?.vector?.length || null;
  let embedded = 0;
  for (let start = 0; start < toEmbed.length; start += batchSize) {
    throwIfCancelled(signal);
    const batch = toEmbed.slice(start, start + batchSize);
    const vectors = await embedding.embed(batch.map(chunkText));
    for (let index = 0; index < batch.length; index += 1) {
      const vector = vectors[index];
      if (!dimension && Array.isArray(vector)) dimension = vector.length;
      entries.push(buildEntry(batch[index], vector, modelName));
    }
    embedded += batch.length;
    const embedPercent = toEmbed.length ? Math.round(18 + (embedded / toEmbed.length) * 72) : 90;
    await onProgress({
      percent: embedPercent,
      stage: "embedding",
      label: "生成本地向量索引",
      detail: `${embedded}/${toEmbed.length}`,
    });
  }

  throwIfCancelled(signal);
  const now = new Date().toISOString();
  const payload = {
    version: LOCAL_VECTOR_INDEX_VERSION,
    model: modelName,
    dimension,
    createdAt: now,
    updatedAt: now,
    filterKb: knowledgeBaseId,
    totalChunks: chunks.length,
    chunks: entries.sort((left, right) => String(left.chunkId).localeCompare(String(right.chunkId))),
  };

  await onProgress({
    percent: 94,
    stage: "write",
    label: "写入索引文件",
    detail: outputPath,
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
  await rename(tempPath, outputPath);

  await onProgress({
    percent: 100,
    stage: "done",
    label: "向量索引已完成",
    detail: `${entries.length} 个索引项`,
  });

  return {
    ok: true,
    outputPath,
    model: modelName,
    dimension,
    totalChunks: chunks.length,
    reused,
    embedded: toEmbed.length,
    filterKb: knowledgeBaseId,
  };
}
