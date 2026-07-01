import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  accessKeyFromArgs,
  cleanBaseUrl,
  defaultAuditOutDir,
  defaultProductionUrl,
  parseArgs,
  requestJson,
  writeJsonArtifact,
} from "./server-audit/common.mjs";

const args = parseArgs();
const outDir = args.out || defaultAuditOutDir;
const baseUrl = cleanBaseUrl(args.baseUrl || args["base-url"] || defaultProductionUrl);
const sampleCount = Math.max(1, Math.min(Number(args.samples || args.sampleCount || args["sample-count"] || 5), 8));
const includeIsolated = args.isolated !== "0" && args["skip-isolated"] !== true;
const repoRoot = path.resolve(import.meta.dirname, "..");
const deployRoot = path.resolve(repoRoot, "..");
const envFile = args.envFile || args["env-file"] || path.join(deployRoot, ".env");

const sampleQuestions = [
  { id: "motor-ie3", kbHint: "motor", question: "IE3 电机的能效等级和应用场景是什么？" },
  { id: "motor-application", kbHint: "motor", question: "电机主要应用领域有哪些？" },
  { id: "wonder-efficiency", kbHint: "motor", question: "WONDER 高效电机有哪些优势？" },
  { id: "pump-application", kbHint: "pump", question: "银嘉泵产品有哪些典型应用场景？" },
  { id: "pump-series", kbHint: "pump", question: "银嘉泵资料里有哪些主要产品系列？" },
].slice(0, sampleCount);

function nowIso() {
  return new Date().toISOString();
}

function compact(value, limit = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function percentile(values, pct) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return Math.round(sorted[index]);
}

function average(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? Number((nums.reduce((sum, item) => sum + item, 0) / nums.length).toFixed(1)) : 0;
}

function loadEnvFile(filePath) {
  if (!filePath || !existsSync(filePath)) return { path: filePath, loaded: false, keys: [] };
  const raw = readFileSync(filePath, "utf8");
  const keys = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [name, ...valueParts] = trimmed.split("=");
    const key = name.trim();
    const value = valueParts.join("=").trim();
    if (!key) continue;
    process.env[key] = value;
    keys.push(key);
  }
  return { path: filePath, loaded: true, keys };
}

function configPresence() {
  return {
    webProvider: process.env.TRAINING_WEB_SEARCH_PROVIDER || "",
    webBaseUrl: process.env.TRAINING_WEB_SEARCH_BASE_URL || "",
    webSearchCredentialConfigured: Boolean(process.env.TRAINING_WEB_SEARCH_API_KEY || process.env.TAVILY_API_KEY),
    llmConfigured: Boolean(process.env.TRAINING_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY),
    accessCredentialConfigured: Boolean(process.env.TRAINING_ACCESS_KEY || process.env.OPENCLAW_TRAINING_ACCESS_KEY),
  };
}

function resolveDataDir() {
  if (args.dataDir || args["data-dir"]) return path.resolve(args.dataDir || args["data-dir"]);
  if (process.env.TRAINING_DATA_DIR) return path.resolve(process.env.TRAINING_DATA_DIR);
  const packaged = path.join(deployRoot, "data", "training-index");
  return existsSync(packaged) ? packaged : path.resolve("D:/juzhou-agent/data/training-index");
}

async function copyDataDir(source, target) {
  await mkdir(target, { recursive: true });
  async function walk(src, dst) {
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "backups" || entry.name.startsWith("backup-before-")) continue;
      const from = path.join(src, entry.name);
      const to = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        await mkdir(to, { recursive: true });
        await walk(from, to);
      } else if (entry.isFile()) {
        await copyFile(from, to);
      }
    }
  }
  await walk(source, target);
}

async function fileStats(rootDir) {
  const summary = { exists: existsSync(rootDir), fileCount: 0, bytes: 0 };
  if (!summary.exists) return summary;
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      summary.fileCount += 1;
      summary.bytes += info.size;
    }
  }
  await walk(rootDir);
  return summary;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, accessKeyValue, timeoutMs = 45_000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await requestJson(url, "/api/health", { accessKey: accessKeyValue, timeoutMs: 8_000 });
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return last || { ok: false, status: 0, error: "health timeout" };
}

