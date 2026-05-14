const DEFAULT_BASE_URL = process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.TRAINING_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || "bge-m3";
const DEFAULT_TIMEOUT_MS = Number(process.env.EMBEDDING_TIMEOUT_MS || 120_000);
const DEFAULT_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || 16);
const DEFAULT_RETRIES = Number(process.env.EMBEDDING_RETRIES || 2);

function buildUrl(baseUrl, path) {
  const trimmed = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  return `${trimmed}${path.startsWith("/") ? path : `/${path}`}`;
}

async function postJson({ baseUrl, path, body, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(buildUrl(baseUrl, path), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const detail = payload?.error || text || response.statusText;
      throw new Error(`Ollama POST ${path} failed: ${detail}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function withRetry(fn, retries = DEFAULT_RETRIES) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const wait = 400 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  throw lastError;
}

function extractEmbeddings(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.embeddings)) return payload.embeddings;
  if (Array.isArray(payload.data)) {
    return payload.data
      .map((entry) => Array.isArray(entry?.embedding) ? entry.embedding : null)
      .filter(Boolean);
  }
  if (Array.isArray(payload.embedding)) return [payload.embedding];
  return [];
}

export function createEmbeddingClient(options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const retries = Number.isFinite(options.retries) ? options.retries : DEFAULT_RETRIES;
  return {
    baseUrl,
    model,
    batchSize,
    async ping() {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch(buildUrl(baseUrl, "/api/tags"), { signal: controller.signal });
        if (!response.ok) throw new Error(`Ollama ping failed: ${response.status}`);
        return await response.json();
      } finally {
        clearTimeout(timeout);
      }
    },
    async embedOne(text) {
      const result = await this.embed([String(text || "")]);
      return result[0] || null;
    },
    async embed(texts) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const inputs = texts.map((text) => String(text || ""));
      const vectors = new Array(inputs.length);
      for (let start = 0; start < inputs.length; start += batchSize) {
        const batch = inputs.slice(start, start + batchSize);
        const payload = await withRetry(
          () => postJson({
            baseUrl,
            path: "/api/embed",
            body: { model, input: batch },
            timeoutMs,
          }),
          retries,
        );
        const embeddings = extractEmbeddings(payload);
        if (embeddings.length !== batch.length) {
          throw new Error(`Ollama returned ${embeddings.length} embeddings for batch of ${batch.length}`);
        }
        for (let index = 0; index < embeddings.length; index += 1) {
          vectors[start + index] = embeddings[index];
        }
      }
      return vectors;
    },
    async detectDimension() {
      const probe = await this.embedOne("dimension probe");
      if (!Array.isArray(probe)) throw new Error("Failed to detect embedding dimension");
      return probe.length;
    },
  };
}

export { DEFAULT_MODEL as EMBEDDING_DEFAULT_MODEL, DEFAULT_BASE_URL as EMBEDDING_DEFAULT_BASE_URL };
