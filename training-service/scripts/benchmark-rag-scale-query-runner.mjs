function normalizedRequestedMode(mode) {
  const value = String(mode || "auto").trim().toLowerCase();
  return value === "hybrid+reranker" ? "hybrid-rerank" : value;
}

function retrievalParts(hit) {
  return new Set(String(hit?.retrieval || "").toLowerCase().split("+").filter(Boolean));
}

function firstRerankerStatus(hits) {
  const values = (hits || []).map((hit) => String(hit?.rerankerStatus || "").trim().toLowerCase()).filter(Boolean);
  if (values.includes("ready")) return "ready";
  return values[0] || "missing";
}

export function classifyRetrievalExecution(requestedMode, hits, error = null) {
  const requested = normalizedRequestedMode(requestedMode);
  const safeHits = Array.isArray(hits) ? hits : [];
  const reported = safeHits.execution && typeof safeHits.execution === "object" ? safeHits.execution : null;
  const inferredSemanticUsed = safeHits.some((hit) => {
    const retrieval = retrievalParts(hit);
    return retrieval.has("semantic")
      || retrieval.has("hybrid")
      || Number(hit?.semanticScore || 0) > 0
      || Number(hit?.semanticNormalized || 0) > 0;
  });
  const semanticUsed = reported ? reported.semanticUsed === true : inferredSemanticUsed;
  const rerankerStatus = requested === "hybrid-rerank"
    ? (error ? "error" : String(reported?.rerankerStatus || firstRerankerStatus(safeHits)))
    : "not_requested";
  const rerankerReady = rerankerStatus === "ready";
  const intentionalSkip = reported?.intentionalSkip === true;
  const reasons = [];

  if (error) reasons.push("request_failed");
  if ((requested === "hybrid" || requested === "hybrid-rerank") && !semanticUsed) {
    reasons.push("semantic_not_used");
  }
  if (requested === "hybrid-rerank" && !rerankerReady && !intentionalSkip) {
    reasons.push(`reranker_not_ready:${rerankerStatus}`);
  }

  let effectiveMode = reported?.effectiveMode || "none";
  if (error) {
    effectiveMode = "error";
  } else if (reported) {
    effectiveMode = reported.effectiveMode || effectiveMode;
  } else if (requested === "bm25") {
    effectiveMode = "bm25";
  } else if (requested === "hybrid") {
    effectiveMode = semanticUsed ? "hybrid" : (safeHits.length ? "bm25" : "none");
  } else if (requested === "hybrid-rerank") {
    if (semanticUsed && rerankerReady) effectiveMode = "hybrid+reranker";
    else if (rerankerReady) effectiveMode = safeHits.length ? "bm25+reranker" : "reranker";
    else effectiveMode = semanticUsed ? "hybrid" : (safeHits.length ? "bm25" : "none");
  } else {
    effectiveMode = safeHits[0]?.retrieval || (safeHits.length ? requested : "none");
  }

  return {
    requestedMode: requested,
    effectiveMode,
    rerankerStatus,
    degraded: reasons.length > 0,
    degradedReason: reasons.join(";"),
  };
}

