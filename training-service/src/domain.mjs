import { appendEvent, isoNow, makeId, makeToken } from "./store.mjs";
import { searchChunks, summarizeKnowledgeBase } from "./rag.mjs";
import { generateKnowledgeAnswer, generateQuizQuestions, generateTrainingMaterial } from "./training-ai.mjs";
import { chunkToLearningPoints, cleanQuestionText, getKnowledgeBaseQuality, isUsableTrainingChunk } from "./quality.mjs";

function includesAny(source, values) {
  const text = String(source || "").toLowerCase();
  return values.some((value) => value && text.includes(String(value).toLowerCase()));
}

function parseNumberBefore(text, keywords, fallback) {
  for (const keyword of keywords) {
    const pattern = new RegExp(`(\\d+)\\s*(?:道|个|条)?\\s*${keyword}`);
    const match = String(text || "").match(pattern);
    if (match) return Number(match[1]);
  }
  const generic = String(text || "").match(/(\\d+)\\s*道/);
  return generic ? Number(generic[1]) : fallback;
}

function parsePassScore(text, fallback = 80) {
  const match = String(text || "").match(/(\\d+)\\s*分(?:及格|通过|合格)/);
  return match ? Number(match[1]) : fallback;
}

function parseDeadline(text) {
  const value = String(text || "");
  const now = new Date();
  if (value.includes("明天")) {
    const deadline = new Date(now);
    deadline.setDate(deadline.getDate() + 1);
    const hourMatch = value.match(/明天.*?(上午|下午|晚上)?\s*(\d{1,2})\s*点/);
    if (hourMatch) {
      let hour = Number(hourMatch[2]);
      if ((hourMatch[1] === "下午" || hourMatch[1] === "晚上") && hour < 12) hour += 12;
      deadline.setHours(hour, 0, 0, 0);
    } else {
      deadline.setHours(18, 0, 0, 0);
    }
    return deadline.toISOString();
  }
  if (value.includes("本周五")) {
    const deadline = new Date(now);
    const day = deadline.getDay() || 7;
    deadline.setDate(deadline.getDate() + (5 - day));
    deadline.setHours(18, 0, 0, 0);
    return deadline.toISOString();
  }
  const dateMatch = value.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (dateMatch) {
    const deadline = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), 18, 0, 0, 0);
    return deadline.toISOString();
  }
  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() + 7);
  fallback.setHours(18, 0, 0, 0);
  return fallback.toISOString();
}

function parseRequestedAudience(text) {
  const value = String(text || "").trim();
  const match = value.match(/给\s*([^\n，。；;,.]+?)\s*(?:发布|安排|创建|新建|布置|分配|指派|生成|制定|做|建|培训|学习|考试|课程)/);
  const source = match ? match[1] : "";
  return [...new Set(source
    .split(/(?:和|、|，|,|\/|\s+)/)
    .map((name) => name.trim())
    .filter((name) => name && !/^(全部|所有|全员|全体|员工|人员|大家)$/.test(name)))]
    .slice(0, 10);
}

function isExpiredAt(value, now = new Date()) {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() < now.getTime();
}

function markInviteExpired(invite, now = new Date()) {
  if (!invite || invite.status === "completed") return false;
  if (!isExpiredAt(invite.expiresAt, now)) return false;
  invite.status = "expired";
  return true;
}

function latestAttempts(attempts) {
  const latest = new Map();
  for (const attempt of attempts) {
    const key = attempt.inviteId || `${attempt.taskId}:${attempt.employeeId || attempt.employeeName}`;
    const current = latest.get(key);
    if (!current || String(attempt.submittedAt || "") > String(current.submittedAt || "")) {
      latest.set(key, attempt);
    }
  }
  return [...latest.values()];
}

export function listKnowledgeBases(state) {
  return state.knowledgeBases.map((kb) => ({
    id: kb.id,
    name: kb.name,
    aliases: kb.aliases || [],
    description: kb.description || "",
    version: kb.version || "",
    status: kb.status,
    quality: getKnowledgeBaseQuality(state, kb.id),
  }));
}

