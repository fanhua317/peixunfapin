import { generateKnowledgeAnswer } from "../ai/index.mjs";
import { domainError, markInviteExpired } from "./common.mjs";

export async function answerQuestion(state, { token, taskId, question, webSearchMode = "off" }) {
  const invite = token ? state.invites.find((entry) => entry.token === token) : null;
  if (token && !invite) throw domainError(401, "invite not found");
  if (invite && markInviteExpired(invite)) throw domainError(401, "invite expired");
  const task = state.tasks.find((entry) => entry.id === (invite?.taskId || taskId));
  if (!task) throw domainError(404, "task not found");
  return await generateKnowledgeAnswer(state, { knowledgeBaseId: task.knowledgeBaseId, question, webSearchMode });
}
