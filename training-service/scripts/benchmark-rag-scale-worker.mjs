import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { writeJsonAtomic } from "../src/storage/atomic-json.mjs";
import {
  isCompleteQueryGrid,
  isCompleteQueryMatrix,
  isSupportedQueryGrid,
  runQueryMatrix,
  summarizeDegradation,
} from "./benchmark-rag-scale-query-runner.mjs";
import { collectDiskStatus, percentile } from "./server-audit/common.mjs";
import { buildScaleQueries } from "./rag-scale-corpus.mjs";

const execFileAsync = promisify(execFile);

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    args[key] = rest.length ? rest.join("=") : true;
  }
  return args;
}

const args = parseArgs();
const count = Math.max(1, Number(args.count) || 100);
const corpusDir = path.resolve(String(args.corpus || ""));
const dataDir = path.resolve(String(args.data || ""));
const artifactPath = path.resolve(String(args.out || path.join(dataDir, "benchmark.json")));
const queryCount = Math.max(1, Number(args.queries) || 100);
const concurrencyLevels = String(args.concurrency || "1,5,10,20").split(",").map(Number).filter((value) => value > 0);
const resume = args.resume === true || String(args.resume || "").toLowerCase() === "true";
const rerunQueries = args["rerun-queries"] === true || String(args["rerun-queries"] || "").toLowerCase() === "true";

if (!corpusDir || !dataDir) throw new Error("--corpus and --data are required");

process.env.TRAINING_DATA_DIR = dataDir;
process.env.TRAINING_STORAGE = "sqlite";
process.env.TRAINING_LOCAL_VECTOR_INDEX_PATH = path.join(dataDir, "vector-index-bge-m3.json");
process.env.TRAINING_VECTOR_BACKEND = "local";
process.env.TRAINING_HYBRID_RETRIEVAL = "1";
process.env.TRAINING_EMBEDDING_MODEL = process.env.TRAINING_EMBEDDING_MODEL || "bge-m3";

async function readCheckpoint() {
  if (!resume) return null;
  try {
    return JSON.parse(await readFile(artifactPath, "utf8"));
  } catch {
    return null;
  }
}

const result = await readCheckpoint() || {
  kind: "juzhou-rag-scale-tier",
  version: 2,
  count,
  corpusDir,
  dataDir,
  createdAt: new Date().toISOString(),
  stages: {},
  resources: [],
};
if (Number(result.version || 0) < 2) {
  result.version = 2;
  delete result.stages.queries;
  delete result.capacity;
  delete result.completedAt;
}
if (rerunQueries) {
  delete result.stages.queries;
  delete result.capacity;
  delete result.completedAt;
  result.resources = (result.resources || []).filter((item) => !String(item?.stage || "").startsWith("queries"));
}

async function saveCheckpoint() {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  result.updatedAt = new Date().toISOString();
  await writeJsonAtomic(artifactPath, result);
}

async function gpuSnapshot() {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=name,utilization.gpu,memory.total,memory.used,memory.free",
      "--format=csv,noheader,nounits",
    ], { timeout: 5_000 });
    const [name, utilization, total, used, free] = stdout.trim().split(",").map((value) => value.trim());
    return { name, utilizationPct: Number(utilization), totalMiB: Number(total), usedMiB: Number(used), freeMiB: Number(free) };
  } catch {
    return null;
  }
}

async function cpuSnapshot() {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        "[math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average,2)",
      ], { timeout: 5_000 });
      const utilizationPct = Number(stdout.trim());
      if (Number.isFinite(utilizationPct)) return { utilizationPct };
    } catch {
    }
  }
  return { utilizationPct: null, loadAverage: os.loadavg() };
}

async function snapshot(stage) {
  const value = {
    at: new Date().toISOString(),
    stage,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    processMemory: process.memoryUsage(),
    processCpu: process.cpuUsage(),
    cpu: await cpuSnapshot(),
    gpu: await gpuSnapshot(),
  };
  result.resources.push(value);
  return value;
}

