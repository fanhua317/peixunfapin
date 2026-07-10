import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../src/storage/atomic-json.mjs";
import {
  classifyRetrievalExecution,
  isCompleteQueryGrid,
  isSupportedQueryGrid,
  runQueryMatrix,
  summarizeDegradation,
} from "./benchmark-rag-scale-query-runner.mjs";

const normalHybrid = classifyRetrievalExecution("hybrid", [{ retrieval: "hybrid", semanticScore: 0.82 }]);
assert.deepEqual(normalHybrid, {
  requestedMode: "hybrid",
  effectiveMode: "hybrid",
  rerankerStatus: "not_requested",
  degraded: false,
  degradedReason: "",
});

const hybridFallback = classifyRetrievalExecution("hybrid", [{ retrieval: "bm25", semanticScore: 0 }]);
assert.equal(hybridFallback.effectiveMode, "bm25");
assert.equal(hybridFallback.degraded, true);
assert.match(hybridFallback.degradedReason, /semantic_not_used/);

const normalRerank = classifyRetrievalExecution("hybrid-rerank", [{
  retrieval: "hybrid+reranker",
  semanticScore: 0.82,
  rerankerStatus: "ready",
}]);
assert.equal(normalRerank.effectiveMode, "hybrid+reranker");
assert.equal(normalRerank.rerankerStatus, "ready");
assert.equal(normalRerank.degraded, false);

const rerankerFallback = classifyRetrievalExecution("hybrid-rerank", [{
  retrieval: "hybrid",
  semanticScore: 0.82,
  rerankerStatus: "timeout",
}]);
assert.equal(rerankerFallback.effectiveMode, "hybrid");
assert.equal(rerankerFallback.rerankerStatus, "timeout");
assert.equal(rerankerFallback.degraded, true);
assert.match(rerankerFallback.degradedReason, /reranker_not_ready:timeout/);

const emptyReranked = [];
Object.defineProperty(emptyReranked, "execution", {
  value: {
    effectiveMode: "hybrid+reranker",
    semanticUsed: true,
    rerankerStatus: "ready",
    intentionalSkip: false,
  },
});
const emptyRerankedExecution = classifyRetrievalExecution("hybrid-rerank", emptyReranked);
assert.equal(emptyRerankedExecution.effectiveMode, "hybrid+reranker");
assert.equal(emptyRerankedExecution.degraded, false, "empty evidence-gated hits must retain backend execution metadata");

const intentionalRefusal = [];
Object.defineProperty(intentionalRefusal, "execution", {
  value: {
    effectiveMode: "hybrid_evidence_refusal",
    semanticUsed: true,
    rerankerStatus: "skipped_insufficient_evidence",
    intentionalSkip: true,
  },
});
const refusalExecution = classifyRetrievalExecution("hybrid-rerank", intentionalRefusal);
assert.equal(refusalExecution.degraded, false, "business evidence refusal must not be mislabeled as backend degradation");

const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-rag-benchmark-eval-"));
const checkpointPath = path.join(tempDir, "checkpoint.json");
const fixtureTests = [{ id: "query-1", query: "model evidence" }];
const percentile = (values) => values[0] || 0;
let searchCalls = 0;
const successfulSearch = async (_state, options) => {
  searchCalls += 1;
  if (options.mode === "bm25") return [{ retrieval: "bm25", content: "model evidence" }];
  if (options.mode === "hybrid") return [{ retrieval: "hybrid", semanticScore: 0.9, content: "model evidence" }];
  return [{ retrieval: "hybrid+reranker", semanticScore: 0.9, rerankerStatus: "ready", content: "model evidence" }];
};
const rank = () => 1;
const checkpoint = async (matrix) => {
  await writeJsonAtomic(checkpointPath, {
    stages: { queries: { matrix: structuredClone(matrix) } },
  });
};

try {
  await assert.rejects(
    runQueryMatrix({
      state: {},
      knowledgeBaseId: "kb",
      tests: fixtureTests,
      modes: ["bm25", "hybrid"],
      concurrencyLevels: [1, 2],
      search: successfulSearch,
      rank,
      percentile,
      checkpoint,
      onGridCompleted: async () => { throw new Error("simulated interruption"); },
    }),
    /simulated interruption/,
  );

  const interrupted = JSON.parse(await readFile(checkpointPath, "utf8"));
  const interruptedMatrix = interrupted.stages.queries.matrix;
  assert.equal(interruptedMatrix.length, 1);
  assert.equal(isCompleteQueryGrid(interruptedMatrix[0]), true);
  assert.equal(interruptedMatrix[0].queries[0].requestedMode, "bm25");
  assert.equal(interruptedMatrix[0].queries[0].effectiveMode, "bm25");

  const resumedMatrix = await runQueryMatrix({
    state: {},
    knowledgeBaseId: "kb",
    tests: fixtureTests,
    modes: ["bm25", "hybrid"],
    concurrencyLevels: [1, 2],
    search: successfulSearch,
    rank,
    percentile,
    existingMatrix: interruptedMatrix,
    checkpoint,
  });
  assert.equal(resumedMatrix.length, 4);
  assert.equal(resumedMatrix.every(isCompleteQueryGrid), true);
  assert.equal(searchCalls, 8, "resume must skip the already complete grid");
  assert.equal(summarizeDegradation(resumedMatrix).degraded, 0);
  assert.equal(isSupportedQueryGrid(resumedMatrix[0], 2_000), true);

  const degradedMatrix = await runQueryMatrix({
    state: {},
    knowledgeBaseId: "kb",
    tests: fixtureTests,
    modes: ["hybrid", "hybrid-rerank"],
    concurrencyLevels: [1],
    search: async (_state, options) => [{
      retrieval: "bm25",
      semanticScore: 0,
      rerankerStatus: options.mode === "hybrid-rerank" ? "timeout" : "",
      content: "model evidence",
    }],
    rank,
    percentile,
  });
  const degraded = summarizeDegradation(degradedMatrix);
  assert.equal(degraded.requests, 2);
  assert.equal(degraded.degraded, 2);
  assert.equal(degraded.degradedRate, 1);
  assert.equal(degraded.effectiveModeCounts.bm25, 2);
  assert.equal(degraded.rerankerStatusCounts.timeout, 1);
  assert.equal(degradedMatrix.every((grid) => !isSupportedQueryGrid(grid, 2_000)), true);

  const leftovers = (await readdir(tempDir)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "atomic checkpoint must not leave temporary files");

  console.log(JSON.stringify({
    ok: true,
    cases: 7,
    resumedGrids: resumedMatrix.length,
    degraded,
  }, null, 2));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
