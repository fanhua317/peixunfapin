import { listRuns } from "../agent-runs/store.mjs";

const MAX_AGGREGATION_RUNS = 5000;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function percentile(values, ratio) {
  const samples = values.map(finite).filter((value) => value >= 0).sort((left, right) => left - right);
  if (!samples.length) return null;
  return samples[Math.max(0, Math.ceil(samples.length * ratio) - 1)];
}

function distribution(values) {
  const samples = values.map(finite).filter((value) => value >= 0);
  if (!samples.length) return { count: 0, avg: null, p50: null, p95: null, p99: null, min: null, max: null };
  return {
    count: samples.length,
    avg: Math.round((samples.reduce((sum, value) => sum + value, 0) / samples.length) * 100) / 100,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    min: Math.min(...samples),
    max: Math.max(...samples),
  };
}

function addCurrencyCost(target, cost) {
  if (!cost?.configured || cost.amount === null || cost.amount === undefined) return;
  const currency = String(cost.currency || "USD").toUpperCase();
  target[currency] = (target[currency] || 0) + finite(cost.amount);
}

export async function getObservabilitySummary({ hours = 24, skill = "" } = {}) {
  const normalizedHours = Math.max(1, Math.min(720, finite(hours) || 24));
  const normalizedSkill = String(skill || "").trim().slice(0, 80);
  const to = new Date();
  const from = new Date(to.valueOf() - (normalizedHours * 60 * 60 * 1000));
  const runs = (await listRuns({
    limit: MAX_AGGREGATION_RUNS,
    maxLimit: MAX_AGGREGATION_RUNS,
    skill: normalizedSkill,
  })).filter((run) => {
    const createdAt = Date.parse(run.createdAt);
    return Number.isFinite(createdAt) && createdAt >= from.valueOf() && createdAt <= to.valueOf();
  });
  const observedRuns = runs.filter((run) => run.summary?.observability?.version === 1);
  const llm = observedRuns.map((run) => run.summary.observability.llm || {});
  const tools = observedRuns.map((run) => run.summary.observability.tools || {});
  const retrieval = observedRuns.map((run) => run.summary.observability.retrieval || {});
  const costByCurrency = {};
  for (const item of llm) addCurrencyCost(costByCurrency, item.cost);
  for (const currency of Object.keys(costByCurrency)) {
    costByCurrency[currency] = Math.round(costByCurrency[currency] * 100_000_000) / 100_000_000;
  }
  const toolCalls = tools.reduce((sum, item) => sum + finite(item.calls), 0);
  const successfulTools = tools.reduce((sum, item) => sum + finite(item.succeeded), 0);
  const retrievalCalls = retrieval.reduce((sum, item) => sum + finite(item.calls), 0);
  const evidenceHits = retrieval.reduce((sum, item) => sum + finite(item.evidenceHits), 0);
  const modelCounts = {};
  for (const item of llm) {
    for (const model of item.models || []) {
      const key = `${model.provider || "unknown"}/${model.model || "unknown"}`;
      modelCounts[key] = (modelCounts[key] || 0) + finite(model.calls);
    }
  }
  return {
    hours: normalizedHours,
    skill: normalizedSkill,
    from: from.toISOString(),
    to: to.toISOString(),
    truncated: runs.length >= MAX_AGGREGATION_RUNS,
    runs: {
      total: runs.length,
      observed: observedRuns.length,
      succeeded: runs.filter((run) => run.status === "succeeded").length,
      failed: runs.filter((run) => run.status === "failed").length,
    },
    llm: {
      calls: llm.reduce((sum, item) => sum + finite(item.calls), 0),
      succeeded: llm.reduce((sum, item) => sum + finite(item.succeeded), 0),
      failed: llm.reduce((sum, item) => sum + finite(item.failed), 0),
      estimatedCalls: llm.reduce((sum, item) => sum + finite(item.estimatedCalls), 0),
      inputTokens: llm.reduce((sum, item) => sum + finite(item.inputTokens), 0),
      outputTokens: llm.reduce((sum, item) => sum + finite(item.outputTokens), 0),
      cachedInputTokens: llm.reduce((sum, item) => sum + finite(item.cachedInputTokens), 0),
      totalTokens: llm.reduce((sum, item) => sum + finite(item.totalTokens), 0),
      latencyMs: distribution(llm.flatMap((item) => item.latencyMs?.samples || [])),
      ttftMs: distribution(llm.flatMap((item) => item.ttftMs?.samples || [])),
      costByCurrency,
      models: modelCounts,
    },
    tools: {
      calls: toolCalls,
      succeeded: successfulTools,
      failed: Math.max(0, toolCalls - successfulTools),
      successRate: toolCalls ? Math.round((successfulTools / toolCalls) * 10_000) / 10_000 : null,
      latencyMs: distribution(tools.flatMap((item) => item.latencyMs?.samples || [])),
    },
    retrieval: {
      calls: retrievalCalls,
      evidenceHits,
      evidenceMisses: Math.max(0, retrievalCalls - evidenceHits),
      evidenceHitRate: retrievalCalls ? Math.round((evidenceHits / retrievalCalls) * 10_000) / 10_000 : null,
      latencyMs: distribution(retrieval.flatMap((item) => item.latencyMs?.samples || [])),
      rerankerLatencyMs: distribution(retrieval.flatMap((item) => item.rerankerLatencyMs?.samples || [])),
      metricDefinition: "Online evidence hit rate: retrieval calls that returned at least one usable evidence item; this is not offline ground-truth Hit@K.",
    },
  };
}