export function searchEmployees(state, query) {
  const normalized = String(query || "").trim();
  if (!normalized) return state.employees.filter((employee) => employee.status === "active");
  if (/(全部|所有|全员|全体|员工|人员|大家)/.test(normalized)) {
    return state.employees.filter((employee) => employee.status === "active");
  }

  return state.employees.filter((employee) => {
    const aliases = employee.aliases || [];
    return (
      employee.status === "active" &&
      (includesAny(normalized, [employee.name, employee.department, employee.role, ...aliases]) ||
        includesAny(`${employee.name} ${employee.department} ${employee.role} ${aliases.join(" ")}`, [normalized]))
    );
  });
}

export function matchKnowledgeBase(state, text) {
  const candidates = state.knowledgeBases.filter((kb) => {
    const aliases = kb.aliases || [];
    return includesAny(text, [kb.name, ...aliases]);
  });
  if (candidates[0]) return candidates[0];
  const imported = state.knowledgeBases.filter((kb) => kb.status === "ready" && !String(kb.id || "").includes("a-product"));
  if (imported.length === 1 && /(资料|我的|全部|所有|全员|全体|员工|人员)/.test(String(text || ""))) {
    return imported[0];
  }
  return null;
}

export function createTaskDraft(state, instruction) {
  const text = String(instruction || "").trim();
  const knowledgeBase = matchKnowledgeBase(state, text);
  const employees = searchEmployees(state, text);
  const requestedAudience = parseRequestedAudience(text);
  const unmatchedEmployees = employees.length === 0
    ? requestedAudience.map((name) => ({
        name,
        department: "未入库",
        role: "临时学习人",
      }))
    : [];
  const quizCount = parseNumberBefore(text, ["选择题", "判断题", "题"], 10);
  const passScore = parsePassScore(text, 80);
  const deadline = parseDeadline(text);
  const titleBase = knowledgeBase ? knowledgeBase.name.replace(/资料库$/, "") : "培训任务";
  const title = knowledgeBase ? (titleBase.endsWith("培训") ? titleBase : `${titleBase}培训`) : titleBase;
  const quality = knowledgeBase ? getKnowledgeBaseQuality(state, knowledgeBase.id) : null;

  return {
    id: makeId("draft"),
    instruction: text,
    title,
    knowledgeBase: knowledgeBase
      ? {
          id: knowledgeBase.id,
          name: knowledgeBase.name,
          description: knowledgeBase.description,
          quality,
        }
      : null,
    employees: employees.map((employee) => ({
      id: employee.id,
      name: employee.name,
      department: employee.department,
      role: employee.role,
    })),
    unmatchedEmployees,
    deadline,
    quizCount,
    passScore,
    quizType: text.includes("判断") ? "true_false" : "single_choice",
    requiresConfirmation: true,
    confirmationText: `请确认培训任务：${title}，对象 ${employees.length} 人，题目 ${quizCount} 道，通过分数 ${passScore} 分。`,
    warnings: [
      ...(!knowledgeBase ? ["未明确匹配到知识库，将无法发布。"] : []),
      ...(quality?.warnings?.length ? quality.warnings.slice(0, 3) : []),
      ...(employees.length === 0 ? [unmatchedEmployees.length
        ? `未匹配到员工：${unmatchedEmployees.map((employee) => employee.name).join("、")}。可重新输入姓名/分组，或确认后生成临时学习链接。`
        : "未匹配到员工，请检查姓名或分组。"] : []),
    ],
  };
}

