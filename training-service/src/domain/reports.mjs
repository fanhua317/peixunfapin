import { isoNow } from "../store.mjs";
import { latestAttempts } from "./common.mjs";
import { getTaskStatus } from "./tasks.mjs";

export function getReportsOverview(state) {
  const taskStatuses = state.tasks.map((task) => getTaskStatus(state, task.id)).filter(Boolean);
  const latest = latestAttempts(state.attempts || []);
  const totalInvites = (state.invites || []).length;
  const completedInvites = (state.invites || []).filter((invite) => invite.status === "completed").length;
  const openedInvites = (state.invites || []).filter((invite) => invite.openedAt).length;
  const scores = latest.map((attempt) => attempt.score).filter((score) => typeof score === "number");
  const scoreBuckets = {
    "0-59": scores.filter((score) => score < 60).length,
    "60-79": scores.filter((score) => score >= 60 && score < 80).length,
    "80-100": scores.filter((score) => score >= 80).length,
  };
  const weakPointCounts = new Map();
  for (const attempt of latest) {
    for (const sourceRef of attempt.weakPoints || []) {
      const key = String(sourceRef || "").trim();
      if (key) weakPointCounts.set(key, (weakPointCounts.get(key) || 0) + 1);
    }
  }
  return {
    generatedAt: isoNow(),
    totals: {
      tasks: taskStatuses.length,
      invites: totalInvites,
      opened: openedInvites,
      completed: completedInvites,
      pending: totalInvites - completedInvites,
      attempts: latest.length,
      passCount: latest.filter((attempt) => attempt.passed).length,
      failCount: latest.filter((attempt) => attempt.passed === false).length,
      averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
      completionRate: totalInvites ? Math.round((completedInvites / totalInvites) * 100) : 0,
    },
    scoreBuckets,
    weakPoints: [...weakPointCounts.entries()]
      .map(([sourceRef, count]) => ({ sourceRef, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 20),
    tasks: taskStatuses.map((status) => ({
      taskId: status.task.id,
      title: status.task.title,
      knowledgeBaseName: status.task.knowledgeBaseName,
      createdAt: status.task.createdAt,
      deadline: status.task.deadline,
      summary: status.summary,
    })),
  };
}