async function timedStage(name, fn) {
  if (result.stages[name]?.ok && resume) return result.stages[name];
  const startedAt = Date.now();
  await snapshot(`${name}:start`);
  let sampling = false;
  const sampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    snapshot(`${name}:sample`).catch(() => {}).finally(() => { sampling = false; });
  }, 2_000);
  try {
    const value = await fn();
    result.stages[name] = { ok: true, elapsedMs: Date.now() - startedAt, ...value };
  } catch (error) {
    clearInterval(sampler);
    const message = error instanceof Error ? error.message : String(error);
    result.stages[name] = {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: message,
      failure: {
        name: error instanceof Error ? error.name : "Error",
        code: error?.code || null,
        oomDetected: /out of memory|cuda|allocation|memory/i.test(message),
        attempts: Array.isArray(error?.attempts) ? error.attempts : [],
      },
    };
    await snapshot(`${name}:failed`);
    await saveCheckpoint();
    throw error;
  }
  clearInterval(sampler);
  await snapshot(`${name}:done`);
  await saveCheckpoint();
  return result.stages[name];
}

await mkdir(dataDir, { recursive: true });
if (!result.diskBefore) {
  result.diskBefore = await collectDiskStatus(dataDir);
  await saveCheckpoint();
}

await timedStage("import", async () => {
  const { importCleanDirectory } = await import("../src/import/importer.mjs");
  const imported = await importCleanDirectory({
    inputDir: corpusDir,
    kbName: `RAG Scale ${count}`,
    aliases: [`scale-${count}`, "benchmark"],
  });
  if (Number(imported.fileCount) !== count) {
    throw new Error(`expected ${count} imported documents, got ${imported.fileCount}`);
  }
  const databasePath = path.join(dataDir, "training.db");
  const databaseBytes = (await stat(databasePath)).size;
  return {
    knowledgeBaseId: imported.kbId,
    documents: imported.fileCount,
    parents: imported.parentCount,
    chunks: imported.chunkCount,
    databaseBytes,
  };
});

await timedStage("embedding", async () => {
  const { buildLocalVectorIndex } = await import("../src/local-vector-build.mjs");
  const attempts = [];
  let batchSize = Math.max(1, Number(process.env.EMBEDDING_BATCH_SIZE || process.env.EMBED_BATCH_SIZE || 32));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    process.env.EMBEDDING_BATCH_SIZE = String(batchSize);
    try {
      const built = await buildLocalVectorIndex({ full: true, forceAll: true });
      const indexBytes = (await stat(built.outputPath)).size;
      attempts.push({ attempt: attempt + 1, batchSize, ok: true });
      return { ...built, indexBytes, attempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ attempt: attempt + 1, batchSize, ok: false, error: message.slice(0, 300) });
      if (attempt === 0 && /out of memory|cuda|allocation|memory/i.test(message)) {
        batchSize = Math.max(1, Math.floor(batchSize / 2));
        continue;
      }
      throw Object.assign(new Error(message), { attempts });
    }
  }
  throw new Error("embedding failed after retry");
});

function hitText(hit) {
  return `${hit?.sourceRef || ""}\n${hit?.heading || ""}\n${hit?.content || ""}`;
}

function relevantRank(hits, test) {
  const index = (hits || []).findIndex((hit) => {
    const text = hitText(hit);
    return text.includes(test.expectedModel) && (text.includes(test.expectedEvidenceCode) || text.includes(test.expectedSource));
  });
  return index < 0 ? 0 : index + 1;
}

async function runQueriesStage() {
  const modes = ["bm25", "hybrid", "hybrid-rerank"];
  const existingStage = result.stages.queries;
  const existingMatrix = Array.isArray(existingStage?.matrix) ? existingStage.matrix : [];
  const reusableMatrix = Number(existingStage?.queryCount) === queryCount ? existingMatrix : [];
  if (
    resume
    && existingStage?.ok
    && Number(existingStage.queryCount) === queryCount
    && isCompleteQueryMatrix(existingMatrix, modes, concurrencyLevels)
  ) return existingStage;

  const { loadState } = await import("../src/store.mjs");
  const { searchKnowledgeContextsByMode } = await import("../src/rag.mjs");
  const state = await loadState();
  const knowledgeBaseId = result.stages.import.knowledgeBaseId;
  const tests = buildScaleQueries(count, queryCount);
  const startedAt = Date.now();
  delete result.capacity;
  delete result.completedAt;
  result.stages.queries = {
    ...existingStage,
    ok: false,
    inProgress: true,
    queryCount: tests.length,
    concurrencyLevels,
    matrix: reusableMatrix,
    startedAt: existingStage?.startedAt || new Date().toISOString(),
  };
  await snapshot("queries:start");
  await saveCheckpoint();

  try {
    const matrix = await runQueryMatrix({
      state,
      knowledgeBaseId,
      tests,
      modes,
      concurrencyLevels,
      search: searchKnowledgeContextsByMode,
      rank: relevantRank,
      percentile,
      existingMatrix: reusableMatrix,
      snapshot,
      checkpoint: async (nextMatrix) => {
        result.stages.queries.matrix = nextMatrix;
        result.stages.queries.degradation = summarizeDegradation(nextMatrix.filter(isCompleteQueryGrid));
        await saveCheckpoint();
      },
    });
    result.stages.queries = {
      ...result.stages.queries,
      ok: true,
      inProgress: false,
      elapsedMs: Number(existingStage?.elapsedMs || 0) + Date.now() - startedAt,
      completedAt: new Date().toISOString(),
      matrix,
      degradation: summarizeDegradation(matrix),
    };
    await snapshot("queries:done");
    await saveCheckpoint();
    return result.stages.queries;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.stages.queries = {
      ...result.stages.queries,
      ok: false,
      inProgress: false,
      elapsedMs: Number(existingStage?.elapsedMs || 0) + Date.now() - startedAt,
      failedAt: new Date().toISOString(),
      error: message,
      failure: { name: error instanceof Error ? error.name : "Error", code: error?.code || null },
    };
    await snapshot("queries:failed");
    await saveCheckpoint();
    throw error;
  }
}

