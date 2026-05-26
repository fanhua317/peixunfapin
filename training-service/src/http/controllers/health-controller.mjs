import { getRuntimeHealth } from "../../health.mjs";
import { dataDir, loadState } from "../../store.mjs";
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
    retrievalMode: runtime.retrievalMode,
    dataDir,
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
