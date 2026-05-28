import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-traces-eval-"));
process.env.TRAINING_DATA_DIR = tempDir;
process.env.TRAINING_AGENT_TRACE = "1";

const { appendAgentTrace } = await import("../src/agent-trace.mjs");
const { getAgentTrace, listAgentTraces } = await import("../src/traces.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const results = [];

try {
  await appendAgentTrace({
    runId: "run-trace-eval",
    transport: "http",
    route: "/api/agent/dispatch",
    message: "给王小明发布电机培训",
    decision: {
      intent: "create_training_draft",
      skill: "create_training_draft",
      confidence: 0.96,
      source: "local-rule",
      reason: "明确发布培训",
      needsConfirmation: false,
    },
    result: { action: "draft", draft: { id: "draft-eval", employees: [{ id: "emp-a" }], knowledgeBase: { id: "kb-a" }, warnings: [] } },
    latencyMs: 25,
  });
  await appendAgentTrace({
    transport: "ws",
    route: "/api/agent/stream",
    message: "把之前培训记录删掉",
    decision: {
      intent: "delete_training_records",
      skill: "delete_training_records",
      confidence: 0.98,
      source: "local-rule",
      reason: "高风险删除",
      needsConfirmation: true,
    },
    result: { action: "intent_confirm", confirmation: { skill: "delete_training_records", risk: "high", token: "secret-token" } },
    latencyMs: 12,
  });
  await appendAgentTrace({
    transport: "http",
    route: "/api/agent/dispatch",
    message: "随便聊聊 API key sk-should-not-appear",
    result: { action: "chat", source: "llm-api", route: "general_chat", answer: "ok" },
    error: "mock llm error",
    latencyMs: 33,
  });

  const all = await listAgentTraces({ limit: 10 });
  assert(all.enabled === true, "trace should be enabled");
  assert(all.traces.length === 3, "expected three traces");
  assert(!Object.hasOwn(all.traces[0], "message"), "trace list must not expose full message field");
  assert(all.traces.every((trace) => trace.messageHash && trace.messagePreview), "trace should expose preview and hash");
  assert(all.traces.some((trace) => trace.runId === "run-trace-eval"), "trace should expose runId when present");
  assert(!all.traces.some((trace) => /sk-should-not-appear/.test(trace.messagePreview)), "trace preview should redact API-like keys");
  results.push({ name: "trace list", ok: true, count: all.traces.length });

  const skillFiltered = await listAgentTraces({ skill: "delete_training_records" });
  assert(skillFiltered.traces.length === 1, "skill filter mismatch");
  assert(skillFiltered.traces[0].result.action === "intent_confirm", "skill filter should find confirmation trace");
  results.push({ name: "skill filter", ok: true });

  const actionFiltered = await listAgentTraces({ action: "draft" });
  assert(actionFiltered.traces.length === 1, "action filter mismatch");
  const transportFiltered = await listAgentTraces({ transport: "ws" });
  assert(transportFiltered.traces.length === 1, "transport filter mismatch");
  const errorFiltered = await listAgentTraces({ hasError: true });
  assert(errorFiltered.traces.length === 1 && errorFiltered.traces[0].error, "error filter mismatch");
  const textFiltered = await listAgentTraces({ q: "发布电机" });
  assert(textFiltered.traces.length === 1, "text filter mismatch");
  results.push({ name: "action transport error q filters", ok: true });

  const detail = await getAgentTrace(all.traces[0].id);
  assert(detail.trace?.id === all.traces[0].id, "trace detail mismatch");
  assert(!Object.hasOwn(detail.trace, "message"), "trace detail must not expose full message field");
  results.push({ name: "trace detail", ok: true });

  process.env.TRAINING_AGENT_TRACE = "0";
  const disabled = await listAgentTraces({ limit: 10 });
  assert(disabled.enabled === false && disabled.traces.length === 0, "disabled trace should return empty list");
  results.push({ name: "trace disabled", ok: true });

  console.log(JSON.stringify({ ok: true, tempDir, total: results.length, results }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    results,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