async function startIsolatedServer({ dataDir, port, accessKeyValue }) {
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    TRAINING_SERVICE_PORT: String(port),
    TRAINING_ACCESS_KEY: accessKeyValue,
    TRAINING_DATA_DIR: dataDir,
    TRAINING_SQLITE_PATH: path.join(dataDir, "training.db"),
    TRAINING_STORAGE: process.env.TRAINING_STORAGE || "sqlite",
    TRAINING_HYBRID_RETRIEVAL: process.env.TRAINING_HYBRID_RETRIEVAL || "auto",
    TRAINING_VECTOR_BACKEND: process.env.TRAINING_VECTOR_BACKEND || "local",
    TRAINING_EMBEDDING_MODEL: process.env.TRAINING_EMBEDDING_MODEL || "bge-m3",
  };
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: repoRoot,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const url = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(url, accessKeyValue);
  return {
    child,
    url,
    health,
    logs: () => ({ stdout: compact(stdout, 2000), stderr: compact(stderr, 2000) }),
  };
}

async function stopChild(child) {
  if (!child || child.killed) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
    setTimeout(resolve, 3000);
  });
}

async function closeLocalDatabaseHandle() {
  try {
    const { closeTrainingDatabase } = await import("../src/sqlite-store.mjs");
    closeTrainingDatabase();
  } catch {
    // Best-effort cleanup only; audit results are already written.
  }
}

