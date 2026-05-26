import { isAuthenticated } from "./auth.mjs";
import { handleAgent, handleEmployees } from "./controllers/agent-controller.mjs";
import { handleAuth } from "./controllers/auth-controller.mjs";
import { handleHealth } from "./controllers/health-controller.mjs";
import { handleInvites } from "./controllers/invites-controller.mjs";
import { handleKnowledge } from "./controllers/knowledge-controller.mjs";
import { handleAnswer, handleQuiz } from "./controllers/quiz-controller.mjs";
import { handleReports, handleTasks } from "./controllers/tasks-controller.mjs";
import { sendJson } from "./response.mjs";

const authenticatedHandlers = [
  handleHealth,
  handleKnowledge,
  handleReports,
  handleEmployees,
  handleAgent,
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
