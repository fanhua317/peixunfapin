import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../src/storage/atomic-json.mjs";
import { generateScaleCorpus } from "./rag-scale-corpus.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    args[key] = rest.length ? rest.join("=") : true;
  }
  return args;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
}

const args = parseArgs();
const sizes = String(args.sizes || "100,1000,5000").split(",").map(Number).filter((value) => value > 0);
const workDir = path.resolve(String(args.work || path.join(os.tmpdir(), `juzhou-rag-scale-${stamp()}`)));
const outDir = path.resolve(String(args.out || path.join(import.meta.dirname, "..", "benchmark-output")));
const queryCount = Math.max(1, Number(args.queries) || 100);
const concurrency = String(args.concurrency || "1,5,10,20");
const resume = args.resume === true || String(args.resume || "").toLowerCase() === "true";
const rerunQueries = args["rerun-queries"] === true || String(args["rerun-queries"] || "").toLowerCase() === "true";
const masterPath = path.join(outDir, `rag-scale-${stamp()}.json`);

await mkdir(workDir, { recursive: true });
await mkdir(outDir, { recursive: true });

function runWorker(workerArgs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "benchmark-rag-scale-worker.mjs"), ...workerArgs], {
      cwd: path.join(import.meta.dirname, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`benchmark worker exited ${code}: ${stderr.slice(-1000)}`)));
  });
}

const aggregate = {
  kind: "juzhou-rag-scale-benchmark",
  version: 2,
  createdAt: new Date().toISOString(),
  host: os.hostname(),
  platform: process.platform,
  arch: process.arch,
  cpus: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  sizes,
  queryCount,
  concurrency: concurrency.split(",").map(Number),
  workDir,
  tiers: [],
};

function summarizeAggregateDegradation(tiers) {
  const summaries = tiers.map((tier) => tier?.capacity?.degradation || tier?.stages?.queries?.degradation || {});
  const requests = summaries.reduce((sum, item) => sum + Number(item.requests || 0), 0);
  const degraded = summaries.reduce((sum, item) => sum + Number(item.degraded || 0), 0);
  const mergeCounts = (field) => summaries.reduce((counts, item) => {
    for (const [key, value] of Object.entries(item[field] || {})) {
      counts[key] = (counts[key] || 0) + Number(value || 0);
    }
    return counts;
  }, {});
  return {
    requests,
    degraded,
    degradedRate: requests ? Number((degraded / requests).toFixed(4)) : 0,
    effectiveModeCounts: mergeCounts("effectiveModeCounts"),
    rerankerStatusCounts: mergeCounts("rerankerStatusCounts"),
    degradedReasonCounts: mergeCounts("degradedReasonCounts"),
  };
}

for (const size of sizes) {
  const tierRoot = path.join(workDir, `scale-${size}`);
  const corpusDir = path.join(tierRoot, "corpus");
  const dataDir = path.join(tierRoot, "data");
  const tierArtifact = path.join(tierRoot, "tier-result.json");
  await mkdir(tierRoot, { recursive: true });
  let corpus = null;
  if (resume) {
    try { corpus = JSON.parse(await readFile(path.join(corpusDir, "manifest.json"), "utf8")); } catch { /* regenerate */ }
  }
  if (!corpus || corpus.count !== size) corpus = await generateScaleCorpus(corpusDir, size);
  console.log(`scale ${size}: generated ${corpus.count} importable markdown files`);
  await runWorker([
    `--count=${size}`,
    `--corpus=${corpusDir}`,
    `--data=${dataDir}`,
    `--out=${tierArtifact}`,
    `--queries=${queryCount}`,
    `--concurrency=${concurrency}`,
    ...(resume ? ["--resume"] : []),
    ...(rerunQueries ? ["--rerun-queries"] : []),
  ], { ...process.env, TRAINING_DATA_DIR: dataDir, TRAINING_STORAGE: "sqlite" });
  const tier = JSON.parse(await readFile(tierArtifact, "utf8"));
  aggregate.tiers.push(tier);
  aggregate.degradation = summarizeAggregateDegradation(aggregate.tiers);
  await writeJsonAtomic(masterPath, aggregate);
}

const supported = aggregate.tiers.filter((tier) => tier.capacity?.supported).sort((left, right) => left.count - right.count);
aggregate.capacity = {
  largestSupportedFileCount: supported.at(-1)?.count || 0,
  maxSupportedConcurrencyAtLargest: supported.at(-1)?.capacity?.maxSupportedConcurrency || 0,
  supportedTiers: supported.map((tier) => tier.count),
  failedTiers: aggregate.tiers.filter((tier) => !tier.capacity?.supported).map((tier) => ({ count: tier.count, capacity: tier.capacity })),
};
aggregate.degradation = summarizeAggregateDegradation(aggregate.tiers);
aggregate.completedAt = new Date().toISOString();
await writeJsonAtomic(masterPath, aggregate);
console.log(JSON.stringify({ ok: true, artifactPath: masterPath, capacity: aggregate.capacity }, null, 2));