async function removeTempRoot(rootDir) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rm(rootDir, { recursive: true, force: true });
      return { ok: true, attempt };
    } catch (error) {
      if (attempt === 5) {
        return {
          ok: false,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  return { ok: false, error: "cleanup retry exhausted" };
}

function chooseKnowledgeBase(state, hint) {
  const list = state.knowledgeBases || [];
  const text = String(hint || "").toLowerCase();
  if (text === "pump") {
    return list.find((kb) => /泵|pump/i.test(`${kb.name || ""} ${(kb.aliases || []).join(" ")}`)) || list[0];
  }
  return list.find((kb) => /电机|motor|wonder|ie3/i.test(`${kb.name || ""} ${(kb.aliases || []).join(" ")}`)) || list[0];
}

function summarizeAnswer(result, latencyMs, extra = {}) {
  return {
    ok: !result?.error && result?.insufficient !== true,
    latencyMs,
    action: result?.action || "",
    webSearchMode: result?.webSearchMode || "",
    webSearchStatus: result?.webSearchStatus || "",
    sourceCount: result?.sourceRefs?.length || result?.sources?.length || result?.usedSources?.length || 0,
    webSourceCount: result?.webSources?.length || result?.webSourceRefs?.length || 0,
    warningCount: result?.warnings?.length || result?.answerQuality?.warnings?.length || 0,
    confidence: result?.confidence || "",
    answerQualityStatus: result?.answerQuality?.status || "",
    retrievalMode: result?.retrievalMode || "",
    answerChars: String(result?.answer || "").length,
    error: result?.error || result?.errorMessage || "",
    firstWebSourceUrl: result?.webSources?.[0]?.url || "",
    ...extra,
  };
}

function summarizeGenerationResult(result, latencyMs, extra = {}) {
  const article = result?.article && typeof result.article === "object" ? result.article : null;
  const sourceRefs = result?.sourceRefs || article?.sourceRefs || [];
  const webSources = result?.webSources || article?.webSources || [];
  const webSourceRefs = result?.webSourceRefs || article?.webSourceRefs || [];
  const warnings = result?.warnings || article?.warnings || [];
  const text = result?.answer || article?.article || result?.article || result?.studyGuide || result?.translatedText || "";
  return {
    ok: !result?.error && result?.insufficient !== true && article?.insufficient !== true,
    latencyMs,
    action: result?.action || extra.action || "",
    webSearchMode: result?.webSearchMode || article?.webSearchMode || "",
    webSearchStatus: result?.webSearchStatus || article?.webSearchStatus || "",
    sourceCount: sourceRefs.length || result?.sources?.length || result?.usedSources?.length || 0,
    webSourceCount: webSources.length || webSourceRefs.length || 0,
    warningCount: warnings.length || result?.answerQuality?.warnings?.length || 0,
    hasAnswer: Boolean(text || result?.questions?.length),
    questionCount: result?.questions?.length || 0,
    answerChars: String(text || "").length,
    error: result?.error || result?.errorMessage || "",
    firstWebSourceUrl: webSources?.[0]?.url || "",
    ...extra,
  };
}

async function timed(fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    return { ok: true, latencyMs: Date.now() - startedAt, value };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runDirectSamples({ isolatedDataDir }) {
  process.env.TRAINING_DATA_DIR = isolatedDataDir;
  process.env.TRAINING_SQLITE_PATH = path.join(isolatedDataDir, "training.db");
  process.env.TRAINING_STORAGE = process.env.TRAINING_STORAGE || "sqlite";
  const { loadState } = await import("../src/store.mjs");
  const { generateKnowledgeAnswer } = await import("../src/ai/index.mjs");
  const state = await loadState();
  const samples = [];
  for (const sample of sampleQuestions) {
    const kb = chooseKnowledgeBase(state, sample.kbHint);
    const off = await timed(() => generateKnowledgeAnswer(state, {
      knowledgeBaseId: kb.id,
      question: sample.question,
      webSearchMode: "off",
    }));
    const on = await timed(() => generateKnowledgeAnswer(state, {
      knowledgeBaseId: kb.id,
      question: sample.question,
      webSearchMode: "on",
    }));
    samples.push({
      id: sample.id,
      question: sample.question,
      knowledgeBaseId: kb.id,
      off: off.ok ? summarizeAnswer(off.value, off.latencyMs) : { ok: false, latencyMs: off.latencyMs, error: off.error },
      on: on.ok ? summarizeAnswer(on.value, on.latencyMs) : { ok: false, latencyMs: on.latencyMs, error: on.error },
    });
  }
  return { samples, stateCounts: countState(state) };
}

async function runChainCoverage({ isolatedDataDir }) {
  process.env.TRAINING_DATA_DIR = isolatedDataDir;
  process.env.TRAINING_SQLITE_PATH = path.join(isolatedDataDir, "training.db");
  process.env.TRAINING_STORAGE = process.env.TRAINING_STORAGE || "sqlite";
  const { loadState } = await import("../src/store.mjs");
  const {
    generateKnowledgeAnswer,
    generateMarketingArticle,
    generateQuizQuestions,
    generateTrainingMaterial,
  } = await import("../src/ai/index.mjs");
  const { translateText } = await import("../src/chat/translation.mjs");
  const { answerGeneralChat } = await import("../src/chat/general-chat.mjs");
  const state = await loadState();
  const kb = chooseKnowledgeBase(state, "motor");
  const task = (state.tasks || []).find((item) => item.knowledgeBaseId === kb?.id) || {
    id: "audit-chain-task",
    title: "电机应用培训",
    instruction: "学习电机应用场景和选型关注点",
    knowledgeBaseId: kb?.id,
    quizCount: 2,
    quizType: "single_choice",
  };
  const question = "IE3 电机的能效等级和应用场景是什么？";
  const chains = [
    {
      id: "knowledge_answer",
      run: (mode) => generateKnowledgeAnswer(state, { knowledgeBaseId: kb.id, question, webSearchMode: mode }),
    },
    {
      id: "marketing_article",
      run: (mode) => generateMarketingArticle(state, { instruction: `${kb.name || "电机"} 应用场景营销软文`, webSearchMode: mode }),
    },
    {
      id: "training_material",
      run: (mode) => generateTrainingMaterial(state, task, { webSearchMode: mode }),
    },
    {
      id: "quiz_generation",
      run: (mode) => generateQuizQuestions(state, task, { webSearchMode: mode }),
    },
    {
      id: "translation",
      run: (mode) => translateText("翻译成英文：高效电机适用于水泵、风机和输送设备。", { webSearchMode: mode }),
    },
    {
      id: "general_chat",
      run: (mode) => answerGeneralChat("工业电机有哪些典型应用场景？", { webSearchMode: mode }),
    },
  ];
  const results = [];
  for (const chain of chains) {
    const off = await timed(() => chain.run("off"));
    const on = await timed(() => chain.run("on"));
    results.push({
      id: chain.id,
      off: off.ok
        ? summarizeGenerationResult(off.value, off.latencyMs, { action: chain.id })
        : { ok: false, latencyMs: off.latencyMs, action: chain.id, error: off.error },
      on: on.ok
        ? summarizeGenerationResult(on.value, on.latencyMs, { action: chain.id })
        : { ok: false, latencyMs: on.latencyMs, action: chain.id, error: on.error },
    });
  }
  return {
    chains: results,
    stateCounts: countState(state),
  };
}

function countState(state) {
  return {
    knowledgeBases: state.knowledgeBases?.length || 0,
    documents: state.documents?.length || 0,
    chunks: state.chunks?.length || 0,
    tasks: state.tasks?.length || 0,
    invites: state.invites?.length || 0,
    quizzes: state.quizzes?.length || 0,
    attempts: state.attempts?.length || 0,
  };
}

async function startMockTavily(mode) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/search") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (mode === "failed") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "mock failure" }));
      return;
    }
    if (mode === "timeout") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
      }, 5_000);
      return;
    }
    const results = mode === "empty" ? [] : [{
      title: "Mock IE3 motor reference",
      url: "https://example.com/mock-ie3",
      content: "IE3 motors are high-efficiency motors used in pumps, fans, compressors, and conveyors.",
      score: 0.9,
    }];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results, request_id: `mock-${mode}` }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runFailureModes({ isolatedDataDir }) {
  process.env.TRAINING_DATA_DIR = isolatedDataDir;
  process.env.TRAINING_SQLITE_PATH = path.join(isolatedDataDir, "training.db");
  const { loadState } = await import("../src/store.mjs");
  const { generateKnowledgeAnswer } = await import("../src/ai/index.mjs");
  const state = await loadState();
  const kb = chooseKnowledgeBase(state, "motor");
  const question = sampleQuestions[0]?.question || "IE3 电机的应用场景是什么？";
  const cases = [];
  const missing = await timed(() => withEnv({
    TRAINING_WEB_SEARCH_API_KEY: undefined,
    TAVILY_API_KEY: undefined,
  }, () => generateKnowledgeAnswer(state, { knowledgeBaseId: kb.id, question, webSearchMode: "on" })));
  cases.push({
    id: "missing-key",
    expected: "local answer with web_search_unconfigured warning",
    result: missing.ok ? summarizeAnswer(missing.value, missing.latencyMs) : { ok: false, latencyMs: missing.latencyMs, error: missing.error },
  });
  for (const mode of ["failed", "timeout", "empty"]) {
    const mock = await startMockTavily(mode);
    try {
      const result = await timed(() => withEnv({
        TRAINING_WEB_SEARCH_API_KEY: "mock-key",
        TRAINING_WEB_SEARCH_BASE_URL: mock.url,
        TRAINING_WEB_SEARCH_TIMEOUT_MS: mode === "timeout" ? "1000" : "8000",
      }, () => generateKnowledgeAnswer(state, { knowledgeBaseId: kb.id, question, webSearchMode: "on" })));
      cases.push({
        id: `tavily-${mode}`,
        expected: "local answer should not crash",
        result: result.ok ? summarizeAnswer(result.value, result.latencyMs) : { ok: false, latencyMs: result.latencyMs, error: result.error },
      });
    } finally {
      await mock.close();
    }
  }
  return cases;
}

