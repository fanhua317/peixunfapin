import { listKnowledgeBases } from "../../domain/index.mjs";
import { getRuntimeHealth, getVectorIndexStatus } from "../../health.mjs";
import { getKnowledgeBaseQuality } from "../../quality.mjs";
import { loadState } from "../../store.mjs";
import { sendJson } from "../response.mjs";

export async function handleKnowledge(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/knowledge-bases") {
    const state = await loadState();
    sendJson(res, 200, { knowledgeBases: listKnowledgeBases(state) });
    return true;
  }

  const qualityMatch = url.pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/quality$/);
  if (req.method === "GET" && qualityMatch) {
    const state = await loadState();
    const runtime = await getRuntimeHealth(state);
    const knowledgeBaseId = decodeURIComponent(qualityMatch[1]);
    const vectorIndex = await getVectorIndexStatus(state, knowledgeBaseId, runtime);
    sendJson(res, 200, {
      quality: getKnowledgeBaseQuality(state, knowledgeBaseId, vectorIndex),
      retrievalMode: runtime.retrievalMode,
    });
    return true;
  }

  return false;
}
