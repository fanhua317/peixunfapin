import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentTrajectoryCases } from "./fixtures/agent-trajectory-cases.mjs";

const root = path.resolve(import.meta.dirname, "..");
const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-agent-trajectory-"));
const port = 18891;
const baseUrl = `http://127.0.0.1:${port}`;

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

const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    TRAINING_DATA_DIR: tempDataDir,
    TRAINING_LLM_INTENT_ROUTER: "0",
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
    "answer_general_chat",
    "training_publish_task",
    "training_grade_answer",
  ]) {
    assert(toolIds.has(id), `missing tool registry id: ${id}`);
  }

  for (const item of agentTrajectoryCases) {
    const before = await request("/api/agent-runs?limit=200");
    const beforeIds = new Set((before.payload.runs || []).map((run) => run.id));
    const response = await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ sessionId: "eval-session", memoryMode: "auto", message: item.message }),
    });
    assert(response.ok || response.status === 503, `${item.id}: dispatch failed ${JSON.stringify(response.payload)}`);
    assert(response.payload.action === item.expectedAction, `${item.id}: expected action ${item.expectedAction}, got ${response.payload.action}`);
    const after = await request("/api/agent-runs?limit=200");
    const summaryRun = latestRun(after.payload.runs, beforeIds);
    assert(summaryRun, `${item.id}: no new run recorded`);
    const detail = await request(`/api/agent-runs/${encodeURIComponent(summaryRun.id)}`);
    assert(detail.ok, `${item.id}: run detail not found`);
    const run = detail.payload.run;
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
  await rm(tempDataDir, { recursive: true, force: true });
}
