import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-tool-observability-eval-"));
process.env.TRAINING_DATA_DIR = dataDir;
process.env.TRAINING_STORAGE = "json";

const results = [];

try {
  const { getRun, recordRunStep, startRun } = await import("../src/agent-runs/store.mjs");
  const {
    getCurrentObservabilitySnapshot,
    withAgentRunObservability,
  } = await import("../src/observability/context.mjs");

  const run = await startRun({
    sessionId: "tool-observability-eval",
    transport: "test",
    route: "eval:tool-observability",
    message: "verify resolved tool failure payloads",
  });
  let snapshot = null;
  await withAgentRunObservability({ runId: run.id, transport: "test", route: "eval:tool-observability" }, async () => {
    const cases = [
      { name: "success", payload: { ok: true }, expectedStatus: "succeeded" },
      { name: "payload-error", payload: { error: "provider rejected request" }, expectedStatus: "failed" },
      { name: "ok-false", payload: { ok: false, reason: "business rule rejected" }, expectedStatus: "failed" },
      { name: "http-failure", payload: { statusCode: 503, message: "upstream unavailable" }, expectedStatus: "failed" },
      { name: "business-failure", payload: { status: "failed", reason: "validation failed" }, expectedStatus: "failed" },
    ];
    for (const item of cases) {
      const returned = await recordRunStep(run.id, "tool_execute", item.name, async () => item.payload, (payload) => ({
        returnedOk: payload.ok ?? null,
      }));
      assert(returned === item.payload, `${item.name}: recordRunStep must preserve the tool payload`);
    }
    snapshot = getCurrentObservabilitySnapshot();
  });

  const stored = await getRun(run.id);
  const steps = new Map(stored.steps.map((step) => [step.name, step]));
  assert(steps.get("success")?.status === "succeeded", "successful tool step was not stored as succeeded");
  for (const name of ["payload-error", "ok-false", "http-failure", "business-failure"]) {
    assert(steps.get(name)?.status === "failed", `${name}: resolved failure payload was stored as succeeded`);
    assert(Boolean(steps.get(name)?.error), `${name}: failed tool step did not retain a failure reason`);
  }
  assert(snapshot.tools.calls === 5, `expected 5 tool calls, got ${snapshot.tools.calls}`);
  assert(snapshot.tools.succeeded === 1, `expected 1 successful tool call, got ${snapshot.tools.succeeded}`);
  assert(snapshot.tools.failed === 4, `expected 4 failed tool calls, got ${snapshot.tools.failed}`);
  assert(snapshot.tools.successRate === 0.2, `expected tool successRate=0.2, got ${snapshot.tools.successRate}`);
  results.push({ id: "resolved-tool-failures", ok: true, tools: snapshot.tools });
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  console.error(error);
  console.log(JSON.stringify({ ok: false, results }, null, 2));
  process.exitCode = 1;
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
