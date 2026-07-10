import { appendEvent, isoNow, makeId, makeToken } from "../store.mjs";
import { generateTrainingMaterial } from "../ai/index.mjs";
import { domainError, isExpiredAt, latestAttempts } from "./common.mjs";

function ensureArrays(state) {
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  state.invites = Array.isArray(state.invites) ? state.invites : [];
  state.quizzes = Array.isArray(state.quizzes) ? state.quizzes : [];
  state.attempts = Array.isArray(state.attempts) ? state.attempts : [];
  state.events = Array.isArray(state.events) ? state.events : [];
}

function includesQuery(value, query) {
  return String(value || "").toLowerCase().includes(String(query || "").toLowerCase());
}

function taskMatchesDeleteQuery(state, task, query) {
  const text = String(query || "").trim();
  if (!text) return true;
  if (includesQuery(task.id, text) || includesQuery(task.title, text) || includesQuery(task.instruction, text) || includesQuery(task.knowledgeBaseName, text)) {
    return true;
  }
  return state.invites
    .filter((invite) => invite.taskId === task.id)
    .some((invite) => includesQuery(invite.employeeName, text) || includesQuery(invite.token, text));
}

function shouldDeleteAllTrainingRecords(query) {
  const text = String(query || "").trim();
  if (!text) return true;
  if (/(之前|历史|全部|所有|所有的|当前|已有|已发布|清空)/.test(text)) return true;
  const remainder = text
    .replace(/(删除|删掉|移除|清除|清理|作废|撤销|把|将|请|一下|掉)/g, "")
    .replace(/(培训记录|培训任务|任务记录|学习记录|考试记录|记录|任务|培训)/g, "")
    .trim();
  return remainder.length === 0;
}

function knowledgeRevision(state, knowledgeBaseId) {
  const knowledgeBase = state.knowledgeBases.find((entry) => entry.id === knowledgeBaseId);
  if (!knowledgeBase) return "missing";
  const documentCount = state.documents.filter((entry) => entry.knowledgeBaseId === knowledgeBaseId).length;
  const chunkCount = state.chunks.filter((entry) => entry.knowledgeBaseId === knowledgeBaseId).length;
  return JSON.stringify([
    knowledgeBase.id,
    knowledgeBase.activeVersionId || knowledgeBase.updatedAt || knowledgeBase.importedAt || "",
    documentCount,
    chunkCount,
  ]);
}

function conflict(message) {
  return domainError(409, message);
}

export async function prepareTaskPublication(state, draft, { webSearchMode = "off" } = {}) {
  if (!draft || !draft.knowledgeBase?.id) {
    throw domainError(400, "draft.knowledgeBase.id required");
  }
  if (knowledgeRevision(state, draft.knowledgeBase.id) === "missing") {
    throw domainError(404, "knowledge base not found");
  }
  const draftEmployees = Array.isArray(draft.employees) ? draft.employees : [];
  const temporaryEmployees = Array.isArray(draft.unmatchedEmployees)
    ? [...new Set(draft.unmatchedEmployees.map((employee) => String(employee?.name || "").trim()).filter(Boolean))]
      .map((name) => ({
        id: null,
        name,
        department: "未入库",
        role: "临时学习人",
        temporary: true,
      }))
    : [];
  const publishEmployees = draftEmployees.length ? draftEmployees : temporaryEmployees;
  if (publishEmployees.length === 0) {
    throw domainError(400, "draft.employees required");
  }

  const taskId = makeId("task");
  const task = {
    id: taskId,
    title: draft.title || "培训任务",
    instruction: draft.instruction || "",
    knowledgeBaseId: draft.knowledgeBase.id,
    knowledgeBaseName: draft.knowledgeBase.name,
    deadline: draft.deadline,
    quizCount: Number(draft.quizCount) || 10,
    passScore: Number(draft.passScore) || 80,
    quizType: draft.quizType || "single_choice",
    status: "published",
    createdBy: "boss",
    createdAt: isoNow(),
  };
  task.trainingMaterial = await generateTrainingMaterial(state, task, { webSearchMode });

  const invites = publishEmployees.map((employee) => {
    const invite = {
      id: makeId("invite"),
      taskId,
      employeeId: employee.id || null,
      employeeName: employee.name,
      temporary: employee.temporary === true,
      token: makeToken(),
      status: "created",
      expiresAt: draft.deadline,
      openedAt: null,
      completedAt: null,
    };
    return invite;
  });

  return {
    task,
    invites,
    knowledgeRevision: knowledgeRevision(state, draft.knowledgeBase.id),
  };
}

