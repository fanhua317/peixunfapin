import { rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const tempDataDir = path.join(root, ".tmp-smoke-data");
const port = 18787;
const baseUrl = `http://127.0.0.1:${port}`;

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
    TRAINING_DATA_DIR: tempDataDir,
    TRAINING_HEALTH_TIMEOUT_MS: process.env.TRAINING_HEALTH_TIMEOUT_MS || "300",
    OPENCLAW_CHAT_TIMEOUT_MS: process.env.OPENCLAW_CHAT_TIMEOUT_MS || "3000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  await waitForHealth();

  const health = await request("/api/health");
  if (!health.stateOk || !["keyword", "hybrid"].includes(health.retrievalMode)) {
    throw new Error(`unexpected health payload: ${JSON.stringify(health)}`);
  }

  const chatResponse = await request("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message: "今天天气怎么样？" }),
  });

  if (!chatResponse.answer) {
    throw new Error("expected general chat answer");
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

  const publishResponse = await request("/api/tasks/publish", {
    method: "POST",
    body: JSON.stringify({ draft: draftResponse.draft }),
  });

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

  console.log(JSON.stringify({
    ok: true,
    taskId: publishResponse.task.id,
    inviteEmployee: inviteResponse.invite.employeeName,
    generalChatSource: chatResponse.source,
    answerConfidence: answerResponse.confidence,
    questionCount: quizResponse.quiz.questions.length,
    score: submitResponse.attempt.score,
    retrievalMode: health.retrievalMode,
    qualityScore: qualityResponse.quality.qualityScore,
    reportCompleted: reportResponse.report.totals.completed,
  }, null, 2));
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await rm(tempDataDir, { recursive: true, force: true });
}
