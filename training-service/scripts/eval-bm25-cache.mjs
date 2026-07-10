import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const modeArg = process.argv.find((argument) => argument.startsWith("--mode="));

function makeChunk(id, term) {
  return {
    id,
    knowledgeBaseId: "kb-cache-eval",
    documentId: `doc-${id}`,
    parentId: null,
    content: `${term} motor power efficiency training specification with enough useful detail.`,
    searchText: `${term} motor power efficiency`,
    sourceRef: `${id}.md`,
    heading: `${term} motor`,
    contentHash: `persisted-${id}`,
    businessKeys: { series: [term], category: "motor" },
    metadata: { source: "bm25-cache-eval", nested: { order: 1 } },
  };
}

function hitIds(searchChunks, state, query) {
  return searchChunks(state, { knowledgeBaseId: "kb-cache-eval", query, limit: 5 }).map((item) => item.id);
}

async function runMode(mode) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `juzhou-bm25-cache-${mode}-`));
  let closeTrainingDatabase = () => {};
  process.env.TRAINING_DATA_DIR = tempDir;
  process.env.TRAINING_STORAGE = mode;
  process.env.TRAINING_HYBRID_RETRIEVAL = "0";
  process.env.TRAINING_BM25_CACHE_MAX_ENTRIES = "3";
  try {
    const { defaultState, loadState, saveState } = await import("../src/store.mjs");
    const {
      getBm25CacheDiagnostics,
      invalidateBm25CacheForState,
      resetBm25CacheForTests,
      searchChunks,
    } = await import("../src/rag.mjs");
    ({ closeTrainingDatabase } = await import("../src/sqlite-store.mjs"));

    const source = defaultState();
    source.knowledgeBases = [{ id: "kb-cache-eval", name: "BM25 cache eval" }];
    source.documents = [];
    source.chunkParents = [];
    source.chunks = [makeChunk("chunk-alpha", "alpha"), makeChunk("chunk-beta", "beta")];
    await saveState(source);

    resetBm25CacheForTests();
    const firstLoad = await loadState();
    assert.deepEqual(hitIds(searchChunks, firstLoad, "alpha"), ["chunk-alpha"]);
    const afterFirst = getBm25CacheDiagnostics();
    assert.equal(afterFirst.misses, 1, `${mode}: first lookup must miss`);
    assert.equal(afterFirst.builds, 1, `${mode}: first lookup must build one corpus`);

    const secondLoad = await loadState();
    assert.notEqual(secondLoad, firstLoad, `${mode}: loadState must return a new state object`);
    assert.notEqual(secondLoad.chunks, firstLoad.chunks, `${mode}: loadState must return a new chunks array`);
    assert.deepEqual(hitIds(searchChunks, secondLoad, "alpha"), ["chunk-alpha"]);
    const afterReload = getBm25CacheDiagnostics();
    assert.equal(afterReload.hits, 1, `${mode}: identical committed content must hit across loadState objects`);
    assert.equal(afterReload.builds, 1, `${mode}: identical committed content must not rebuild`);

    secondLoad.chunks[0] = makeChunk("chunk-gamma", "gamma");
    invalidateBm25CacheForState(secondLoad);
    assert.deepEqual(hitIds(searchChunks, secondLoad, "gamma"), ["chunk-gamma"]);
    assert.deepEqual(hitIds(searchChunks, secondLoad, "alpha"), [], `${mode}: replaced chunk must not remain searchable`);
    const afterReplace = getBm25CacheDiagnostics();
    assert.ok(afterReplace.invalidations >= 1, `${mode}: in-place replacement must invalidate the state snapshot`);
    assert.ok(afterReplace.builds >= 2, `${mode}: changed content must build a new corpus`);

    // Mutating fields on the same chunk object (without changing its reference,
    // array length, or state revision) must not reuse stale postings.
    const sameObject = secondLoad.chunks[0];
    sameObject.content = sameObject.content.replaceAll("gamma", "theta");
    sameObject.searchText = sameObject.searchText.replaceAll("gamma", "theta");
    sameObject.heading = sameObject.heading.replaceAll("gamma", "theta");
    sameObject.businessKeys = { ...sameObject.businessKeys, series: ["theta"] };
    invalidateBm25CacheForState(secondLoad);
    assert.deepEqual(hitIds(searchChunks, secondLoad, "theta"), ["chunk-gamma"]);
    assert.deepEqual(hitIds(searchChunks, secondLoad, "gamma"), [], `${mode}: same-object property mutation must invalidate stale postings`);
    const afterPropertyMutation = getBm25CacheDiagnostics();
    assert.ok(afterPropertyMutation.invalidations >= 2, `${mode}: same-object property mutation must invalidate the cache`);

    sameObject.content = sameObject.content.replaceAll("theta", "kappa");
    sameObject.searchText = sameObject.searchText.replaceAll("theta", "kappa");
    sameObject.heading = sameObject.heading.replaceAll("theta", "kappa");
    sameObject.businessKeys = { ...sameObject.businessKeys, series: ["kappa"] };
    await saveState(secondLoad);
    const committedMutation = await loadState();
    assert.match(String(committedMutation.meta?.chunksRevision || ""), /^[a-f0-9]{64}$/, `${mode}: committed chunks revision missing`);
    assert.deepEqual(hitIds(searchChunks, committedMutation, "kappa"), ["chunk-gamma"]);
    assert.deepEqual(hitIds(searchChunks, committedMutation, "theta"), [], `${mode}: committed mutation must not reuse stale postings`);

    secondLoad.chunks.push(makeChunk("chunk-delta", "delta"));
    assert.deepEqual(hitIds(searchChunks, secondLoad, "delta"), ["chunk-delta"]);
    const afterAdd = getBm25CacheDiagnostics();
    assert.ok(afterAdd.invalidations >= 3, `${mode}: in-place addition must invalidate the state snapshot`);

    secondLoad.chunks.splice(secondLoad.chunks.findIndex((chunk) => chunk.id === "chunk-delta"), 1);
    assert.deepEqual(hitIds(searchChunks, secondLoad, "delta"), [], `${mode}: deleted chunk must not remain searchable`);
    const afterDelete = getBm25CacheDiagnostics();
    assert.ok(afterDelete.invalidations >= 4, `${mode}: in-place deletion must invalidate the state snapshot`);

    const lruIterations = afterDelete.limits.entries + 2;
    for (let index = 0; index < lruIterations; index += 1) {
      const state = {
        meta: { version: 1, updatedAt: `2026-07-10T00:00:${String(index).padStart(2, "0")}.000Z` },
        chunks: [makeChunk(`chunk-lru-${index}`, `lru${index}`)],
        chunkParents: [],
      };
      hitIds(searchChunks, state, `lru${index}`);
    }
    const finalDiagnostics = getBm25CacheDiagnostics();
    assert.ok(finalDiagnostics.entries <= finalDiagnostics.limits.entries, `${mode}: LRU entry limit exceeded`);
    assert.ok(finalDiagnostics.cachedChunks <= finalDiagnostics.limits.chunks, `${mode}: cached chunk limit exceeded`);
    assert.ok(finalDiagnostics.cachedTokens <= finalDiagnostics.limits.tokens, `${mode}: cached token limit exceeded`);
    assert.ok(finalDiagnostics.evictions > 0, `${mode}: bounded cache must evict old corpora`);
    assert.deepEqual(
      Object.keys(finalDiagnostics).sort(),
      ["builds", "bypasses", "cachedChunks", "cachedTokens", "entries", "evictions", "hits", "invalidations", "limits", "misses", "version"].sort(),
      `${mode}: diagnostics must expose aggregate fields only`,
    );
    assert.ok(!JSON.stringify(finalDiagnostics).includes("alpha"), `${mode}: diagnostics must not expose indexed text or cache keys`);

    return { mode, ok: true, diagnostics: finalDiagnostics };
  } finally {
    closeTrainingDatabase();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runHotPathGuard() {
  const { getBm25CacheDiagnostics, resetBm25CacheForTests, searchChunks } = await import("../src/rag.mjs");
  const count = 20_579;
  const chunks = Array.from({ length: count }, (_, index) => makeChunk(`scale-${index}`, `model${index}`));
  const state = {
    meta: { version: 1, chunksRevision: "a".repeat(64) },
    chunks,
    chunkParents: [],
  };
  resetBm25CacheForTests();
  hitIds(searchChunks, state, "model20500");
  const latencies = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    hitIds(searchChunks, state, `model${20_000 + index}`);
    latencies.push(performance.now() - startedAt);
  }
  latencies.sort((left, right) => left - right);
  const p95Ms = latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)];
  assert.ok(p95Ms < 100, `20,579-chunk hot cache p95 regressed to ${p95Ms.toFixed(2)}ms`);
  const diagnostics = getBm25CacheDiagnostics();
  assert.equal(diagnostics.builds, 1, "hot path must reuse the committed corpus");
  assert.equal(diagnostics.hits, 20, "hot path cache hit count mismatch");
  return { mode: "hot-path-20579", ok: true, p95Ms: Number(p95Ms.toFixed(3)), diagnostics };
}

