import { appendEvent, isoNow, makeId } from "../store.mjs";
import { generateQuizQuestions } from "../ai/index.mjs";
import { markInviteExpired } from "./common.mjs";

export async function generateQuiz(state, taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error("task not found");
  const existing = state.quizzes.find((quiz) => quiz.taskId === taskId);
  if (existing) return existing;

  const aiQuiz = await generateQuizQuestions(state, task);
  const questions = (aiQuiz.questions || []).map((question) => ({
    id: makeId("question"),
    ...question,
  }));
  if (questions.length < task.quizCount) {
    throw new Error(`大模型只生成了 ${questions.length} 道题，少于任务要求的 ${task.quizCount} 道题；已停止出题，未使用本地模板补题。`);
  }
  const quiz = {
    id: makeId("quiz"),
    taskId,
    questions: questions.slice(0, task.quizCount),
    generatedBy: aiQuiz.source || "llm",
    thinking: aiQuiz.thinking,
    model: aiQuiz.model,
    sessionPatch: aiQuiz.sessionPatch,
    runId: aiQuiz.runId,
    createdAt: isoNow(),
  };
  state.quizzes.push(quiz);
  appendEvent(state, "quiz.generated", { taskId, quizId: quiz.id, questionCount: questions.length });
  return quiz;
}

export async function submitQuiz(state, { token, answers }) {
  const invite = state.invites.find((entry) => entry.token === token);
  if (!invite) throw new Error("invite not found");
  const task = state.tasks.find((entry) => entry.id === invite.taskId);
  if (!task) throw new Error("task not found");
  if (markInviteExpired(invite)) {
    throw new Error("invite expired");
  }
  const quiz = await generateQuiz(state, task.id);
  const answerMap = answers && typeof answers === "object" ? answers : {};
  const graded = quiz.questions.map((question) => {
    const submitted = answerMap[question.id];
    const correct = submitted === question.correctAnswer;
    return {
      questionId: question.id,
      prompt: question.prompt,
      submitted,
      correctAnswer: question.correctAnswer,
      correct,
      explanation: question.explanation,
      sourceRef: question.sourceRef,
    };
  });
  const correctCount = graded.filter((entry) => entry.correct).length;
  const score = Math.round((correctCount / quiz.questions.length) * 100);
  const weakPoints = graded.filter((entry) => !entry.correct).map((entry) => entry.sourceRef);
  const previousAttempts = state.attempts.filter((attempt) => attempt.inviteId === invite.id);
  const attempt = {
    id: makeId("attempt"),
    taskId: task.id,
    inviteId: invite.id,
    employeeId: invite.employeeId,
    employeeName: invite.employeeName,
    attemptNumber: previousAttempts.length + 1,
    score,
    passed: score >= task.passScore,
    answers: graded,
    weakPoints: [...new Set(weakPoints)],
    submittedAt: isoNow(),
  };
  state.attempts.push(attempt);
  invite.status = "completed";
  invite.completedAt = isoNow();
  invite.lastAttemptId = attempt.id;
  appendEvent(state, "quiz.submitted", { taskId: task.id, inviteId: invite.id, score });
  return { attempt, quiz };
}