await runQueriesStage();

const queryMatrix = result.stages.queries.matrix || [];
const c1 = queryMatrix.filter((row) => row.concurrency === 1);
const c10 = queryMatrix.filter((row) => row.concurrency === 10);
const peakMemoryUsedRatio = result.resources.length
  ? Math.max(...result.resources.map((item) => 1 - (Number(item.freeMemoryBytes || 0) / Math.max(1, Number(item.totalMemoryBytes || 1)))))
  : 0;
const peakGpuUsedRatio = Math.max(0, ...result.resources.map((item) => item.gpu?.totalMiB ? item.gpu.usedMiB / item.gpu.totalMiB : 0));
const peakCpuUtilizationPct = Math.max(0, ...result.resources.map((item) => Number(item.cpu?.utilizationPct || 0)));
const disk = await collectDiskStatus(dataDir);
const degradation = summarizeDegradation(queryMatrix);
result.diskAfter = disk;
result.diskDeltaUsedBytes = Number.isFinite(Number(result.diskBefore?.Used)) && Number.isFinite(Number(disk?.Used))
  ? Number(disk.Used) - Number(result.diskBefore.Used)
  : null;
const perConcurrency = concurrencyLevels.map((concurrency) => {
  const rows = queryMatrix.filter((row) => row.concurrency === concurrency);
  const latencyLimitMs = concurrency === 1 ? 2_000 : 5_000;
  return {
    concurrency,
    supported: rows.length === 3 && rows.every((row) => isSupportedQueryGrid(row, latencyLimitMs)),
    latencyLimitMs,
  };
});
result.capacity = {
  zeroErrors: queryMatrix.every((row) => row.summary.errorRate === 0),
  degradationTarget: degradation.degraded === 0,
  degradation,
  hitAt3Target: queryMatrix.every((row) => row.summary.hitAt3Rate >= 0.95),
  singleConcurrencyP95Target: c1.every((row) => row.summary.p95Ms <= 2_000),
  tenConcurrencyP95Target: c10.length > 0 && c10.every((row) => row.summary.p95Ms <= 5_000),
  memoryTarget: peakMemoryUsedRatio < 0.8,
  gpuMemoryTarget: peakGpuUsedRatio < 0.95,
  diskTarget: Number(disk?.Free || disk?.free || 0) > 20 * 1024 * 1024 * 1024,
  peakMemoryUsedRatio: Number(peakMemoryUsedRatio.toFixed(4)),
  peakGpuUsedRatio: Number(peakGpuUsedRatio.toFixed(4)),
  peakCpuUtilizationPct: Number(peakCpuUtilizationPct.toFixed(2)),
  disk,
  perConcurrency,
  maxSupportedConcurrency: perConcurrency.filter((item) => item.supported).at(-1)?.concurrency || 0,
};
result.capacity.supported = Object.entries(result.capacity)
  .filter(([key]) => key.endsWith("Target") || key === "zeroErrors")
  .every(([, value]) => value === true);
result.completedAt = new Date().toISOString();
await saveCheckpoint();
console.log(JSON.stringify({ ok: true, count, artifactPath, capacity: result.capacity }, null, 2));
