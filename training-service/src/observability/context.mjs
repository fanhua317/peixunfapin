import { AsyncLocalStorage } from "node:async_hooks";
import { recordCompletedSpan, setActiveSpanAttributes, withTelemetrySpan } from "./telemetry.mjs";

const storage = new AsyncLocalStorage();
const MAX_CALL_SAMPLES = 20;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  return Math.max(0, Math.round(finiteNumber(value, fallback)));
}

function safeLabel(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 120);
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function distribution(values) {
  const samples = values.map((value) => finiteNumber(value)).filter((value) => value >= 0).slice(-MAX_CALL_SAMPLES);
  if (!samples.length) return { count: 0, samples: [], avg: null, min: null, max: null, p50: null, p95: null, p99: null };
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    count: samples.length,
    samples,
    avg: Math.round((total / samples.length) * 100) / 100,
    min: Math.min(...samples),
    max: Math.max(...samples),
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
  };
}

function estimateTokens(characters) {
  return Math.max(0, Math.ceil(nonNegativeInteger(characters) / 3));
}

function normalizedUsage(usage, inputCharacters, outputCharacters) {
  const raw = usage && typeof usage === "object" ? usage : {};
  const providedInput = raw.prompt_tokens ?? raw.input_tokens;
  const providedOutput = raw.completion_tokens ?? raw.output_tokens;
  const providedTotal = raw.total_tokens;
  const cached = raw.prompt_cache_hit_tokens
    ?? raw.cached_input_tokens
    ?? raw.prompt_tokens_details?.cached_tokens
    ?? raw.input_tokens_details?.cached_tokens;
  const estimated = providedInput === undefined || providedOutput === undefined;
  const inputTokens = providedInput === undefined ? estimateTokens(inputCharacters) : nonNegativeInteger(providedInput);
  const outputTokens = providedOutput === undefined ? estimateTokens(outputCharacters) : nonNegativeInteger(providedOutput);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: Math.min(inputTokens, nonNegativeInteger(cached)),
    totalTokens: providedTotal === undefined ? inputTokens + outputTokens : nonNegativeInteger(providedTotal),
    estimated,
  };
}

function optionalRate(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function getLlmPricingConfig() {
  const inputPerMillion = optionalRate("TRAINING_LLM_INPUT_COST_PER_MILLION");
  const outputPerMillion = optionalRate("TRAINING_LLM_OUTPUT_COST_PER_MILLION");
  const cachedInputPerMillion = optionalRate("TRAINING_LLM_CACHED_INPUT_COST_PER_MILLION");
  const sourceDate = safeLabel(process.env.TRAINING_LLM_PRICE_SOURCE_DATE || "", "").slice(0, 32);
  return {
    configured: inputPerMillion !== null && outputPerMillion !== null && Boolean(sourceDate),
    currency: safeLabel(process.env.TRAINING_LLM_COST_CURRENCY || "USD", "USD").toUpperCase().slice(0, 12),
    sourceDate,
    source: safeLabel(process.env.TRAINING_LLM_PRICE_SOURCE || "", "").slice(0, 120),
    inputPerMillion,
    outputPerMillion,
    cachedInputPerMillion,
  };
}

function calculateCost(usage) {
  const pricing = getLlmPricingConfig();
  if (!pricing.configured) return { amount: null, currency: pricing.currency, configured: false };
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const inputRate = pricing.inputPerMillion ?? 0;
  const cachedRate = pricing.cachedInputPerMillion ?? inputRate;
  const outputRate = pricing.outputPerMillion ?? 0;
  const amount = ((uncachedInput * inputRate) + (usage.cachedInputTokens * cachedRate) + (usage.outputTokens * outputRate)) / 1_000_000;
  return {
    amount: Math.round(amount * 100_000_000) / 100_000_000,
    currency: pricing.currency,
    configured: true,
  };
}

function currentStore() {
  return storage.getStore() || null;
}

function groupLlmModels(calls) {
  const grouped = new Map();
  for (const call of calls) {
    const key = `${call.provider}\u0000${call.model}`;
    const item = grouped.get(key) || {
      provider: call.provider,
      model: call.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: { amount: 0, currency: call.cost.currency, configured: call.cost.configured },
    };
    item.calls += 1;
    item.inputTokens += call.inputTokens;
    item.outputTokens += call.outputTokens;
    item.totalTokens += call.totalTokens;
    if (call.cost.configured) item.cost.amount += call.cost.amount;
    grouped.set(key, item);
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    cost: {
      ...item.cost,
      amount: item.cost.configured ? Math.round(item.cost.amount * 100_000_000) / 100_000_000 : null,
    },
  }));
}