async function runApiCase(baseUrlValue, endpoint, body, accessKeyValue) {
  const result = await requestJson(baseUrlValue, endpoint, {
    method: "POST",
    body,
    accessKey: accessKeyValue,
    timeoutMs: 90_000,
  });
  return {
    endpoint,
    ok: result.ok,
    status: result.status,
    latencyMs: result.latencyMs,
    taskId: result.payload?.task?.id || result.payload?.quiz?.taskId || "",
    payload: summarizeGenerationResult(
      result.payload?.task?.trainingMaterial || result.payload?.quiz || result.payload,
      result.latencyMs,
      { action: result.payload?.action || endpoint },
    ),
  };
}

function maskFrame(text) {
  const payload = Buffer.from(String(text));
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function parseServerFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    if (buffer.length - cursor < length) break;
    const payload = buffer.subarray(cursor, cursor + length);
    offset = cursor + length;
    if (opcode === 0x1) {
      try { messages.push(JSON.parse(payload.toString("utf8"))); } catch { /* ignore */ }
    }
    if (opcode === 0x8) break;
  }
  return { messages, remaining: buffer.subarray(offset) };
}

async function runWsCase(baseUrlValue, body, accessKeyValue) {
  const url = new URL(baseUrlValue);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const host = url.hostname;
  const key = randomBytes(16).toString("base64");
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const socket = net.connect(port, host);
    let handshaken = false;
    let raw = Buffer.alloc(0);
    let frameBuffer = Buffer.alloc(0);
    const messages = [];
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, latencyMs: Date.now() - startedAt, error: "websocket timeout", messages });
    }, 90_000);
    socket.on("connect", () => {
      socket.write([
        "GET /api/agent/stream HTTP/1.1",
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `x-training-access-key: ${accessKeyValue}`,
        "\r\n",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      if (!handshaken) {
        raw = Buffer.concat([raw, chunk]);
        const idx = raw.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const header = raw.subarray(0, idx).toString("utf8");
        if (!/^HTTP\/1\.1 101/i.test(header)) {
          clearTimeout(timer);
          socket.destroy();
          resolve({ ok: false, latencyMs: Date.now() - startedAt, error: compact(header), messages });
          return;
        }
        handshaken = true;
        socket.write(maskFrame(JSON.stringify(body)));
        frameBuffer = Buffer.concat([frameBuffer, raw.subarray(idx + 4)]);
      } else {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
      }
      const parsed = parseServerFrames(frameBuffer);
      frameBuffer = parsed.remaining;
      messages.push(...parsed.messages);
      if (messages.some((item) => item.type === "done" || item.type === "error")) {
        clearTimeout(timer);
        socket.end();
        const resultPayload = messages.find((item) => item.type === "result")?.payload
          || messages.find((item) => item.type === "done")?.payload
          || messages.find((item) => item.type === "error");
        resolve({
          ok: !messages.some((item) => item.type === "error"),
          latencyMs: Date.now() - startedAt,
          events: messages.map((item) => item.type),
          payload: summarizeGenerationResult(resultPayload, Date.now() - startedAt, { action: resultPayload?.action || "ws" }),
        });
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, latencyMs: Date.now() - startedAt, error: error.message, messages });
    });
  });
}