export function commitTaskPublication(state, prepared) {
  ensureArrays(state);
  if (!prepared?.task || !Array.isArray(prepared.invites)) throw new Error("prepared publication required");
  if (state.tasks.some((task) => task.id === prepared.task.id)) {
    return {
      task: state.tasks.find((task) => task.id === prepared.task.id),
      invites: state.invites.filter((invite) => invite.taskId === prepared.task.id),
    };
  }
  if (knowledgeRevision(state, prepared.task.knowledgeBaseId) !== prepared.knowledgeRevision) {
    throw conflict("knowledge base changed while publishing; please retry");
  }
  state.tasks.push(prepared.task);
  state.invites.push(...prepared.invites);

  appendEvent(state, "task.published", {
    taskId: prepared.task.id,
    inviteCount: prepared.invites.length,
    materialGeneratedBy: prepared.task.trainingMaterial?.generatedBy || "unknown",
  });
  return { task: prepared.task, invites: prepared.invites };
}

export async function publishTask(state, draft, options = {}) {
  return commitTaskPublication(state, await prepareTaskPublication(state, draft, options));
}

export function deleteTrainingRecords(state, options = {}) {
  ensureArrays(state);
  const query = String(options.query || options.instruction || "").trim();
  const matchedTasks = shouldDeleteAllTrainingRecords(query)
    ? [...state.tasks]
    : state.tasks.filter((task) => taskMatchesDeleteQuery(state, task, query));
  const taskIds = new Set(matchedTasks.map((task) => task.id));
  const before = {
    tasks: state.tasks.length,
    invites: state.invites.length,
    quizzes: state.quizzes.length,
    attempts: state.attempts.length,
  };

  if (taskIds.size > 0) {
    state.tasks = state.tasks.filter((task) => !taskIds.has(task.id));
    state.invites = state.invites.filter((invite) => !taskIds.has(invite.taskId));
    state.quizzes = state.quizzes.filter((quiz) => !taskIds.has(quiz.taskId));
    state.attempts = state.attempts.filter((attempt) => !taskIds.has(attempt.taskId));
  }

  const deleted = {
    tasks: before.tasks - state.tasks.length,
    invites: before.invites - state.invites.length,
    quizzes: before.quizzes - state.quizzes.length,
    attempts: before.attempts - state.attempts.length,
  };
  appendEvent(state, "task.records_deleted", {
    instruction: query,
    taskIds: [...taskIds],
    deleted,
  });
  return {
    action: "delete_records",
    deleted,
    taskIds: [...taskIds],
    remainingTasks: state.tasks.length,
  };
}

export function getTaskStatus(state, taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) return null;
  const invites = state.invites.filter((invite) => invite.taskId === taskId);
  const attempts = state.attempts.filter((attempt) => attempt.taskId === taskId);
  const latest = latestAttempts(attempts);
  const completed = invites.filter((invite) => invite.status === "completed").length;
  const expired = invites.filter((invite) => invite.status === "expired" || (invite.status !== "completed" && isExpiredAt(invite.expiresAt))).length;
  const scores = latest.map((attempt) => attempt.score).filter((score) => typeof score === "number");
  const averageScore = scores.length
    ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
    : null;
  const weakPointCounts = new Map();
  for (const attempt of latest) {
    for (const sourceRef of attempt.weakPoints || []) {
      const key = String(sourceRef || "").trim();
      if (key) weakPointCounts.set(key, (weakPointCounts.get(key) || 0) + 1);
    }
  }
  const weakPoints = [...weakPointCounts.entries()]
    .map(([sourceRef, count]) => ({ sourceRef, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 10);

  return {
    task,
    invites,
    attempts,
    latestAttempts: latest,
    summary: {
      total: invites.length,
      opened: invites.filter((invite) => invite.openedAt).length,
      completed,
      expired,
      pending: invites.length - completed,
      averageScore,
      passCount: latest.filter((attempt) => attempt.passed).length,
      failCount: latest.filter((attempt) => attempt.passed === false).length,
      pendingEmployees: invites
        .filter((invite) => invite.status !== "completed")
        .map((invite) => ({
          employeeName: invite.employeeName,
          status: invite.status,
          expired: invite.status === "expired" || (invite.status !== "completed" && isExpiredAt(invite.expiresAt)),
        })),
      weakPoints,
    },
  };
}
