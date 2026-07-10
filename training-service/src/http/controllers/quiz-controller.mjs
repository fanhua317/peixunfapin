import { answerQuestion, commitQuiz, prepareQuiz, submitQuiz } from "../../domain/index.mjs";
import { normalizeWebSearchMode } from "../../ai/web-search.mjs";
import { markInviteExpired } from "../../domain/common.mjs";
import { loadState, mutateState } from "../../store.mjs";
import { readBody } from "../request.mjs";
import { sendJson } from "../response.mjs";

async function authorizeCandidate(body, authenticated) {
  if (!body.token) {
    return authenticated ? { taskId: body.taskId } : { error: "invite token required" };
  }
  return await mutateState((state) => {
    const invite = state.invites.find((entry) => entry.token === body.token);
    if (!invite) return { error: "invalid invite token" };
    if (markInviteExpired(invite)) return { error: "invite expired" };
    return { taskId: invite.taskId };
  });
}

async function ensureQuiz(taskId, webSearchMode) {
  const prepared = await prepareQuiz(await loadState(), taskId, { webSearchMode });
  return await mutateState((state) => commitQuiz(state, prepared));
}

export async function handleAnswer(req, res, url, context = {}) {
  if (req.method !== "POST" || url.pathname !== "/api/answer") return false;
  const body = await readBody(req);
  const capability = await authorizeCandidate(body, context.authenticated === true);
  if (capability.error) {
    sendJson(res, 401, { error: capability.error });
    return true;
  }
  const state = await loadState();
  sendJson(res, 200, await answerQuestion(state, { ...body, taskId: capability.taskId }));
  return true;
}

export async function handleQuiz(req, res, url, context = {}) {
  if (req.method === "POST" && url.pathname === "/api/quiz/generate") {
    const body = await readBody(req);
    const capability = await authorizeCandidate(body, context.authenticated === true);
    if (capability.error) {
      sendJson(res, 401, { error: capability.error });
      return true;
    }
    const quiz = await ensureQuiz(capability.taskId, normalizeWebSearchMode(body.webSearchMode));
    sendJson(res, 200, { quiz });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/quiz/submit") {
    const body = await readBody(req);
    try {
      const capability = await authorizeCandidate(body, context.authenticated === true);
      if (capability.error) {
        sendJson(res, 401, { error: capability.error });
        return true;
      }
      await ensureQuiz(capability.taskId, "off");
      const result = await mutateState((state) => submitQuiz(state, body));
      sendJson(res, 200, result);
    } catch (error) {
      const status = error?.statusCode || (/invite expired/i.test(String(error?.message || "")) ? 401 : 400);
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
