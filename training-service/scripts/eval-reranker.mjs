import http from "node:http";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const token = "reranker-eval-secret";
let lastDocumentCount = 0;
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "ready", model: "eval-bge-reranker", device: "mock" }));
    return;
  }
  if (req.url !== "/rerank" || req.method !== "POST") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const body = await readBody(req);
  lastDocumentCount = body.documents?.length || 0;
  if (String(body.query).includes("force-timeout")) {
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    }, 500);
    return;
  }
  if (String(body.query).includes("force-500")) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "mock failure" }));
    return;
  }
  const results = [...(body.documents || [])]
    .reverse()
    .map((document, index) => ({ id: document.id, index, score: 0.9 - index * 0.01 }));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: "eval-bge-reranker", latencyMs: 7, results }));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve();
  });
});

const address = server.address();
process.env.TRAINING_RERANKER_ENABLED = "1";
process.env.TRAINING_RERANKER_URL = `http://127.0.0.1:${address.port}`;
process.env.TRAINING_RERANKER_API_KEY = token;
process.env.TRAINING_RERANKER_TIMEOUT_MS = "100";

const results = [];
try {
  const { checkRerankerRuntime, getRerankerRuntimeConfig, rerankDocuments } = await import(`../src/reranker.mjs?eval=${Date.now()}`);
  delete process.env.TRAINING_RERANKER_ENABLED;
  assert(!getRerankerRuntimeConfig().enabled, "reranker must remain disabled without an explicit enable flag");
  process.env.TRAINING_RERANKER_ENABLED = "1";
  process.env.TRAINING_RERANKER_URL = `http://user:password@127.0.0.1:${address.port}?token=must-not-leak`;
  const sanitized = getRerankerRuntimeConfig();
  assert(!sanitized.url.includes("user") && !sanitized.url.includes("password") && !sanitized.url.includes("token="), "runtime config must sanitize URL credentials and query values");
  process.env.TRAINING_RERANKER_URL = "user:secret-password@host";
  const invalidScheme = getRerankerRuntimeConfig();
  assert(invalidScheme.url === "" && !invalidScheme.configured, "non-HTTP reranker URL must be rejected without echoing the raw value");
  process.env.TRAINING_RERANKER_URL = `http://user:password@127.0.0.1:${address.port}?token=must-not-leak`;
  results.push({ id: "explicit-enable-and-url-redaction", ok: true });
  const health = await checkRerankerRuntime();
  assert(health.ok && health.model === "eval-bge-reranker", "health should expose the ready mock reranker");
  results.push({ id: "health", ok: true });

  const normal = await rerankDocuments("normal", [
    { id: "a", text: "first" },
    { id: "b", text: "second" },
  ]);
  assert(normal.ok && normal.results[0].id === "b", "normal rerank should preserve service order");
  results.push({ id: "normal", ok: true });

  const many = await rerankDocuments("limit", Array.from({ length: 60 }, (_, index) => ({ id: `doc-${index}`, text: "x".repeat(5_000) })));
  assert(many.ok && lastDocumentCount === 50, `client should cap candidates at 50, got ${lastDocumentCount}`);
  results.push({ id: "limits", ok: true });

  const failed = await rerankDocuments("force-500", [{ id: "a", text: "first" }]);
  assert(!failed.ok && failed.status === "fallback" && failed.reasonCode === "service_error", "HTTP 500 should produce fallback metadata");
  assert(!failed.error.includes("mock failure"), "reranker error metadata must not expose upstream error text");
  results.push({ id: "http-500-fallback", ok: true });

  const timedOut = await rerankDocuments("force-timeout", [{ id: "a", text: "first" }]);
  assert(!timedOut.ok && timedOut.status === "fallback", "timeout should produce fallback metadata");
  results.push({ id: "timeout-fallback", ok: true });

  process.env.TRAINING_RERANKER_API_KEY = "wrong-token";
  const unauthorized = await rerankDocuments("unauthorized", [{ id: "a", text: "first" }]);
  assert(!unauthorized.ok && unauthorized.status === "fallback", "401 should produce fallback metadata");
  results.push({ id: "auth-fallback", ok: true });

  console.log(JSON.stringify({ ok: true, total: results.length, results }, null, 2));
} catch (error) {
  console.error(error);
  console.log(JSON.stringify({ ok: false, results }, null, 2));
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.TRAINING_RERANKER_ENABLED;
  delete process.env.TRAINING_RERANKER_URL;
  delete process.env.TRAINING_RERANKER_API_KEY;
  delete process.env.TRAINING_RERANKER_TIMEOUT_MS;
}