function countBy(rows, valueForRow) {
  const counts = {};
  for (const row of rows) {
    const value = String(valueForRow(row) || "unknown");
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

export function summarizeTimedRows(rows, elapsedMs, percentile) {
  const latencies = rows.map((row) => row.latencyMs).filter(Number.isFinite);
  const errors = rows.filter((row) => !row.ok).length;
  const degraded = rows.filter((row) => row.degraded).length;
  const ranks = rows.map((row) => row.rank).filter((rank) => rank > 0);
  const hitAt3 = rows.filter((row) => row.rank > 0 && row.rank <= 3).length;
  return {
    requests: rows.length,
    ok: rows.length - errors,
    errors,
    errorRate: rows.length ? Number((errors / rows.length).toFixed(4)) : 0,
    degraded,
    degradedRate: rows.length ? Number((degraded / rows.length).toFixed(4)) : 0,
    effectiveModeCounts: countBy(rows, (row) => row.effectiveMode),
    rerankerStatusCounts: countBy(rows, (row) => row.rerankerStatus),
    degradedReasonCounts: countBy(rows.filter((row) => row.degraded), (row) => row.degradedReason),
    rps: elapsedMs ? Number((rows.length / (elapsedMs / 1000)).toFixed(2)) : 0,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    hitAt1: rows.filter((row) => row.rank === 1).length,
    hitAt3,
    hitAt5: rows.filter((row) => row.rank > 0 && row.rank <= 5).length,
    hitAt3Rate: rows.length ? Number((hitAt3 / rows.length).toFixed(4)) : 0,
    mrrAt5: rows.length ? Number((rows.reduce((sum, row) => sum + (row.rank > 0 && row.rank <= 5 ? 1 / row.rank : 0), 0) / rows.length).toFixed(4)) : 0,
    ranked: ranks.length,
  };
}

export function queryGridKey(mode, concurrency) {
  return `${normalizedRequestedMode(mode)}:c${Number(concurrency)}`;
}

export function isCompleteQueryGrid(grid) {
  const queries = Array.isArray(grid?.queries) ? grid.queries : [];
  return Boolean(
    grid?.complete === true
    && grid?.status === "complete"
    && grid?.requestedMode
    && Number.isFinite(Number(grid?.concurrency))
    && Number.isFinite(Number(grid?.summary?.degraded))
    && Number.isFinite(Number(grid?.summary?.degradedRate))
    && queries.length === Number(grid?.summary?.requests)
    && queries.every((row) => (
      typeof row?.requestedMode === "string"
      && typeof row?.effectiveMode === "string"
      && typeof row?.rerankerStatus === "string"
      && typeof row?.degradedReason === "string"
    )),
  );
}

export function isSupportedQueryGrid(grid, latencyLimitMs) {
  return isCompleteQueryGrid(grid)
    && grid.summary.errorRate === 0
    && grid.summary.degraded === 0
    && grid.summary.hitAt3Rate >= 0.95
    && grid.summary.p95Ms <= latencyLimitMs;
}

export function isCompleteQueryMatrix(matrix, modes, concurrencyLevels) {
  if (!Array.isArray(matrix)) return false;
  return modes.every((mode) => concurrencyLevels.every((concurrency) => {
    const key = queryGridKey(mode, concurrency);
    return matrix.some((grid) => (
      queryGridKey(grid?.requestedMode || grid?.mode, grid?.concurrency) === key
      && isCompleteQueryGrid(grid)
    ));
  }));
}

function upsertGrid(matrix, grid) {
  const key = queryGridKey(grid.requestedMode, grid.concurrency);
  const index = matrix.findIndex((item) => queryGridKey(item.requestedMode || item.mode, item.concurrency) === key);
  if (index >= 0) matrix[index] = grid;
  else matrix.push(grid);
}

export async function runQueryMatrix({
  state,
  knowledgeBaseId,
  tests,
  modes,
  concurrencyLevels,
  search,
  rank,
  percentile,
  existingMatrix = [],
  checkpoint = async () => {},
  snapshot = async () => {},
  onGridCompleted = null,
}) {
  const matrix = [...existingMatrix];
  for (const requestedMode of modes) {
    for (const concurrency of concurrencyLevels) {
      const key = queryGridKey(requestedMode, concurrency);
      const existing = matrix.find((item) => queryGridKey(item.requestedMode || item.mode, item.concurrency) === key);
      if (isCompleteQueryGrid(existing)) continue;

      const startedAtIso = new Date().toISOString();
      upsertGrid(matrix, {
        requestedMode,
        mode: requestedMode,
        concurrency,
        status: "running",
        complete: false,
        startedAt: startedAtIso,
      });
      await checkpoint(matrix);

      let completedGrid = null;
      try {
        for (const warmup of tests.slice(0, Math.min(5, tests.length))) {
          await search(state, { knowledgeBaseId, query: warmup.query, limit: 5, mode: requestedMode });
        }
        const rows = [];
        let cursor = 0;
        const startedAt = Date.now();
        const sampler = setInterval(() => {
          snapshot(`queries:${requestedMode}:c${concurrency}`).catch(() => {});
        }, 2_000);
        async function worker() {
          while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= tests.length) return;
            const test = tests[index];
            const requestStarted = Date.now();
            try {
              const hits = await search(state, { knowledgeBaseId, query: test.query, limit: 5, mode: requestedMode });
              const execution = classifyRetrievalExecution(requestedMode, hits);
              rows[index] = {
                id: test.id,
                ok: true,
                latencyMs: Date.now() - requestStarted,
                rank: rank(hits, test),
                ...execution,
              };
            } catch (error) {
              const execution = classifyRetrievalExecution(requestedMode, [], error);
              rows[index] = {
                id: test.id,
                ok: false,
                latencyMs: Date.now() - requestStarted,
                rank: 0,
                error: error instanceof Error ? error.message : String(error),
                ...execution,
              };
            }
          }
        }
        try {
          await Promise.all(Array.from({ length: concurrency }, () => worker()));
        } finally {
          clearInterval(sampler);
        }
        const elapsedMs = Date.now() - startedAt;
        const summary = summarizeTimedRows(rows, elapsedMs, percentile);
        const grid = {
          requestedMode,
          mode: requestedMode,
          concurrency,
          status: "complete",
          complete: true,
          startedAt: startedAtIso,
          completedAt: new Date().toISOString(),
          elapsedMs,
          effectiveModeCounts: summary.effectiveModeCounts,
          summary,
          queries: rows,
          failures: rows.filter((row) => !row.ok || !row.rank || row.degraded).slice(0, 20),
        };
        upsertGrid(matrix, grid);
        await checkpoint(matrix);
        completedGrid = grid;
      } catch (error) {
        const failed = {
          requestedMode,
          mode: requestedMode,
          concurrency,
          status: "failed",
          complete: false,
          startedAt: startedAtIso,
          failedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        upsertGrid(matrix, failed);
        await checkpoint(matrix);
        throw error;
      }
      if (onGridCompleted) await onGridCompleted(completedGrid, matrix);
    }
  }
  return matrix;
}

export function summarizeDegradation(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const requests = rows.reduce((sum, row) => sum + Number(row?.summary?.requests || 0), 0);
  const degraded = rows.reduce((sum, row) => sum + Number(row?.summary?.degraded || 0), 0);
  const mergeCounts = (field) => rows.reduce((counts, row) => {
    for (const [key, value] of Object.entries(row?.summary?.[field] || {})) {
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