function createStore(context = {}) {
  return {
    runId: safeLabel(context.runId),
    transport: safeLabel(context.transport, "http"),
    route: safeLabel(context.route),
    llmCalls: [],
    toolCalls: [],
    retrievalCalls: [],
  };
}

export async function withAgentRunObservability(context, fn) {
  const store = createStore(context);
  return await storage.run(store, async () => await withTelemetrySpan("agent.run", {
    "agent.run.id": store.runId,
    "agent.transport": store.transport,
    "agent.route": store.route,
  }, fn));
}

export function recordLlmObservation(input = {}) {
  const store = currentStore();
  if (!store) return null;
  const usage = normalizedUsage(input.usage, input.inputCharacters, input.outputCharacters);
  const call = {
    provider: safeLabel(input.provider, "unknown"),
    model: safeLabel(input.model, "unknown"),
    success: input.success !== false,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    totalTokens: usage.totalTokens,
    estimated: input.estimated === true || usage.estimated,
    latencyMs: nonNegativeInteger(input.latencyMs),
    ttftMs: input.ttftMs === null || input.ttftMs === undefined ? null : nonNegativeInteger(input.ttftMs),
    cost: calculateCost(usage),
  };
  store.llmCalls.push(call);
  if (store.llmCalls.length > 50) store.llmCalls.shift();
  return call;
}

export function recordToolObservation(input = {}) {
  const store = currentStore();
  if (!store) return null;
  const call = {
    name: safeLabel(input.name, "unknown"),
    success: input.success !== false,
    latencyMs: nonNegativeInteger(input.latencyMs),
  };
  store.toolCalls.push(call);
  if (store.toolCalls.length > 50) store.toolCalls.shift();
  recordCompletedSpan("agent.tool", {
    "agent.run.id": store.runId,
    "gen_ai.tool.name": call.name,
    "tool.success": call.success,
    "tool.latency_ms": call.latencyMs,
    success: call.success,
  }, { startedAt: input.startedAt, finishedAt: input.finishedAt });
  return call;
}

export function recordRetrievalObservation(input = {}) {
  const store = currentStore();
  if (!store) return null;
  const evidenceCount = nonNegativeInteger(input.evidenceCount ?? input.effectiveEvidenceCount ?? input.resultCount);
  const call = {
    mode: safeLabel(input.mode || input.retrievalMode, "unknown"),
    candidateCount: nonNegativeInteger(input.candidateCount),
    evidenceCount,
    evidenceHit: input.evidenceHit === undefined ? evidenceCount > 0 : input.evidenceHit === true,
    retrievalLatencyMs: nonNegativeInteger(input.retrievalLatencyMs ?? input.latencyMs),
    rerankerLatencyMs: input.rerankerLatencyMs === null || input.rerankerLatencyMs === undefined
      ? null
      : nonNegativeInteger(input.rerankerLatencyMs),
    rerankerStatus: safeLabel(input.rerankerStatus),
    degradedReason: safeLabel(input.degradedReason || input.fallbackReason),
  };
  store.retrievalCalls.push(call);
  if (store.retrievalCalls.length > 50) store.retrievalCalls.shift();
  recordCompletedSpan("rag.retrieve", {
    "agent.run.id": store.runId,
    "rag.retrieval.mode": call.mode,
    "rag.candidate_count": call.candidateCount,
    "rag.evidence_count": call.evidenceCount,
    "rag.evidence_hit": call.evidenceHit,
    "rag.latency_ms": call.retrievalLatencyMs,
    "rag.degraded_reason": call.degradedReason,
    success: true,
  });
  if (call.rerankerStatus || call.rerankerLatencyMs !== null) {
    const rerankerSucceeded = isSuccessfulRerankerStatus(call.rerankerStatus);
    recordCompletedSpan("rag.rerank", {
      "agent.run.id": store.runId,
      "rag.reranker.status": call.rerankerStatus || "unknown",
      "rag.reranker.latency_ms": call.rerankerLatencyMs ?? 0,
      success: rerankerSucceeded,
    });
  }
  return call;
}

