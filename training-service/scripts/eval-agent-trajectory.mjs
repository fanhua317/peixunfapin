import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { agentTrajectoryCases } from "./fixtures/agent-trajectory-cases.mjs";

const root = path.resolve(import.meta.dirname, "..");
const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-agent-trajectory-"));
const port = 18891;
const baseUrl = `http://127.0.0.1:${port}`;
let mockServer = null;
let mockUrl = "";

function extractUserInput(prompt) {
  const match = String(prompt || "").match(/用户输入：(".*")/s);
  if (!match) return "";
  try {
    return JSON.parse(match[1]);
  } catch {
    return "";
  }
}

function intentRouterAnswer(prompt) {
  const message = extractUserInput(prompt);
  if (/确认发布/.test(message)) {
    return { intent: "answer_general_chat", skill: "answer_general_chat", confidence: 0.98, reason: "短确认语由前端草稿卡片处理。" };
  }
  if (/(删掉|清空).*(培训记录|培训任务)|培训记录.*删掉/.test(message)) {
    return { intent: "delete_training_records", skill: "delete_training_records", confidence: 0.95, reason: "用户明确要求删除培训记录。" };
  }
  if (/(查一下|查看|看看).*(培训完成情况|培训|考试成绩|谁没完成)/.test(message)) {
    return { intent: "show_training_status", skill: "show_training_status", confidence: 0.9, reason: "用户查询培训状态。" };
  }
  if (/生成三篇水泵的宣传文章|生成三篇英文文章，同时附带中文翻译/.test(message)) {
    return { intent: "generate_marketing_article", skill: "generate_marketing_article", confidence: 0.94, reason: "用户要生成文章，翻译只是文章附加要求。" };
  }
  if (/(软文|公众号文章|宣传文章|推广文案)/.test(message)) {
    return { intent: "generate_marketing_article", skill: "generate_marketing_article", confidence: 0.9, reason: "用户要求生成营销文章。" };
  }
  if (/(翻译|translate\s+(?:to|into))/i.test(message)) {
    return { intent: "translate_text", skill: "translate_text", confidence: 0.93, reason: "用户要求翻译已有文本。" };
  }
  if (/请帮我检索 CM2 的相关知识|有具体型号吗/.test(message)) {
    return { intent: "answer_knowledge_question", skill: "answer_knowledge_question", confidence: 0.92, reason: "用户询问水泵知识库资料和型号。" };
  }
  if (/这是水泵，不是电机/.test(message)) {
    return { intent: "answer_knowledge_question", skill: "answer_knowledge_question", confidence: 0.86, reason: "用户纠正主题为水泵，应优先水泵资料。" };
  }
  if (/(低压铸铝|电机是什么|WONDER 电机)/.test(message)) {
    return { intent: "answer_knowledge_question", skill: "answer_knowledge_question", confidence: 0.9, reason: "用户询问已导入资料内容。" };
  }
  if (/(发布|安排|出)\s*.*(培训|学习|题)|给.+(培训|学习|考试)|重新输入/.test(message)) {
    return { intent: "create_training_draft", skill: "create_training_draft", confidence: 0.92, reason: "用户要求创建培训草稿。" };
  }
  return { intent: "answer_general_chat", skill: "answer_general_chat", confidence: 0.6, reason: "eval mock fallback" };
}

function mockCompletion(prompt) {
  const text = String(prompt || "");
  if (/意图路由器/.test(text)) return intentRouterAnswer(text);
  if (/企业培训资料答疑助手/.test(text)) {
    return {
      answer: "根据资料，CM2 属于银嘉泵水泵相关型号，追问具体型号时应继续使用银嘉泵水泵资料库，不应切到电机资料库。",
      keyPoints: ["CM2 是水泵型号", "追问型号沿用水泵资料库"],
      caveats: [],
      sourceRefs: ["银嘉泵目录.md :: CM2", "银嘉泵目录.md :: 型号"],
    };
  }
  if (/工业品营销内容策划/.test(text)) {
    return {
      title: "银嘉泵水泵宣传文章",
      summary: "基于银嘉泵水泵资料生成的宣传内容。",
      article: "银嘉泵水泵面向清水输送、增压和一般工业配套场景，CM2 等型号可作为客户选型沟通的切入点。",
      sellingPoints: ["清水输送", "增压应用", "型号资料可追溯"],
      sourceRefs: ["银嘉泵目录.md :: CM2", "银嘉泵目录.md :: 型号"],
      warnings: [],
    };
  }
  if (/专业翻译助手/.test(text)) return "This is a water pump.";
  return { answer: "eval mock response" };
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function startMockServer() {
  mockServer = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || !String(req.url || "").endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const body = await readJsonBody(req);
      const prompt = (body.messages || []).map((message) => message.content || "").join("\n");
      const answer = mockCompletion(prompt);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-agent-trajectory-eval",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: typeof answer === "string" ? answer : JSON.stringify(answer) },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", () => {
      mockServer.off("error", reject);
      resolve();
    });
  });
  const address = mockServer.address();
  mockUrl = `http://127.0.0.1:${address.port}/v1`;
}

