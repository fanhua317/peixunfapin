import { getRuntimeHealth } from "../../health.mjs";
import { getOpenTelemetryStatus } from "../../observability/telemetry.mjs";
import { dataDir, getStorageStatus, loadState } from "../../store.mjs";
import { sendJson } from "../response.mjs";

export async function handleHealth(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/api/health") return false;

  let state = null;
  let stateError = "";
  try {
    state = await loadState();
  } catch (error) {
    stateError = error instanceof Error ? error.message : String(error);
  }
  const runtime = await getRuntimeHealth(state || undefined);
  const openTelemetry = getOpenTelemetryStatus();
  sendJson(res, 200, {
    ok: !stateError,
    service: "juzhou-agent-training-service",
    stateOk: !stateError,
    stateError,
    qdrantOk: runtime.qdrantOk,
    ollamaOk: runtime.ollamaOk,
    localVectorIndexOk: runtime.localVectorIndexOk,
    openclawRuntimeOk: runtime.openclawRuntimeOk,
    llmProvider: runtime.llmProvider,
    llmConfigured: runtime.llmConfigured,
    rerankerOk: runtime.rerankerOk,
    retrievalMode: runtime.retrievalMode,
    openTelemetryOk: openTelemetry.enabled ? openTelemetry.initialized : null,
    openTelemetry,
    dataDir,
    storage: getStorageStatus(),
    counts: state ? {
      knowledgeBases: state.knowledgeBases?.length || 0,
      documents: state.documents?.length || 0,
      chunks: state.chunks?.length || 0,
      tasks: state.tasks?.length || 0,
      invites: state.invites?.length || 0,
      quizzes: state.quizzes?.length || 0,
      attempts: state.attempts?.length || 0,
    } : null,
    runtime,
  });
  return true;
}