async function findInviteForAnswer(dataDir) {
  process.env.TRAINING_DATA_DIR = dataDir;
  process.env.TRAINING_SQLITE_PATH = path.join(dataDir, "training.db");
  const { loadState } = await import("../src/store.mjs");
  const state = await loadState();
  const kb = chooseKnowledgeBase(state, "motor");
  const task = (state.tasks || []).find((item) => item.knowledgeBaseId === kb?.id) || state.tasks?.[0];
  const invite = (state.invites || []).find((item) => item.taskId === task?.id) || state.invites?.[0];
  return {
    token: invite?.token || "",
    taskId: task?.id || "",
    knowledgeBaseId: kb?.id || "",
    knowledgeBaseName: kb?.name || "",
  };
}

async function runApiCoverage({ isolatedUrl, isolatedDataDir, accessKeyValue }) {
  const question = "IE3 电机的能效等级和应用场景是什么？";
  const cases = [];
  const invite = await findInviteForAnswer(isolatedDataDir);
  cases.push(await runApiCase(isolatedUrl, "/api/chat", {
    sessionId: `audit-web-off-${Date.now()}`,
    message: question,
    webSearchMode: "off",
  }, accessKeyValue));
  cases.push(await runApiCase(isolatedUrl, "/api/chat", {
    sessionId: `audit-web-on-${Date.now()}`,
    message: question,
    webSearchMode: "on",
  }, accessKeyValue));
  cases.push(await runApiCase(isolatedUrl, "/api/chat", {
    sessionId: `audit-marketing-web-${Date.now()}`,
    message: "写一篇 motor 应用场景营销软文",
    webSearchMode: "on",
  }, accessKeyValue));
  cases.push(await runApiCase(isolatedUrl, "/api/chat", {
    sessionId: `audit-translation-web-${Date.now()}`,
    message: "翻译成英文：高效电机适用于水泵和风机。",
    webSearchMode: "on",
  }, accessKeyValue));
  cases.push(await runApiCase(isolatedUrl, "/api/chat", {
    sessionId: `audit-general-web-${Date.now()}`,
    message: "工业电机有哪些典型应用？",
    forceGeneralChat: true,
    webSearchMode: "on",
  }, accessKeyValue));
  cases.push(await runApiCase(isolatedUrl, "/api/agent/dispatch", {
    sessionId: `audit-dispatch-web-${Date.now()}`,
    message: question,
    webSearchMode: "on",
  }, accessKeyValue));
  if (invite.knowledgeBaseId) {
    const publish = await runApiCase(isolatedUrl, "/api/tasks/publish", {
      webSearchMode: "on",
      draft: {
        id: `audit-draft-${Date.now()}`,
        title: "电机应用培训审计",
        instruction: question,
        knowledgeBase: { id: invite.knowledgeBaseId, name: invite.knowledgeBaseName || "电机资料库" },
        employees: [],
        unmatchedEmployees: [{ name: "审计临时员工" }],
        deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        quizCount: 2,
        passScore: 80,
        quizType: "single_choice",
      },
    }, accessKeyValue);
    cases.push(publish);
    if (publish.taskId) {
      cases.push(await runApiCase(isolatedUrl, "/api/quiz/generate", {
        taskId: publish.taskId,
        webSearchMode: "on",
      }, accessKeyValue));
    }
  }
  if (invite.token) {
    cases.push(await runApiCase(isolatedUrl, "/api/answer", {
      token: invite.token,
      question,
      webSearchMode: "on",
    }, accessKeyValue));
  } else {
    cases.push({ endpoint: "/api/answer", ok: false, skipped: true, error: "no invite token in isolated data" });
  }
  const ws = await runWsCase(isolatedUrl, {
    sessionId: `audit-ws-web-${Date.now()}`,
    message: question,
    webSearchMode: "on",
  }, accessKeyValue);
  cases.push({ endpoint: "ws:/api/agent/stream", ...ws });
  return cases;
}

