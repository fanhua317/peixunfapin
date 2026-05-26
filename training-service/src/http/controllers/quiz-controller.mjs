import { answerQuestion, generateQuiz, submitQuiz } from "../../domain/index.mjs";
import { loadState, mutateState } from "../../store.mjs";
import { readBody } from "../request.mjs";
import { sendJson } from "../response.mjs";

export async function handleAnswer(req, res, url) {
  if (req.method !== "POST" || url.pathname !== "/api/answer") return false;
  const body = await readBody(req);
  const state = await loadState();
  sendJson(res, 200, await answerQuestion(state, body));
  return true;
}

export async function handleQuiz(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/quiz/generate") {
    const body = await readBody(req);
    const quiz = await mutateState((state) => generateQuiz(state, body.taskId));
    sendJson(res, 200, { quiz });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/quiz/submit") {
    const body = await readBody(req);
    try {
      const result = await mutateState((state) => submitQuiz(state, body));
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
