import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { EMBEDDING_DEFAULT_MODEL } from "./embedding.mjs";
import { isUsableTrainingChunk } from "./quality.mjs";
import { dataDir } from "./store.mjs";

const INDEX_VERSION = 1;

function safeModelName(model) {
  return String(model || EMBEDDING_DEFAULT_MODEL).replace(/[^a-z0-9_.-]+/gi, "-");
}

export function localVectorIndexPath(model = process.env.TRAINING_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || EMBEDDING_DEFAULT_MODEL) {
  const configured = process.env.TRAINING_LOCAL_VECTOR_INDEX_PATH || process.env.TRAINING_VECTOR_INDEX_PATH;
  if (configured) return path.resolve(configured);
  return path.join(dataDir, `vector-index-${safeModelName(model)}.json`);
}

export function chunkContentHash(chunk) {
  if (chunk?.contentHash) return String(chunk.contentHash);
  return createHash("sha256").update(String(chunk?.content || ""), "utf8").digest("hex").slice(0, 16);
}

export function chunkEmbeddingVersion(chunk, model) {
  return `${chunkContentHash(chunk)}::${model}`;
}

export async function loadLocalVectorIndex(options = {}) {
  const model = options.model || process.env.TRAINING_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || EMBEDDING_DEFAULT_MODEL;
  const filePath = options.path || localVectorIndexPath(model);
  const raw = await readFile(filePath, "utf8");
  const index = JSON.parse(raw);
  if (index.version !== INDEX_VERSION) {
    throw new Error(`Local vector index version ${index.version || "unknown"} is not supported`);
  }
  if (model && index.model && String(index.model) !== String(model)) {
    throw new Error(`Local vector index model ${index.model} does not match ${model}`);
  }
  return {
    ...index,
    path: filePath,
    chunks: Array.isArray(index.chunks) ? index.chunks : [],
  };
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function searchLocalVectorIndex(state, index, { knowledgeBaseId, vector, limit = 8 }) {
  if (!index || !Array.isArray(index.chunks) || !Array.isArray(vector)) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 20));
  const localChunks = new Map(
    (state.chunks || [])
      .filter((chunk) => (!knowledgeBaseId || chunk.knowledgeBaseId === knowledgeBaseId) && isUsableTrainingChunk(chunk))
      .map((chunk) => [String(chunk.id), chunk]),
  );
  return index.chunks
    .filter((entry) => !knowledgeBaseId || entry.knowledgeBaseId === knowledgeBaseId)
    .map((entry) => {
      const chunk = localChunks.get(String(entry.chunkId));
      if (!chunk) return null;
      const currentVersion = chunkEmbeddingVersion(chunk, index.model);
      if (entry.embeddingVersion && entry.embeddingVersion !== currentVersion) return null;
      const semanticScore = cosineSimilarity(vector, entry.vector);
      if (!Number.isFinite(semanticScore) || semanticScore <= 0) return null;
      return {
        ...chunk,
        chunkId: chunk.id,
        semanticScore,
        retrieval: "local-vector",
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.semanticScore - left.semanticScore)
    .slice(0, safeLimit);
}

export async function getLocalVectorIndexStatus(state, knowledgeBaseId, options = {}) {
  const model = options.model || process.env.TRAINING_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || EMBEDDING_DEFAULT_MODEL;
  const filePath = options.path || localVectorIndexPath(model);
  const checkedAt = new Date().toISOString();
  try {
    const info = await stat(filePath);
    const index = await loadLocalVectorIndex({ model, path: filePath });
    const usableChunkIds = new Set(
      (state.chunks || [])
        .filter((chunk) => (!knowledgeBaseId || chunk.knowledgeBaseId === knowledgeBaseId) && isUsableTrainingChunk(chunk))
        .map((chunk) => String(chunk.id)),
    );
    const indexedChunkIds = new Set(
      index.chunks
        .filter((entry) => !knowledgeBaseId || entry.knowledgeBaseId === knowledgeBaseId)
        .map((entry) => String(entry.chunkId)),
    );
    const indexedChunks = [...usableChunkIds].filter((id) => indexedChunkIds.has(id)).length;
    const missingVectorChunks = Math.max(0, usableChunkIds.size - indexedChunks);
    return {
      status: missingVectorChunks === 0 && usableChunkIds.size > 0 ? "ready" : indexedChunks > 0 ? "partial" : "empty",
      backend: "local",
      path: filePath,
      model: index.model || model,
      dimension: index.dimension || null,
      indexedChunks,
      missingVectorChunks,
      totalUsableChunks: usableChunkIds.size,
      updatedAt: index.updatedAt || info.mtime.toISOString(),
      checkedAt,
      message: missingVectorChunks === 0 ? "Local vector index is ready" : "Local vector index needs rebuild",
    };
  } catch (error) {
    return {
      status: "unavailable",
      backend: "local",
      path: filePath,
      model,
      indexedChunks: 0,
      missingVectorChunks: null,
      totalUsableChunks: null,
      checkedAt,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export { INDEX_VERSION as LOCAL_VECTOR_INDEX_VERSION };
