import { getKnowledgeBaseQuality } from "../quality.mjs";
import { includesAny } from "./common.mjs";

export function listKnowledgeBases(state) {
  return state.knowledgeBases.map((kb) => ({
    id: kb.id,
    name: kb.name,
    aliases: kb.aliases || [],
    description: kb.description || "",
    version: kb.version || "",
    status: kb.status,
    quality: getKnowledgeBaseQuality(state, kb.id),
  }));
}

export function matchKnowledgeBase(state, text) {
  const candidates = state.knowledgeBases.filter((kb) => {
    const aliases = kb.aliases || [];
    return includesAny(text, [kb.name, ...aliases]);
  });
  if (candidates[0]) return candidates[0];
  const imported = state.knowledgeBases.filter((kb) => kb.status === "ready" && !String(kb.id || "").includes("a-product"));
  if (imported.length === 1 && /(资料|我的|全部|所有|全员|全体|员工|人员)/.test(String(text || ""))) {
    return imported[0];
  }
  return null;
}
