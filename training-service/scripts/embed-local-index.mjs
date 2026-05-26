import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadState } from "../src/store.mjs";
import { createEmbeddingClient, EMBEDDING_DEFAULT_MODEL } from "../src/embedding.mjs";
import { isUsableTrainingChunk } from "../src/quality.mjs";
import {
  chunkEmbeddingVersion,
  localVectorIndexPath,
  LOCAL_VECTOR_INDEX_VERSION,
} from "../src/local-vector-index.mjs";

const args = new Map();
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith("--")) continue;
  const [key, ...rest] = arg.slice(2).split("=");
  args.set(key, rest.length ? rest.join("=") : "true");
}

const filterKb = args.get("kb") || process.env.EMBED_KB_ID || "";
const modelName = args.get("model") || process.env.TRAINING_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || EMBEDDING_DEFAULT_MODEL;
const outputPath = path.resolve(args.get("out") || process.env.TRAINING_LOCAL_VECTOR_INDEX_PATH || localVectorIndexPath(modelName));
const forceAll = args.has("full") || /^1|true|yes$/i.test(process.env.EMBED_FORCE_FULL || "");
const dryRun = args.has("dry");

function chunkText(chunk) {
  const heading = chunk.heading ? `${chunk.heading}\n\n` : "";
  return `${heading}${chunk.searchText || chunk.content || ""}`.trim();
}

async function readExistingIndex(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const index = JSON.parse(raw);
    if (index.version !== LOCAL_VECTOR_INDEX_VERSION || index.model !== modelName) return new Map();
    return new Map((index.chunks || []).map((entry) => [String(entry.chunkId), entry]));
  } catch {
    return new Map();
  }
}

function buildEntry(chunk, vector) {
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

async function main() {
  const state = await loadState();
  const chunks = (state.chunks || [])
    .filter((chunk) => !filterKb || chunk.knowledgeBaseId === filterKb)
    .filter(isUsableTrainingChunk);

  if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      outputPath,
      model: modelName,
      usableChunks: chunks.length,
      filterKb,
    }, null, 2));
    return;
  }

  const existing = forceAll ? new Map() : await readExistingIndex(outputPath);
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

  const embedding = createEmbeddingClient({ model: modelName });
  await embedding.ping();
  const batchSize = Number(process.env.EMBED_BATCH_SIZE || process.env.EMBEDDING_BATCH_SIZE || 16);
  let dimension = entries.find((entry) => Array.isArray(entry.vector))?.vector?.length || null;
  let embedded = 0;
  for (let start = 0; start < toEmbed.length; start += batchSize) {
    const batch = toEmbed.slice(start, start + batchSize);
    const vectors = await embedding.embed(batch.map(chunkText));
    for (let index = 0; index < batch.length; index += 1) {
      const vector = vectors[index];
      if (!dimension && Array.isArray(vector)) dimension = vector.length;
      entries.push(buildEntry(batch[index], vector));
    }
    embedded += batch.length;
    process.stdout.write(`embedded ${embedded}/${toEmbed.length}\n`);
  }

  const now = new Date().toISOString();
  const payload = {
    version: LOCAL_VECTOR_INDEX_VERSION,
    model: modelName,
    dimension,
    createdAt: now,
    updatedAt: now,
    filterKb,
    totalChunks: chunks.length,
    chunks: entries.sort((left, right) => String(left.chunkId).localeCompare(String(right.chunkId))),
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
  await rename(tempPath, outputPath);
  console.log(JSON.stringify({
    ok: true,
    outputPath,
    model: modelName,
    dimension,
    totalChunks: chunks.length,
    reused,
    embedded: toEmbed.length,
    filterKb,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