export async function publishTask(state, draft) {
  if (!draft || !draft.knowledgeBase?.id) {
    throw new Error("draft.knowledgeBase.id required");
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
  const publishEmployees = draftEmployees.length ? draftEmployees : draft.allowUnmatchedEmployees ? temporaryEmployees : [];
  if (publishEmployees.length === 0) {
    throw new Error("draft.employees required");
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
  task.trainingMaterial = await generateTrainingMaterial(state, task);
  state.tasks.push(task);

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
    state.invites.push(invite);
    return invite;
  });

  appendEvent(state, "task.published", {
    taskId,
    inviteCount: invites.length,
    materialGeneratedBy: task.trainingMaterial?.generatedBy || "unknown",
  });
  return { task, invites };
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

export function openInvite(state, token) {
  const invite = state.invites.find((entry) => entry.token === token);
  if (!invite) return null;
  const expired = markInviteExpired(invite);
  if (!expired) {
    if (!invite.openedAt) invite.openedAt = isoNow();
    if (invite.status === "created") invite.status = "opened";
  }
  const task = state.tasks.find((entry) => entry.id === invite.taskId);
  const knowledgeBase = state.knowledgeBases.find((entry) => entry.id === task?.knowledgeBaseId);
  const trainingMaterial = task?.trainingMaterial || null;
  return {
    invite,
    task,
    knowledgeBase,
    trainingMaterial,
    expired,
    summary: trainingMaterial?.summary || (task ? summarizeKnowledgeBase(state, task.knowledgeBaseId) : ""),
  };
}

export async function answerQuestion(state, { token, taskId, question }) {
  const invite = token ? state.invites.find((entry) => entry.token === token) : null;
  const task = state.tasks.find((entry) => entry.id === (taskId || invite?.taskId));
  if (!task) throw new Error("task not found");
  return await generateKnowledgeAnswer(state, { knowledgeBaseId: task.knowledgeBaseId, question });
}

function buildQuestionFromChunk(chunk, index, quizType) {
  const points = chunkToLearningPoints(chunk, 3);
  const correctOption = cleanQuestionText(points[0] || chunk.content || "资料中的说法符合培训要求", 72);
  const sourceRef = chunk.sourceRef || "培训资料";
  if (quizType === "true_false") {
    const correct = index % 2 === 0;
    return {
      id: makeId("question"),
      type: "true_false",
      prompt: correct
        ? `判断题：${correctOption}`
        : "判断题：培训资料中的产品知识与实际销售、选型或服务沟通无关。",
      options: ["正确", "错误"],
      correctAnswer: correct ? "正确" : "错误",
      explanation: `参考资料：${sourceRef}。${correctOption}`,
      sourceRef,
    };
  }

  return {
    id: makeId("question"),
    type: "single_choice",
    prompt: `根据资料，关于${cleanQuestionText(chunk.heading || chunk.metadata?.section || "培训内容", 30)}，以下哪项最符合要求？`,
    options: [
      correctOption,
      "忽略客户问题，直接推进成交。",
      "只介绍价格，不需要说明售后。",
      "不需要根据资料回答客户问题。",
    ],
    correctAnswer: correctOption,
    explanation: `正确答案来自：${sourceRef}。`,
    sourceRef,
  };
}

export async function generateQuiz(state, taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error("task not found");
  const existing = state.quizzes.find((quiz) => quiz.taskId === taskId);
  if (existing) return existing;

  const chunks = searchChunks(state, {
    knowledgeBaseId: task.knowledgeBaseId,
    query: `${task.title} ${task.instruction}`,
    limit: task.quizCount,
  });
  const fallbackChunks = state.chunks.filter((chunk) => chunk.knowledgeBaseId === task.knowledgeBaseId).filter(isUsableTrainingChunk);
  const sourceChunks = chunks.length ? chunks : fallbackChunks;
  if (!sourceChunks.length) throw new Error("knowledge base has no usable chunks");
  const aiQuiz = await generateQuizQuestions(state, task);
  const questions = (aiQuiz.questions || []).map((question) => ({
    id: makeId("question"),
    ...question,
  }));
  for (let index = questions.length; index < task.quizCount; index += 1) {
    const chunk = sourceChunks[index % sourceChunks.length];
    questions.push(buildQuestionFromChunk(chunk, index, task.quizType));
  }
  const quiz = {
    id: makeId("quiz"),
    taskId,
    questions: questions.slice(0, task.quizCount),
    generatedBy: aiQuiz.source || "fallback",
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
