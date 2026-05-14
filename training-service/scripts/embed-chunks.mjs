import { createHash } from "node:crypto";
import { loadState } from "../src/store.mjs";
import { createEmbeddingClient, EMBEDDING_DEFAULT_MODEL } from "../src/embedding.mjs";
import { createQdrantClient, QDRANT_DEFAULT_COLLECTION } from "../src/qdrant.mjs";

const args = new Map();
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith("--")) continue;
  const [key, ...rest] = arg.slice(2).split("=");
  args.set(key, rest.length ? rest.join("=") : "true");
}

const filterKb = args.get("kb") || process.env.EMBED_KB_ID || "";
const collectionName = args.get("collection") || process.env.QDRANT_COLLECTION || QDRANT_DEFAULT_COLLECTION;
const modelName = args.get("model") || process.env.TRAINING_EMBEDDING_MODEL || EMBEDDING_DEFAULT_MODEL;
const forceAll = args.has("full") || /^1|true|yes$/i.test(process.env.EMBED_FORCE_FULL || "");
const dryRun = args.has("dry");

function pointIdFor(chunkId) {
  const hex = createHash("sha1").update(`chunk:${String(chunkId)}`, "utf8").digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function chunkHash(chunk) {
  if (chunk.contentHash) return String(chunk.contentHash);
  return createHash("sha256").update(String(chunk.content || ""), "utf8").digest("hex").slice(0, 16);
}

function chunkVersion(chunk, model) {
  return `${chunkHash(chunk)}::${model}`;
}

function buildPayload(state, chunk, model) {
  const knowledgeBase = state.knowledgeBases.find((kb) => kb.id === chunk.knowledgeBaseId);
  const document = state.documents.find((doc) => doc.id === chunk.documentId);
  return {
    chunkId: chunk.id,
    knowledgeBaseId: chunk.knowledgeBaseId,
    knowledgeBaseName: knowledgeBase?.name || "",
    documentId: chunk.documentId,
    documentTitle: document?.title || "",
    sourcePath: chunk.sourcePath || document?.sourcePath || "",
    sourceRef: chunk.sourceRef || "",
    heading: chunk.heading || "",
    sectionPath: chunk.sectionPath || [],
    page: chunk.page ?? null,
    keywords: chunk.keywords || [],
    tokenLength: chunk.tokenLength ?? (chunk.content ? chunk.content.length : 0),
    content: chunk.content || "",
    contentHash: chunkHash(chunk),
    embeddingModel: model,
    embeddedAt: new Date().toISOString(),
    embeddingVersion: chunkVersion(chunk, model),
  };
}

function chunkText(chunk) {
  const heading = chunk.heading ? `${chunk.heading}\n\n` : "";
  return `${heading}${chunk.content || ""}`.trim();
}

async function main() {
  const state = await loadState();
  const allChunks = Array.isArray(state.chunks) ? state.chunks : [];
  const chunks = filterKb ? allChunks.filter((chunk) => chunk.knowledgeBaseId === filterKb) : allChunks;
  if (!chunks.length) {
    console.log(JSON.stringify({ ok: true, message: "no chunks to embed", filterKb }, null, 2));
    return;
  }

  if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      collection: collectionName,
      model: modelName,
      totalChunks: chunks.length,
      pendingEmbed: "unknown without Qdrant check",
      filterKb,
    }, null, 2));
    return;
  }

  const embedding = createEmbeddingClient({ model: modelName });
  const qdrant = createQdrantClient();

  await qdrant.ping();
  await embedding.ping();

  const dimension = await embedding.detectDimension();
  await qdrant.ensureCollection({ name: collectionName, vectorSize: dimension });

  const existingMap = new Map();
  if (!forceAll) {
    let offset;
    const scrollFilter = filterKb
      ? { must: [{ key: "knowledgeBaseId", match: { value: filterKb } }] }
      : undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await qdrant.scrollPoints({ collection: collectionName, limit: 256, filter: scrollFilter, offset });
      const points = page?.result?.points || [];
      for (const point of points) {
        const payload = point.payload || {};
        if (payload.chunkId) {
          existingMap.set(String(payload.chunkId), payload.embeddingVersion || "");
        }
      }
      const next = page?.result?.next_page_offset;
      if (!next) break;
      offset = next;
    }
  }

  const toEmbed = [];
  for (const chunk of chunks) {
    if (!chunk.content || !chunk.content.trim()) continue;
    const targetVersion = chunkVersion(chunk, modelName);
    const currentVersion = existingMap.get(String(chunk.id));
    if (!forceAll && currentVersion === targetVersion) continue;
    toEmbed.push(chunk);
  }

  if (!toEmbed.length) {
    console.log(JSON.stringify({
      ok: true,
      collection: collectionName,
      model: modelName,
      dimension,
      totalChunks: chunks.length,
      reused: chunks.length,
      embedded: 0,
      filterKb,
    }, null, 2));
    return;
  }

  const batchSize = Number(process.env.EMBED_BATCH_SIZE || 16);
  let embeddedCount = 0;
  for (let start = 0; start < toEmbed.length; start += batchSize) {
    const batch = toEmbed.slice(start, start + batchSize);
    const vectors = await embedding.embed(batch.map((chunk) => chunkText(chunk)));
    const points = batch.map((chunk, index) => ({
      id: pointIdFor(chunk.id),
      vector: vectors[index],
      payload: buildPayload(state, chunk, modelName),
    }));
    await qdrant.upsertPoints({ collection: collectionName, points });
    embeddedCount += batch.length;
    process.stdout.write(`embedded ${embeddedCount}/${toEmbed.length}\n`);
  }

  console.log(JSON.stringify({
    ok: true,
    collection: collectionName,
    model: modelName,
    dimension,
    totalChunks: chunks.length,
    reused: chunks.length - toEmbed.length,
    embedded: embeddedCount,
    filterKb,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