function summarizeAll({ directSamples, chainCoverage, failureModes, apiCoverage }) {
  const onSamples = directSamples.map((item) => item.on).filter(Boolean);
  const offSamples = directSamples.map((item) => item.off).filter(Boolean);
  const chainSamples = chainCoverage?.chains || [];
  const chainOnSamples = chainSamples.map((item) => item.on).filter(Boolean);
  const chainOffSamples = chainSamples.map((item) => item.off).filter(Boolean);
  const webOk = onSamples.filter((item) => item.webSearchStatus === "ok").length;
  const directLatencies = onSamples.map((item) => item.latencyMs);
  const offLatencies = offSamples.map((item) => item.latencyMs);
  const chainOnLatencies = chainOnSamples.map((item) => item.latencyMs);
  const chainOffLatencies = chainOffSamples.map((item) => item.latencyMs);
  const apiWebCases = apiCoverage.filter((item) => item.payload?.webSearchMode === "on" || /ws:|agent|answer|chat/.test(item.endpoint));
  const degradationOk = failureModes.filter((item) => item.result?.ok && item.result?.sourceCount > 0).length;
  return {
    sampleCount: onSamples.length,
    webSuccessRate: onSamples.length ? Number((webOk / onSamples.length).toFixed(4)) : 0,
    directOnLatency: {
      avgMs: average(directLatencies),
      p50Ms: percentile(directLatencies, 50),
      p95Ms: percentile(directLatencies, 95),
    },
    directOffLatency: {
      avgMs: average(offLatencies),
      p50Ms: percentile(offLatencies, 50),
      p95Ms: percentile(offLatencies, 95),
    },
    avgLocalSources: average(onSamples.map((item) => item.sourceCount)),
    avgWebSources: average(onSamples.map((item) => item.webSourceCount)),
    totalWarnings: onSamples.reduce((sum, item) => sum + (item.warningCount || 0), 0),
    chainCases: chainSamples.length,
    chainOk: chainOnSamples.filter((item) => item.ok && item.webSearchStatus === "ok" && item.webSourceCount > 0).length,
    chainOffNoWeb: chainOffSamples.filter((item) => item.webSearchStatus === "disabled" && item.webSourceCount === 0).length,
    chainOnLatency: {
      avgMs: average(chainOnLatencies),
      p50Ms: percentile(chainOnLatencies, 50),
      p95Ms: percentile(chainOnLatencies, 95),
    },
    chainOffLatency: {
      avgMs: average(chainOffLatencies),
      p50Ms: percentile(chainOffLatencies, 50),
      p95Ms: percentile(chainOffLatencies, 95),
    },
    chainAvgLocalSources: average(chainOnSamples.map((item) => item.sourceCount)),
    chainAvgWebSources: average(chainOnSamples.map((item) => item.webSourceCount)),
    chainWarnings: chainOnSamples.reduce((sum, item) => sum + (item.warningCount || 0), 0),
    apiCases: apiCoverage.length,
    apiOk: apiCoverage.filter((item) => item.ok).length,
    apiWebOk: apiWebCases.filter((item) => item.payload?.webSearchStatus === "ok").length,
    degradationCases: failureModes.length,
    degradationOk,
  };
}

