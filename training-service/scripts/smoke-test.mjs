import { rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const tempDataDir = path.join(root, ".tmp-smoke-data");
const port = 18787;
const baseUrl = `http://127.0.0.1:${port}`;
const directLlmConfigured = Boolean(process.env.TRAINING_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY);

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${pathname} failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function requestExpectError(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (response.ok) {
    throw new Error(`${pathname} was expected to fail`);
  }
  return payload;
}

async function waitForHealth() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      await request("/api/health");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("training-service did not become healthy");
}

await rm(tempDataDir, { recursive: true, force: true });

const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    PUBLIC_BASE_URL: "http://old.example:8787",
    PUBLIC_BASE_URL_MODE: "",
    TRAINING_DATA_DIR: tempDataDir,
    TRAINING_HEALTH_TIMEOUT_MS: process.env.TRAINING_HEALTH_TIMEOUT_MS || "300",
    OPENCLAW_CHAT_TIMEOUT_MS: process.env.OPENCLAW_CHAT_TIMEOUT_MS || (directLlmConfigured ? "120000" : "3000"),
    TRAINING_LLM_TIMEOUT_MS: process.env.TRAINING_LLM_TIMEOUT_MS || "120000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  await waitForHealth();

  const health = await request("/api/health");
  if (!health.stateOk || !["bm25", "hybrid", "keyword-legacy"].includes(health.retrievalMode)) {
    throw new Error(`unexpected health payload: ${JSON.stringify(health)}`);
  }

  let chatResponse;
  try {
    chatResponse = await request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "今天天气怎么样？" }),
    });
    if (!chatResponse.answer || chatResponse.source !== "llm-api") {
      throw new Error(`expected general chat to use llm-api, got ${JSON.stringify(chatResponse)}`);
    }
  } catch (error) {
    if (!/普通聊天需要配置大模型 API Key|TRAINING_LLM_API_KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY/.test(error.message || "")) {
      throw error;
    }
    chatResponse = { source: "llm-api-unconfigured" };
  }

  const draftResponse = await request("/api/agent/draft", {
    method: "POST",
    body: JSON.stringify({
      instruction: "给王小明和李小红发布 A 产品基础培训，明天下午 6 点前完成，出 3 道选择题，80 分及格。",
    }),
  });

  if (draftResponse.draft.employees.length !== 2) {
    throw new Error(`expected 2 employees, got ${draftResponse.draft.employees.length}`);
  }

  const customDraftResponse = await request("/api/agent/draft", {
    method: "POST",
    body: JSON.stringify({
      instruction: "给顾帅出一个关于电机的培训，出 1 道题。",
    }),
  });
  const customEmployee = customDraftResponse.draft.employees[0];
  if (customDraftResponse.draft.employees.length !== 1 || customEmployee.name !== "顾帅" || customEmployee.temporary !== true) {
    throw new Error(`expected custom employee 顾帅, got ${JSON.stringify(customDraftResponse.draft.employees)}`);
  }

  const noMatchArticleResponse = await request("/api/agent/dispatch", {
    method: "POST",
    body: JSON.stringify({ message: "写一篇关于火锅的软文" }),
  });
  if (noMatchArticleResponse.action !== "marketing_article" || !noMatchArticleResponse.article?.insufficient) {
    throw new Error(`expected unmatched marketing article to be blocked, got ${JSON.stringify(noMatchArticleResponse)}`);
  }

  const memorySessionId = "smoke-memory";
  const marketingMemory = await request("/api/agent/dispatch", {
    method: "POST",
    body: JSON.stringify({ sessionId: memorySessionId, message: "以后软文默认短一点，偏公众号" }),
  });
  if (marketingMemory.action !== "memory_saved" || !marketingMemory.memory?.saved?.some((item) => item.key === "marketing.length")) {
    throw new Error(`expected marketing memory saved, got ${JSON.stringify(marketingMemory)}`);
  }
  const trainingMemory = await request("/api/agent/dispatch", {
    method: "POST",
    body: JSON.stringify({ sessionId: memorySessionId, message: "以后培训默认 10 道题 80 分" }),
  });
  if (trainingMemory.action !== "memory_saved" || !trainingMemory.memory?.saved?.some((item) => item.key === "training.quizCount")) {
    throw new Error(`expected training memory saved, got ${JSON.stringify(trainingMemory)}`);
  }
  const memoryDraft = await request("/api/agent/draft", {
    method: "POST",
    body: JSON.stringify({ sessionId: memorySessionId, instruction: "给王小明发布 A 产品基础培训" }),
  });
  if (memoryDraft.draft.quizCount !== 10 || memoryDraft.draft.passScore !== 80) {
    throw new Error(`expected memory defaults in draft, got ${JSON.stringify(memoryDraft.draft)}`);
  }
  const memoryList = await request("/api/memory");
  if (!memoryList.memories?.length) throw new Error("expected memory list to contain saved memories");
  const clearConfirm = await request("/api/agent/dispatch", {
    method: "POST",
    body: JSON.stringify({ sessionId: memorySessionId, message: "清空全部记忆" }),
  });
  if (clearConfirm.action !== "memory_confirm" || clearConfirm.confirmation?.skill !== "clear_memory") {
    throw new Error(`expected memory clear confirmation, got ${JSON.stringify(clearConfirm)}`);
  }
  const missingMemoryClearToken = await requestExpectError("/api/memory", {
    method: "DELETE",
    body: JSON.stringify({}),
  });
  if (missingMemoryClearToken.reason !== "missing_confirmation_token") {
    throw new Error(`expected missing memory confirmation token, got ${JSON.stringify(missingMemoryClearToken)}`);
  }
  const clearMemoryResponse = await request("/api/memory", {
    method: "DELETE",
    body: JSON.stringify({ confirmationToken: clearConfirm.confirmation?.token }),
  });
  if (clearMemoryResponse.action !== "memory_cleared" || clearMemoryResponse.deleted < 2) {
    throw new Error(`expected memory cleared, got ${JSON.stringify(clearMemoryResponse)}`);
  }

  if (!health.llmConfigured) {
    const publishError = await requestExpectError("/api/tasks/publish", {
      method: "POST",
      body: JSON.stringify({ draft: draftResponse.draft }),
    });
    if (!/培训讲义生成需要可用的大模型 API|TRAINING_LLM_API_KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY/.test(publishError.error || "")) {
      throw new Error(`expected publish to require LLM API, got ${JSON.stringify(publishError)}`);
    }
    const emptyDeleteConfirm = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ message: "把之前的培训记录删掉" }),
    });
    if (emptyDeleteConfirm.action !== "intent_confirm" || emptyDeleteConfirm.decision?.skill !== "delete_training_records") {
      throw new Error(`expected delete confirmation, got ${JSON.stringify(emptyDeleteConfirm)}`);
    }
    const missingDeleteToken = await requestExpectError("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ message: "把之前的培训记录删掉", confirmedSkill: "delete_training_records" }),
    });
    if (missingDeleteToken.reason !== "missing_confirmation_token") {
      throw new Error(`expected missing confirmation token error, got ${JSON.stringify(missingDeleteToken)}`);
    }
    const emptyDeleteResponse = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({
        message: "把之前的培训记录删掉",
        confirmedSkill: "delete_training_records",
        confirmationToken: emptyDeleteConfirm.confirmation?.token,
      }),
    });
    if (emptyDeleteResponse.action !== "delete_records" || emptyDeleteResponse.deleted.tasks !== 0) {
      throw new Error(`expected empty delete result, got ${JSON.stringify(emptyDeleteResponse)}`);
    }
    console.log(JSON.stringify({
      ok: true,
      mode: "llm-unconfigured",
      generalChatSource: chatResponse.source,
      publishBlocked: true,
      deleteSkill: emptyDeleteResponse.action,
      marketingArticleBlocked: noMatchArticleResponse.article.insufficient,
      memoryCleared: clearMemoryResponse.deleted,
      retrievalMode: health.retrievalMode,
    }, null, 2));
  } else {
    const marketingArticleResponse = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ message: "联网查一下再写一篇关于 A 产品的软文，短一点" }),
    });
    if (
      marketingArticleResponse.action !== "marketing_article" ||
      marketingArticleResponse.article?.insufficient ||
      !marketingArticleResponse.article?.article ||
      !marketingArticleResponse.article?.sourceRefs?.length ||
      !marketingArticleResponse.article?.warnings?.some((warning) => /联网搜索/.test(warning))
    ) {
      throw new Error(`expected local marketing article with web-search warning, got ${JSON.stringify(marketingArticleResponse)}`);
    }

    const publishResponse = await request("/api/tasks/publish", {
    method: "POST",
    body: JSON.stringify({ draft: draftResponse.draft }),
  });
  if (!String(publishResponse.inviteLinks?.[0]?.url || "").startsWith(`${baseUrl}/t/`)) {
    throw new Error(`expected invite link to use request host, got ${publishResponse.inviteLinks?.[0]?.url}`);
  }

  const qualityResponse = await request(`/api/knowledge-bases/${encodeURIComponent(publishResponse.task.knowledgeBaseId)}/quality`);
  if (!qualityResponse.quality || qualityResponse.quality.chunks < 1) {
    throw new Error("expected knowledge base quality report");
  }

  const token = publishResponse.invites[0].token;
  const inviteResponse = await request(`/api/invites/${token}`);
  const answerResponse = await request("/api/answer", {
    method: "POST",
    body: JSON.stringify({ token, question: "A 产品最大的优势是什么？" }),
  });
  const quizResponse = await request("/api/quiz/generate", {
    method: "POST",
    body: JSON.stringify({ taskId: publishResponse.task.id }),
  });
  const maxOptionLength = Math.max(...quizResponse.quiz.questions.flatMap((question) => question.options.map((option) => String(option).length)));
  if (maxOptionLength > 90) {
    throw new Error(`expected concise options, max option length was ${maxOptionLength}`);
  }
  if (quizResponse.quiz.questions.some((question) => /未能从|OCR|扫描件|复制文本/.test(`${question.prompt} ${(question.options || []).join(" ")}`))) {
    throw new Error("quiz should not include OCR placeholder chunks");
  }

  const answers = Object.fromEntries(
    quizResponse.quiz.questions.map((question) => [question.id, question.correctAnswer]),
  );
  const submitResponse = await request("/api/quiz/submit", {
    method: "POST",
    body: JSON.stringify({ token, answers }),
  });

  const reportResponse = await request("/api/reports/overview");
  if (!reportResponse.report?.totals || reportResponse.report.totals.completed < 1) {
    throw new Error("expected report overview with completed invite");
  }

  const expiredDraftResponse = await request("/api/agent/draft", {
    method: "POST",
    body: JSON.stringify({
      instruction: "给王小明发布 A 产品基础培训，出 1 道选择题，80 分及格。",
    }),
  });
  const expiredPublishResponse = await request("/api/tasks/publish", {
    method: "POST",
    body: JSON.stringify({ draft: { ...expiredDraftResponse.draft, deadline: "2000-01-01T00:00:00.000Z", quizCount: 1 } }),
  });
  const expiredToken = expiredPublishResponse.invites[0].token;
  const expiredInvite = await request(`/api/invites/${expiredToken}`);
  if (!expiredInvite.expired || expiredInvite.invite.status !== "expired") {
    throw new Error("expected expired invite to be marked expired");
  }
  const expiredSubmit = await requestExpectError("/api/quiz/submit", {
    method: "POST",
    body: JSON.stringify({ token: expiredToken, answers: {} }),
  });
  if (!/expired/i.test(expiredSubmit.error || "")) {
    throw new Error("expected expired submit error");
  }

  const deleteConfirm = await request("/api/agent/dispatch", {
    method: "POST",
    body: JSON.stringify({ message: "把之前的培训记录删掉" }),
  });
  if (deleteConfirm.action !== "intent_confirm" || deleteConfirm.confirmation?.risk !== "high") {
    throw new Error(`expected delete confirmation, got ${JSON.stringify(deleteConfirm)}`);
  }
  const missingDeleteToken = await requestExpectError("/api/agent/dispatch", {
    method: "POST",
    body: JSON.stringify({ message: "把之前的培训记录删掉", confirmedSkill: "delete_training_records" }),
  });
  if (missingDeleteToken.reason !== "missing_confirmation_token") {
    throw new Error(`expected missing confirmation token error, got ${JSON.stringify(missingDeleteToken)}`);
  }
  const deleteResponse = await request("/api/agent/dispatch", {
    method: "POST",
    body: JSON.stringify({
      message: "把之前的培训记录删掉",
      confirmedSkill: "delete_training_records",
      confirmationToken: deleteConfirm.confirmation?.token,
    }),
  });
  if (deleteResponse.action !== "delete_records" || deleteResponse.deleted.tasks < 2 || deleteResponse.remainingTasks !== 0) {
    throw new Error(`expected training records to be deleted, got ${JSON.stringify(deleteResponse)}`);
  }
  const postDeleteTasks = await request("/api/tasks");
  if (postDeleteTasks.tasks.length !== 0) {
    throw new Error(`expected no tasks after delete, got ${JSON.stringify(postDeleteTasks.tasks)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    taskId: publishResponse.task.id,
    inviteEmployee: inviteResponse.invite.employeeName,
    generalChatSource: chatResponse.source,
    marketingArticleTitle: marketingArticleResponse.article.title,
    answerConfidence: answerResponse.confidence,
    questionCount: quizResponse.quiz.questions.length,
    score: submitResponse.attempt.score,
    retrievalMode: health.retrievalMode,
    qualityScore: qualityResponse.quality.qualityScore,
    reportCompleted: reportResponse.report.totals.completed,
    deletedTasks: deleteResponse.deleted.tasks,
    memoryCleared: clearMemoryResponse.deleted,
  }, null, 2));
  }
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await rm(tempDataDir, { recursive: true, force: true });
}
