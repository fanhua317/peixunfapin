import { isAuthenticated } from "./auth.mjs";
import { handleAgent, handleEmployees } from "./controllers/agent-controller.mjs";
import { handleAgentRuns } from "./controllers/agent-runs-controller.mjs";
import { handleAuth } from "./controllers/auth-controller.mjs";
import { handleBossChat } from "./controllers/boss-chat-controller.mjs";
import { handleHealth } from "./controllers/health-controller.mjs";
import { handleImports } from "./controllers/imports-controller.mjs";
import { handleInvites } from "./controllers/invites-controller.mjs";
import { handleJobs } from "./controllers/jobs-controller.mjs";
import { handleKnowledge } from "./controllers/knowledge-controller.mjs";
import { handleMemory } from "./controllers/memory-controller.mjs";
import { handleAnswer, handleQuiz } from "./controllers/quiz-controller.mjs";
import { handleReports, handleTasks } from "./controllers/tasks-controller.mjs";
import { handleTools } from "./controllers/tools-controller.mjs";
import { handleTraces } from "./controllers/traces-controller.mjs";
import { sendJson } from "./response.mjs";

const authenticatedHandlers = [
  handleHealth,
  handleAgentRuns,
  handleBossChat,
  handleTools,
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

const candidateHandlers = [handleInvites, handleAnswer, handleQuiz];

export async function handleApi(req, res, url, context) {
  if (await handleAuth(req, res, url, context)) return;

  const authenticated = isAuthenticated(req);
  const requestContext = { ...context, authenticated };

  if (!authenticated) {
    for (const handler of candidateHandlers) {
      if (await handler(req, res, url, requestContext)) return;
    }
    sendJson(res, 401, { error: "access key required" });
    return;
  }

  for (const handler of authenticatedHandlers) {
    if (await handler(req, res, url, requestContext)) return;
  }

  sendJson(res, 404, { error: "not found" });
}