async function runRetainedTermWeightGuard() {
  const { getBm25CacheDiagnostics, resetBm25CacheForTests, searchChunks } = await import("../src/rag.mjs");
  const repeated = Array.from({ length: 2_000 }, () => "motor").join(" ");
  const chunk = makeChunk("term-weight", "termweight");
  chunk.content = repeated;
  chunk.searchText = repeated;
  const state = {
    meta: { version: 1, chunksRevision: "b".repeat(64) },
    chunks: [chunk],
    chunkParents: [],
  };
  resetBm25CacheForTests();
  hitIds(searchChunks, state, "motor");
  hitIds(searchChunks, state, "motor");
  const diagnostics = getBm25CacheDiagnostics();
  assert.equal(diagnostics.limits.tokens, 50, "term-weight guard did not apply its small cache limit");
  assert.equal(diagnostics.builds, 1, "transient repeated tokens must not trigger a rebuild");
  assert.equal(diagnostics.hits, 1, "term-weight corpus must be reused");
  assert.equal(diagnostics.bypasses, 0, "cache weight must use retained unique term slots");
  assert.ok(diagnostics.cachedTokens <= 50, "retained term slots exceeded the configured bound");
  return { mode: "retained-term-weight", ok: true, diagnostics };
}

if (modeArg) {
  const mode = modeArg.slice("--mode=".length);
  const result = mode === "term-weight" ? await runRetainedTermWeightGuard() : await runMode(mode);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  const results = [];
  for (const mode of ["json", "sqlite"]) {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, `--mode=${mode}`], {
      cwd: path.dirname(scriptPath),
      env: { ...process.env },
      maxBuffer: 1024 * 1024,
    });
    results.push(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)));
  }
  const { stdout: termWeightStdout } = await execFileAsync(process.execPath, [scriptPath, "--mode=term-weight"], {
    cwd: path.dirname(scriptPath),
    env: { ...process.env, TRAINING_BM25_CACHE_MAX_TOKENS: "50" },
    maxBuffer: 1024 * 1024,
  });
  results.push(JSON.parse(termWeightStdout.trim().split(/\r?\n/).at(-1)));
  results.push(await runHotPathGuard());
  process.stdout.write(`${JSON.stringify({ ok: results.every((item) => item.ok), total: results.length, results }, null, 2)}\n`);
}
