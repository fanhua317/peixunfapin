import { isAuthenticated } from "./auth.mjs";
import { handleAgent, handleEmployees } from "./controllers/agent-controller.mjs";
import { handleAuth } from "./controllers/auth-controller.mjs";
import { handleHealth } from "./controllers/health-controller.mjs";
import { handleImports } from "./controllers/imports-controller.mjs";
import { handleInvites } from "./controllers/invites-controller.mjs";
import { handleJobs } from "./controllers/jobs-controller.mjs";
import { handleKnowledge } from "./controllers/knowledge-controller.mjs";
import { handleMemory } from "./controllers/memory-controller.mjs";
import { handleAnswer, handleQuiz } from "./controllers/quiz-controller.mjs";
import { handleReports, handleTasks } from "./controllers/tasks-controller.mjs";
import { handleTraces } from "./controllers/traces-controller.mjs";
import { sendJson } from "./response.mjs";

const authenticatedHandlers = [
  handleHealth,
  handleJobs,
  handleTraces,
  handleImports,
  handleKnowledge,
  handleReports,
  handleEmployees,
  handleAgent,
  handleMemory,
  handleTasks,
  handleInvites,
  handleAnswer,
  handleQuiz,
];

export async function handleApi(req, res, url, context) {
  if (await handleAuth(req, res, url, context)) return;

  if (!isAuthenticated(req)) {
    sendJson(res, 401, { error: "access key required" });
    return;
  }

  for (const handler of authenticatedHandlers) {
    if (await handler(req, res, url, context)) return;
  }

  sendJson(res, 404, { error: "not found" });
}