export function isSuccessfulRerankerStatus(status) {
  return /^(?:ready|ok|success|reranked)$/i.test(String(status || "").trim());
}

export function getCurrentObservabilitySnapshot() {
  const store = currentStore();
  if (!store) return null;
  const llmCalls = store.llmCalls;
  const toolCalls = store.toolCalls;
  const retrievalCalls = store.retrievalCalls;
  const successfulLlm = llmCalls.filter((call) => call.success).length;
  const successfulTools = toolCalls.filter((call) => call.success).length;
  const evidenceHits = retrievalCalls.filter((call) => call.evidenceHit).length;
  const costAmount = llmCalls.filter((call) => call.cost.configured).reduce((sum, call) => sum + call.cost.amount, 0);
  const pricing = getLlmPricingConfig();
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    llm: {
      calls: llmCalls.length,
      succeeded: successfulLlm,
      failed: llmCalls.length - successfulLlm,
      estimatedCalls: llmCalls.filter((call) => call.estimated).length,
      inputTokens: llmCalls.reduce((sum, call) => sum + call.inputTokens, 0),
      outputTokens: llmCalls.reduce((sum, call) => sum + call.outputTokens, 0),
      cachedInputTokens: llmCalls.reduce((sum, call) => sum + call.cachedInputTokens, 0),
      totalTokens: llmCalls.reduce((sum, call) => sum + call.totalTokens, 0),
      latencyMs: distribution(llmCalls.map((call) => call.latencyMs)),
      ttftMs: distribution(llmCalls.map((call) => call.ttftMs).filter((value) => value !== null)),
      models: groupLlmModels(llmCalls),
      cost: {
        amount: pricing.configured ? Math.round(costAmount * 100_000_000) / 100_000_000 : null,
        currency: pricing.currency,
        configured: pricing.configured,
        sourceDate: pricing.sourceDate,
        source: pricing.source,
      },
    },
    tools: {
      calls: toolCalls.length,
      succeeded: successfulTools,
      failed: toolCalls.length - successfulTools,
      successRate: toolCalls.length ? Math.round((successfulTools / toolCalls.length) * 10_000) / 10_000 : null,
      latencyMs: distribution(toolCalls.map((call) => call.latencyMs)),
    },
    retrieval: {
      calls: retrievalCalls.length,
      evidenceHits,
      evidenceMisses: retrievalCalls.length - evidenceHits,
      evidenceHitRate: retrievalCalls.length ? Math.round((evidenceHits / retrievalCalls.length) * 10_000) / 10_000 : null,
      candidates: retrievalCalls.reduce((sum, call) => sum + call.candidateCount, 0),
      evidenceCount: retrievalCalls.reduce((sum, call) => sum + call.evidenceCount, 0),
      latencyMs: distribution(retrievalCalls.map((call) => call.retrievalLatencyMs)),
      rerankerLatencyMs: distribution(retrievalCalls.map((call) => call.rerankerLatencyMs).filter((value) => value !== null)),
      modes: Object.fromEntries([...new Set(retrievalCalls.map((call) => call.mode))].map((mode) => [mode, retrievalCalls.filter((call) => call.mode === mode).length])),
      degradedReasons: [...new Set(retrievalCalls.map((call) => call.degradedReason).filter(Boolean))].slice(0, 10),
    },
  };
}

export function finalizeCurrentObservability({ status, skill, action } = {}) {
  setActiveSpanAttributes({
    "agent.status": safeLabel(status),
    "agent.skill": safeLabel(skill),
    "agent.action": safeLabel(action),
  });
  return getCurrentObservabilitySnapshot();
}
