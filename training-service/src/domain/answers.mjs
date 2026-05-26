import { generateKnowledgeAnswer } from "../ai/index.mjs";

export async function answerQuestion(state, { token, taskId, question }) {
  const invite = token ? state.invites.find((entry) => entry.token === token) : null;
  const task = state.tasks.find((entry) => entry.id === (taskId || invite?.taskId));
  if (!task) throw new Error("task not found");
  return await generateKnowledgeAnswer(state, { knowledgeBaseId: task.knowledgeBaseId, question });
}