const envLoad = loadEnvFile(envFile);
const accessKey = accessKeyFromArgs(args);
const dataDir = resolveDataDir();
const productionHealth = await requestJson(baseUrl, "/api/health", { accessKey, timeoutMs: 15_000 });
const codeStatus = {
  hasWebSearch: existsSync(path.join(repoRoot, "src", "ai", "web-search.mjs")),
  hasEvalWebSearch: existsSync(path.join(repoRoot, "scripts", "eval-web-search.mjs")),
  hasBossToggle: existsSync(path.join(repoRoot, "public", "index.html"))
    ? /联网搜索/.test(await readFile(path.join(repoRoot, "public", "index.html"), "utf8"))
    : false,
};

const isolatedRoot = path.join(os.tmpdir(), `juzhou-web-search-audit-${Date.now()}`);
const isolatedDataDir = path.join(isolatedRoot, "training-index");
let isolatedServer = null;
let direct = null;
let chainCoverage = null;
let failureModes = [];
let apiCoverage = [];
let isolated = null;

try {
  if (!existsSync(dataDir)) throw new Error(`data dir not found: ${dataDir}`);
  await mkdir(isolatedRoot, { recursive: true });
  await copyDataDir(dataDir, isolatedDataDir);
  const copiedStats = await fileStats(isolatedDataDir);
  direct = await runDirectSamples({ isolatedDataDir });
  chainCoverage = await runChainCoverage({ isolatedDataDir });
  failureModes = await runFailureModes({ isolatedDataDir });

  if (includeIsolated) {
    const port = Number(args.port || 0) || await freePort();
    const isolatedAccessKey = `audit-${randomBytes(12).toString("hex")}`;
    isolatedServer = await startIsolatedServer({ dataDir: isolatedDataDir, port, accessKeyValue: isolatedAccessKey });
    apiCoverage = await runApiCoverage({
      isolatedUrl: isolatedServer.url,
      isolatedDataDir,
      accessKeyValue: isolatedAccessKey,
    });
    isolated = {
      enabled: true,
      url: isolatedServer.url,
      health: isolatedServer.health.ok ? {
        ok: true,
        status: isolatedServer.health.status,
        latencyMs: isolatedServer.health.latencyMs,
        retrievalMode: isolatedServer.health.payload?.retrievalMode,
        ollamaOk: isolatedServer.health.payload?.ollamaOk,
        localVectorIndexOk: isolatedServer.health.payload?.localVectorIndexOk,
        llmConfigured: isolatedServer.health.payload?.llmConfigured,
        counts: isolatedServer.health.payload?.counts,
      } : isolatedServer.health,
      logs: isolatedServer.logs(),
    };
  }

  const summary = summarizeAll({
    directSamples: direct.samples,
    chainCoverage,
    failureModes,
    apiCoverage,
  });

  const artifact = {
    kind: "juzhou-server-audit-web-search",
    createdAt: nowIso(),
    baseUrl,
    env: {
      fileLoaded: envLoad.loaded,
      filePath: envLoad.loaded ? envLoad.path : "",
      configPresence: configPresence(),
    },
    production: {
      health: productionHealth.ok ? {
        ok: true,
        status: productionHealth.status,
        latencyMs: productionHealth.latencyMs,
        retrievalMode: productionHealth.payload?.retrievalMode,
        ollamaOk: productionHealth.payload?.ollamaOk,
        localVectorIndexOk: productionHealth.payload?.localVectorIndexOk,
        llmConfigured: productionHealth.payload?.llmConfigured,
        counts: productionHealth.payload?.counts,
      } : productionHealth,
      codeStatus,
    },
    isolatedData: {
      sourceDataDir: dataDir,
      copiedFileCount: copiedStats.fileCount,
      copiedBytes: copiedStats.bytes,
    },
    direct,
    chainCoverage,
    failureModes,
    isolated,
    apiCoverage,
    summary,
  };
  const artifactPath = await writeJsonArtifact(outDir, "web-search", artifact);
  console.log(JSON.stringify({
    ok: true,
    path: artifactPath,
    summary,
  }, null, 2));
} finally {
  if (isolatedServer?.child) await stopChild(isolatedServer.child);
  await closeLocalDatabaseHandle();
  if (args.keepTemp !== true && args["keep-temp"] !== true) {
    const cleanup = await removeTempRoot(isolatedRoot);
    if (!cleanup.ok) {
      console.error(JSON.stringify({ cleanupWarning: cleanup }, null, 2));
    }
  }
}
