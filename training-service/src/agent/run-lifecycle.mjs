import { appendAgentTrace } from "../agent-trace.mjs";
import { failRun, finishRun, recordRunStep } from "../agent-runs/store.mjs";
import { finalizeCurrentObservability } from "../observability/context.mjs";

export async function finalizeAgentRun({
  run,
  startedAt,
  transport,
  route,
  message,
  confirmedSkill = "",
  confirmationToken = "",
  confirmation = null,
  decision = null,
  payload = null,
  error = null,
}) {
  const latencyMs = Date.now() - startedAt;
  const payloadError = payload?.error ? String(payload.error) : "";
  if (payload) {
    await recordRunStep(run.id, "result_output", payload?.action || "response", async () => payload, (result) => ({
      action: result?.action || "",
      statusCode: result?.error ? 503 : 200,
    }));
  }
  const runStatus = error || payloadError ? "failed" : "succeeded";
  const observability = finalizeCurrentObservability({
    status: runStatus,
    skill: decision?.skill || decision?.intent || confirmedSkill,
    action: payload?.action || (runStatus === "failed" ? "error" : ""),
  });
  if (error || payloadError) {
    await failRun(run.id, error || payloadError, {
      decision,
      latencyMs,
      summary: observability ? { observability } : {},
    });
  } else {
    await finishRun(run.id, {
      decision,
      result: payload,
      action: payload?.action || "",
      confirmationVerified: confirmation?.ok === true,
      latencyMs,
      summary: {
        reason: decision?.reason || "",
        ...(observability ? { observability } : {}),
      },
    });
  }
  await appendAgentTrace({
    runId: run.id,
    transport,
    route,
    message,
    confirmedSkill,
    confirmationTokenPresent: Boolean(confirmationToken),
    confirmationVerified: confirmation?.ok === true,
    decision,
    result: payload,
    error: error ? (error instanceof Error ? error.message : String(error)) : payloadError || undefined,
    latencyMs,
  });
}
