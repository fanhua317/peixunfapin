import { EMBEDDING_DEFAULT_BASE_URL, EMBEDDING_DEFAULT_MODEL } from "./embedding.mjs";
import { getOpenClawRuntimeStatus } from "./gateway/index.mjs";
import { getLlmRuntimeConfig } from "./llm.mjs";
import { getLocalVectorIndexStatus } from "./local-vector-index.mjs";
import { QDRANT_DEFAULT_BASE_URL, QDRANT_DEFAULT_COLLECTION } from "./qdrant.mjs";
import { isUsableTrainingChunk } from "./quality.mjs";
import { checkRerankerRuntime } from "./reranker.mjs";

const DEFAULT_TIMEOUT_MS = Number(process.env.TRAINING_HEALTH_TIMEOUT_MS || 1500);

function buildUrl(baseUrl, pathname) {
  const trimmed = String(baseUrl || "").replace(/\/$/, "");
  return `${trimmed}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function authHeaders() {
  const key = process.env.QDRANT_API_KEY || "";
  return key ? { "api-key": key } : {};
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json", ...headers } });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const detail = payload?.status?.error || payload?.error || text || response.statusText;
      throw new Error(detail);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkQdrantRuntime() {
  const baseUrl = process.env.QDRANT_URL || QDRANT_DEFAULT_BASE_URL;
  const collection = process.env.QDRANT_COLLECTION || QDRANT_DEFAULT_COLLECTION;
  try {
    await fetchJson(buildUrl(baseUrl, "/"), { headers: authHeaders() });
    let collectionExists = false;
    try {
      await fetchJson(buildUrl(baseUrl, `/collections/${encodeURIComponent(collection)}`), { headers: authHeaders() });
      collectionExists = true;
    } catch (error) {
      if (!/not found|404/i.test(error.message || "")) throw error;
    }
    return {
      ok: true,
      baseUrl,
      collection,
      collectionExists,
      status: collectionExists ? "ready" : "missing_collection",
    };
  } catch (error) {
    return {
      ok: false,
      baseUrl,
      collection,
      collectionExists: false,
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkOllamaRuntime() {
  const baseUrl = process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL || EMBEDDING_DEFAULT_BASE_URL;
  const model = process.env.TRAINING_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || EMBEDDING_DEFAULT_MODEL;
  try {
    const payload = await fetchJson(buildUrl(baseUrl, "/api/tags"));
    const models = Array.isArray(payload?.models) ? payload.models.map((entry) => entry.name || entry.model).filter(Boolean) : [];
    return {
      ok: true,
      baseUrl,
      model,
      modelAvailable: models.some((name) => String(name).split(":")[0] === model || String(name) === model),
      models,
      status: "ready",
    };
  } catch (error) {
    return {
      ok: false,
      baseUrl,
      model,
      modelAvailable: false,
      models: [],
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getRuntimeHealth(state = { chunks: [] }) {
  const [qdrant, ollama, openclawRuntime, reranker] = await Promise.all([
    checkQdrantRuntime(),
    checkOllamaRuntime(),
    getOpenClawRuntimeStatus(),
    checkRerankerRuntime(),
  ]);
  const localVectorIndex = await getLocalVectorIndexStatus(state || { chunks: [] });
  const hybridConfigured = !["0", "false", "off", "no"].includes(String(process.env.TRAINING_HYBRID_RETRIEVAL || "").toLowerCase());
  const localVectorReady = ["ready", "partial"].includes(localVectorIndex.status);
  const qdrantReady = qdrant.ok && qdrant.collectionExists;
  const semanticReady = hybridConfigured && ollama.ok && (qdrantReady || localVectorReady);
  const retrievalMode = semanticReady ? (reranker.ok ? "hybrid+reranker" : "hybrid") : "bm25";
  const llm = {
    ...getLlmRuntimeConfig(),
    openclawRuntime,
  };
  return {
    qdrant,
    ollama,
    localVectorIndex,
    llm,
    reranker,
    qdrantOk: qdrant.ok,
    ollamaOk: ollama.ok,
    localVectorIndexOk: localVectorReady,
    openclawRuntimeOk: openclawRuntime.ok,
    llmProvider: llm.effectiveProvider,
    llmConfigured: llm.effectiveProvider === "openclaw" ? openclawRuntime.ok : llm.directConfigured,
    rerankerOk: reranker.ok,
    retrievalMode,
    hybridConfigured,
    checkedAt: new Date().toISOString(),
  };
}

export async function getVectorIndexStatus(state, knowledgeBaseId, runtime) {
  const qdrant = runtime?.qdrant || await checkQdrantRuntime();
  const localVectorIndex = runtime?.localVectorIndex || await getLocalVectorIndexStatus(state, knowledgeBaseId);
  const collection = qdrant.collection || process.env.QDRANT_COLLECTION || QDRANT_DEFAULT_COLLECTION;
  const checkedAt = new Date().toISOString();
  if (!qdrant.ok) {
    if (["ready", "partial"].includes(localVectorIndex.status)) {
      return {
        status: localVectorIndex.status,
        backend: "local",
        collection: localVectorIndex.path,
        checkedAt,
        indexedChunks: localVectorIndex.indexedChunks,
        missingVectorChunks: localVectorIndex.missingVectorChunks,
        message: localVectorIndex.message,
      };
    }
    return { status: "unavailable", collection, checkedAt, message: qdrant.error || localVectorIndex.message || "Vector index unavailable" };
  }
  if (!qdrant.collectionExists) {
    return { status: "missing_collection", collection, checkedAt, message: "Qdrant collection does not exist" };
  }

  const usableChunkIds = new Set(
    state.chunks
      .filter((chunk) => chunk.knowledgeBaseId === knowledgeBaseId && isUsableTrainingChunk(chunk))
      .map((chunk) => String(chunk.id)),
  );
  const indexed = new Set();
  let offset;
  try {
    for (let page = 0; page < 20; page += 1) {
      const body = {
        limit: 256,
        with_payload: true,
        filter: { must: [{ key: "knowledgeBaseId", match: { value: String(knowledgeBaseId) } }] },
        ...(offset !== undefined ? { offset } : {}),
      };
      const payload = await fetch(buildUrl(qdrant.baseUrl, `/collections/${encodeURIComponent(collection)}/points/scroll`), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...authHeaders() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      }).then(async (response) => {
        const text = await response.text();
        const value = text ? JSON.parse(text) : null;
        if (!response.ok) throw new Error(value?.status?.error || value?.error || text || response.statusText);
        return value;
      });
      const points = payload?.result?.points || [];
      for (const point of points) {
        const chunkId = point?.payload?.chunkId;
        if (chunkId) indexed.add(String(chunkId));
      }
      offset = payload?.result?.next_page_offset;
      if (!offset) break;
    }
  } catch (error) {
    return {
      status: "unavailable",
      collection,
      checkedAt,
      indexedChunks: indexed.size,
      missingVectorChunks: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const missingVectorChunks = [...usableChunkIds].filter((chunkId) => !indexed.has(chunkId)).length;
  return {
    status: missingVectorChunks === 0 ? "ready" : "partial",
    collection,
    checkedAt,
    indexedChunks: indexed.size,
    missingVectorChunks,
    message: missingVectorChunks === 0 ? "All usable chunks indexed" : "Some usable chunks are not indexed",
  };
}