async function stopMockServer() {
  if (!mockServer) return;
  await new Promise((resolve, reject) => {
    mockServer.close((error) => (error ? reject(error) : resolve()));
  });
  mockServer = null;
}

const seededState = {
  meta: {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  knowledgeBases: [
    {
      id: "kb-motor",
      name: "电机基础资料库",
      aliases: ["电机", "电动机", "电机基础培训", "低压铸铝"],
      status: "ready",
      description: "Agent trajectory eval fixture",
    },
    {
      id: "kb-yinjia-pump",
      name: "银嘉泵水泵资料库",
      aliases: ["银嘉泵", "银嘉水泵", "水泵", "泵", "CM2", "YINJIA"],
      status: "ready",
      description: "Agent trajectory pump eval fixture",
    },
  ],
  documents: [],
  chunkParents: [
    {
      id: "parent-low-pressure-casting",
      knowledgeBaseId: "kb-motor",
      documentId: "doc-motor",
      sourceRef: "电机工艺.md :: 低压铸铝",
      content: "低压铸铝相比压力铸铝排气更好，转子填充率和电气性能更稳定；相比离心铸铝，工艺一致性更容易控制。",
    },
    {
      id: "parent-pump-cm2",
      knowledgeBaseId: "kb-yinjia-pump",
      documentId: "doc-yinjia-pump",
      sourceRef: "银嘉泵目录.md :: CM2",
      content: "银嘉泵水泵资料中，CM2 属于离心泵相关型号，可用于清水输送、增压和一般工业配套场景。",
    },
    {
      id: "parent-pump-models",
      knowledgeBaseId: "kb-yinjia-pump",
      documentId: "doc-yinjia-pump",
      sourceRef: "银嘉泵目录.md :: 型号",
      content: "银嘉泵资料包含 CM2、VM22、QB60、WZB750 等具体水泵型号，型号参数应以资料表为准。",
    },
  ],
  chunks: [
    {
      id: "chunk-low-pressure-casting",
      parentId: "parent-low-pressure-casting",
      knowledgeBaseId: "kb-motor",
      documentId: "doc-motor",
      sourceRef: "电机工艺.md :: 低压铸铝",
      content: "低压铸铝排气更好，转子填充率和电气性能更稳定，是压力铸铝和离心铸铝对比中的优势工艺。",
      searchText: "低压铸铝 优势 压力铸铝 离心铸铝 电气性能",
    },
    {
      id: "chunk-pump-cm2",
      parentId: "parent-pump-cm2",
      knowledgeBaseId: "kb-yinjia-pump",
      documentId: "doc-yinjia-pump",
      sourceRef: "银嘉泵目录.md :: CM2",
      content: "CM2 是银嘉泵水泵资料中的型号，可用于清水输送、增压和一般工业配套。",
      searchText: "银嘉泵 水泵 泵 CM2 相关知识 清水输送 增压 工业配套",
    },
    {
      id: "chunk-pump-models",
      parentId: "parent-pump-models",
      knowledgeBaseId: "kb-yinjia-pump",
      documentId: "doc-yinjia-pump",
      sourceRef: "银嘉泵目录.md :: 型号",
      content: "银嘉泵水泵具体型号包括 CM2、VM22、QB60、WZB750，追问型号时应沿用水泵资料库。",
      searchText: "水泵 具体型号 型号 CM2 VM22 QB60 WZB750 银嘉泵",
    },
  ],
  employees: [
    {
      id: "emp-wang-xiaoming",
      name: "王小明",
      aliases: ["小明"],
      department: "销售部",
      role: "销售新人",
      status: "active",
    },
    {
      id: "emp-li-xiaohong",
      name: "李小红",
      aliases: ["小红"],
      department: "销售部",
      role: "销售新人",
      status: "active",
    },
  ],
  tasks: [],
  invites: [],
  quizzes: [],
  attempts: [],
  contentDrafts: [],
  events: [],
};

await writeFile(path.join(tempDataDir, "state.json"), `${JSON.stringify(seededState, null, 2)}\n`, "utf8");

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  return { ok: response.ok, status: response.status, payload };
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const result = await request("/api/health");
      if (result.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("training-service did not become healthy");
}

function stepKey(step) {
  return `${step.type}${step.name ? `:${step.name}` : ""}`;
}

function hasStep(run, expected) {
  const [type, name] = expected.split(":");
  return (run.steps || []).some((step) => step.type === type && (!name || step.name === name));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function latestRun(runs, beforeIds) {
  return (runs || []).find((run) => !beforeIds.has(run.id));
}

function payloadKnowledgeBaseId(payload = {}) {
  return payload.knowledgeBase?.id || payload.article?.knowledgeBase?.id || payload.draft?.knowledgeBase?.id || "";
}

async function waitForNewFinishedRun(beforeIds, label) {
  const deadline = Date.now() + 15_000;
  let lastRun = null;
  while (Date.now() < deadline) {
    const after = await request("/api/agent-runs?limit=200");
    const summaryRun = latestRun(after.payload.runs, beforeIds);
    if (summaryRun) {
      const detail = await request(`/api/agent-runs/${encodeURIComponent(summaryRun.id)}`);
      if (detail.ok) {
        lastRun = detail.payload.run;
        if (lastRun.status !== "running" && hasStep(lastRun, "result_output")) return lastRun;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${label}: no finished run recorded${lastRun ? `; last status ${lastRun.status}` : ""}`);
}

await startMockServer();

const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    TRAINING_DATA_DIR: tempDataDir,
    TRAINING_STORAGE: "json",
    TRAINING_LLM_PROVIDER: "openai-compatible",
    TRAINING_LLM_BASE_URL: mockUrl,
    TRAINING_LLM_API_KEY: "agent-trajectory-eval-key",
    TRAINING_LLM_MODEL: "agent-trajectory-eval-mock",
    TRAINING_LLM_INTENT_ROUTER: "1",
    TRAINING_LLM_TIMEOUT_MS: "1500",
    OPENCLAW_CHAT_TIMEOUT_MS: "1500",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

const results = [];
let childStopped = false;
async function stopChild() {
  if (childStopped) return;
  childStopped = true;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
    setTimeout(resolve, 1500);
  });
}

try {
  await waitForHealth();

  const registry = await request("/api/tools/registry");
  assert(registry.ok, "tool registry endpoint should succeed");
  const toolIds = new Set((registry.payload.tools || []).map((tool) => tool.id));
  for (const id of [
    "create_training_draft",
    "show_training_status",
    "delete_training_records",
    "generate_marketing_article",
    "translate_text",
    "answer_knowledge_question",
    "answer_general_chat",
    "training_publish_task",
    "training_grade_answer",
  ]) {
    assert(toolIds.has(id), `missing tool registry id: ${id}`);
  }

  for (const item of agentTrajectoryCases) {
    if (item.skipTrajectory) {
      results.push({ id: item.id, ok: true, skipped: true, reason: item.skipTrajectory });
      continue;
    }
    const sessionId = `eval-session-${item.id}`;
    for (const beforeMessage of item.beforeMessages || []) {
      const before = await request("/api/agent-runs?limit=200");
      const beforeIds = new Set((before.payload.runs || []).map((run) => run.id));
      const beforeResponse = await request("/api/agent/dispatch", {
        method: "POST",
        body: JSON.stringify({ sessionId, memoryMode: "auto", message: beforeMessage }),
      });
      assert(beforeResponse.ok || beforeResponse.status === 503, `${item.id}: beforeMessage dispatch failed ${JSON.stringify(beforeResponse.payload)}`);
      await waitForNewFinishedRun(beforeIds, `${item.id}:before`);
    }
    const sessionSnapshot = item.beforeMessages?.length
      ? await request(`/api/boss-chat/sessions/${encodeURIComponent(sessionId)}`)
      : null;
    const before = await request("/api/agent-runs?limit=200");
    const beforeIds = new Set((before.payload.runs || []).map((run) => run.id));
    const response = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ sessionId, memoryMode: "auto", message: item.message }),
    });
    assert(response.ok || response.status === 503, `${item.id}: dispatch failed ${JSON.stringify(response.payload)}`);
    assert(
      response.payload.action === item.expectedAction,
      `${item.id}: expected action ${item.expectedAction}, got ${response.payload.action}; payload=${JSON.stringify(response.payload)}; session=${JSON.stringify(sessionSnapshot?.payload || null)}`
    );
    if (item.expectedKnowledgeBaseId) {
      assert(payloadKnowledgeBaseId(response.payload) === item.expectedKnowledgeBaseId, `${item.id}: expected knowledgeBaseId ${item.expectedKnowledgeBaseId}, got ${payloadKnowledgeBaseId(response.payload) || "(missing)"}`);
    }
    if (item.forbiddenKnowledgeBaseId) {
      assert(payloadKnowledgeBaseId(response.payload) !== item.forbiddenKnowledgeBaseId, `${item.id}: must not select knowledgeBaseId ${item.forbiddenKnowledgeBaseId}`);
    }
    const run = await waitForNewFinishedRun(beforeIds, item.id);
    if (item.expectedSkill) assert(run.skill === item.expectedSkill, `${item.id}: expected skill ${item.expectedSkill}, got ${run.skill}`);
    if (item.mustNotAction) assert(run.action !== item.mustNotAction, `${item.id}: action must not be ${item.mustNotAction}`);
    for (const step of item.mustSteps || []) {
      assert(hasStep(run, step), `${item.id}: missing step ${step}; got ${(run.steps || []).map(stepKey).join(", ")}`);
    }
    for (const step of item.mustNotSteps || []) {
      assert(!hasStep(run, step), `${item.id}: forbidden step ${step}; got ${(run.steps || []).map(stepKey).join(", ")}`);
    }
    results.push({ id: item.id, ok: true, action: run.action, skill: run.skill, steps: (run.steps || []).map(stepKey) });
  }

  const deleteFirst = await request("/api/agent/dispatch", {
    method: "POST",
    body: JSON.stringify({ sessionId: "eval-session", message: "清空全部培训任务记录" }),
  });
  assert(deleteFirst.ok && deleteFirst.payload.action === "intent_confirm", "delete confirmation should be issued first");
  const token = deleteFirst.payload.confirmation?.token;
  assert(token, "delete confirmation token missing");
  const confirmed = await request("/api/agent/dispatch", {
    method: "POST",
    body: JSON.stringify({
      sessionId: "eval-session",
      message: "清空全部培训任务记录",
      confirmedSkill: "delete_training_records",
      confirmationToken: token,
    }),
  });
  assert(confirmed.ok && confirmed.payload.action === "delete_records", "confirmed delete should execute");
  const confirmedRuns = await request("/api/agent-runs?skill=delete_training_records&limit=20");
  const confirmedRun = (confirmedRuns.payload.runs || [])[0];
  const confirmedDetail = await request(`/api/agent-runs/${encodeURIComponent(confirmedRun.id)}`);
  const stepKeys = confirmedDetail.payload.run.steps.map(stepKey);
  const verifyIndex = stepKeys.findIndex((step) => step === "confirmation_verify:delete_training_records");
  const executeIndex = stepKeys.findIndex((step) => step === "tool_execute:delete_training_records");
  assert(verifyIndex >= 0 && executeIndex > verifyIndex, `confirmed delete should verify before execute; got ${stepKeys.join(", ")}`);
  results.push({ id: "confirmed-delete", ok: true, steps: stepKeys });

  await stopChild();

  const jsonDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-agent-trajectory-json-"));
  process.env.TRAINING_DATA_DIR = jsonDir;
  process.env.TRAINING_STORAGE = "json";
  const { agentRunsPath, getRun, startRun, finishRun } = await import(`../src/agent-runs/store.mjs?eval=${Date.now()}`);
  const run = await startRun({ sessionId: "json-eval", transport: "http", route: "/api/chat", message: "sk-1234567890abcdef 是我的 key" });
  await finishRun(run.id, { action: "chat", summary: { note: "json fallback" } });
  const stored = await getRun(run.id);
  assert(stored?.id === run.id, "json agent-runs store should read saved run");
  assert(!stored.messagePreview.includes("sk-1234567890abcdef"), "message preview should redact API-like keys");
  assert(stored.messagePreview.includes("sk-[redacted]"), "message preview should show redaction marker");
  results.push({ id: "json-store", ok: true, path: agentRunsPath });
  await rm(jsonDir, { recursive: true, force: true });

  console.log(JSON.stringify({ ok: true, total: results.length, results }, null, 2));
} catch (error) {
  console.error(error);
  console.log(JSON.stringify({ ok: false, results }, null, 2));
  process.exitCode = 1;
} finally {
  await stopChild();
  await stopMockServer();
  await rm(tempDataDir, { recursive: true, force: true });
}
