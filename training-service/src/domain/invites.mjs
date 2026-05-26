import { summarizeKnowledgeBase } from "../rag.mjs";
import { isoNow } from "../store.mjs";
import { markInviteExpired } from "./common.mjs";

function isModelGeneratedMaterial(material) {
  return ["llm-api", "openclaw", "openclaw-text"].includes(String(material?.generatedBy || ""));
}

export function openInvite(state, token) {
  const invite = state.invites.find((entry) => entry.token === token);
  if (!invite) return null;
  const expired = markInviteExpired(invite);
  if (!expired) {
    if (!invite.openedAt) invite.openedAt = isoNow();
    if (invite.status === "created") invite.status = "opened";
  }
  const task = state.tasks.find((entry) => entry.id === invite.taskId);
  const knowledgeBase = state.knowledgeBases.find((entry) => entry.id === task?.knowledgeBaseId);
  const trainingMaterial = isModelGeneratedMaterial(task?.trainingMaterial) ? task.trainingMaterial : null;
  return {
    invite,
    task,
    knowledgeBase,
    trainingMaterial,
    expired,
    summary: trainingMaterial?.summary || (task ? summarizeKnowledgeBase(state, task.knowledgeBaseId) : ""),
  };
}
