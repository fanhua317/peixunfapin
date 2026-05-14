const DEFAULT_BASE_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const DEFAULT_API_KEY = process.env.QDRANT_API_KEY || "";
const DEFAULT_COLLECTION = process.env.QDRANT_COLLECTION || "training_chunks_bge_m3";
const DEFAULT_VECTOR_DISTANCE = process.env.QDRANT_VECTOR_DISTANCE || "Cosine";
const DEFAULT_TIMEOUT_MS = Number(process.env.QDRANT_TIMEOUT_MS || 30_000);

function buildUrl(baseUrl, path) {
  const trimmed = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${trimmed}${suffix}`;
}

function authHeaders(apiKey) {
  const key = apiKey || DEFAULT_API_KEY;
  return key ? { "api-key": key } : {};
}

async function request({ baseUrl, apiKey, method, path, body, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(buildUrl(baseUrl, path), {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...authHeaders(apiKey),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const detail = payload?.status?.error || payload?.error || text || response.statusText;
      throw new Error(`Qdrant ${method} ${path} failed: ${detail}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export function createQdrantClient(options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const apiKey = options.apiKey || DEFAULT_API_KEY;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return {
    baseUrl,
    timeoutMs,
    async ping() {
      return await request({ baseUrl, apiKey, timeoutMs, method: "GET", path: "/" });
    },
    async listCollections() {
      return await request({ baseUrl, apiKey, timeoutMs, method: "GET", path: "/collections" });
    },
    async getCollection(name) {
      try {
        return await request({ baseUrl, apiKey, timeoutMs, method: "GET", path: `/collections/${encodeURIComponent(name)}` });
      } catch (error) {
        if (/not found|404/i.test(error.message || "")) return null;
        throw error;
      }
    },
    async ensureCollection({ name, vectorSize, distance = DEFAULT_VECTOR_DISTANCE }) {
      const existing = await this.getCollection(name);
      if (existing) {
        const size = existing.result?.config?.params?.vectors?.size
          ?? existing.result?.config?.params?.vectors?.default?.size
          ?? null;
        if (size && Number(size) !== Number(vectorSize)) {
          throw new Error(`Qdrant collection ${name} exists with vector size ${size}, expected ${vectorSize}`);
        }
        return existing;
      }
      return await request({
        baseUrl,
        apiKey,
        timeoutMs,
        method: "PUT",
        path: `/collections/${encodeURIComponent(name)}`,
        body: {
          vectors: {
            size: Number(vectorSize),
            distance,
          },
        },
      });
    },
    async upsertPoints({ collection, points, wait = true }) {
      if (!Array.isArray(points) || !points.length) return null;
      return await request({
        baseUrl,
        apiKey,
        timeoutMs,
        method: "PUT",
        path: `/collections/${encodeURIComponent(collection)}/points${wait ? "?wait=true" : ""}`,
        body: { points },
      });
    },
    async deletePoints({ collection, filter, ids, wait = true }) {
      const body = ids ? { points: ids } : { filter };
      return await request({
        baseUrl,
        apiKey,
        timeoutMs,
        method: "POST",
        path: `/collections/${encodeURIComponent(collection)}/points/delete${wait ? "?wait=true" : ""}`,
        body,
      });
    },
    async search({ collection, vector, limit = 8, filter, withPayload = true, scoreThreshold }) {
      const body = {
        vector,
        limit,
        with_payload: withPayload,
        ...(filter ? { filter } : {}),
        ...(typeof scoreThreshold === "number" ? { score_threshold: scoreThreshold } : {}),
      };
      const result = await request({
        baseUrl,
        apiKey,
        timeoutMs,
        method: "POST",
        path: `/collections/${encodeURIComponent(collection)}/points/search`,
        body,
      });
      return Array.isArray(result?.result) ? result.result : [];
    },
    async scrollPoints({ collection, filter, limit = 100, withPayload = true, offset }) {
      const body = {
        limit,
        with_payload: withPayload,
        ...(filter ? { filter } : {}),
        ...(offset !== undefined ? { offset } : {}),
      };
      return await request({
        baseUrl,
        apiKey,
        timeoutMs,
        method: "POST",
        path: `/collections/${encodeURIComponent(collection)}/points/scroll`,
        body,
      });
    },
    async createSnapshot(name) {
      return await request({
        baseUrl,
        apiKey,
        timeoutMs,
        method: "POST",
        path: `/collections/${encodeURIComponent(name)}/snapshots`,
      });
    },
    async listSnapshots(name) {
      return await request({ baseUrl, apiKey, timeoutMs, method: "GET", path: `/collections/${encodeURIComponent(name)}/snapshots` });
    },
  };
}

export function buildKbFilter(knowledgeBaseId) {
  if (!knowledgeBaseId) return undefined;
  return { must: [{ key: "knowledgeBaseId", match: { value: String(knowledgeBaseId) } }] };
}

export { DEFAULT_BASE_URL as QDRANT_DEFAULT_BASE_URL, DEFAULT_COLLECTION as QDRANT_DEFAULT_COLLECTION, DEFAULT_VECTOR_DISTANCE as QDRANT_DEFAULT_DISTANCE };
