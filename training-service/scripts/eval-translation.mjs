import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-translation-eval-"));

process.env.TRAINING_DATA_DIR = tempDir;
process.env.TRAINING_STORAGE = "sqlite";
process.env.TRAINING_AUTH_DISABLED = "1";
process.env.TRAINING_LLM_PROVIDER = "auto";
process.env.TRAINING_LLM_INTENT_ROUTER = "0";
process.env.TRAINING_LLM_TIMEOUT_MS = "3000";
process.env.TRAINING_HEALTH_TIMEOUT_MS = process.env.TRAINING_HEALTH_TIMEOUT_MS || "200";

const results = [];
let appServer = null;
let mockServer = null;
let baseUrl = "";
let mockUrl = "";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compact(value, limit = 260) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function extractPayloadText(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key] ?? payload?.translation?.[key] ?? payload?.result?.[key];
    if (String(value || "").trim()) return String(value).trim();
  }
  return "";
}

function translatedText(payload) {
  return extractPayloadText(payload, ["translatedText", "translation", "answer", "text"]);
}

function targetLanguage(payload) {
  return extractPayloadText(payload, ["targetLanguage", "language", "target"]);
}

const LANGUAGE_ALIASES = {
  en: ["英文", "英语", "English", "english", "en", "EN"],
  zh: ["中文", "汉语", "Chinese", "chinese", "zh", "ZH", "简体中文"],
  ja: ["日语", "日文", "Japanese", "japanese", "ja", "JA"],
  es: ["西班牙语", "Spanish", "spanish", "es", "ES"],
  fr: ["法语", "French", "french", "fr", "FR"],
};

function languageMatches(value, expected) {
  const actual = String(value || "");
  return (LANGUAGE_ALIASES[expected] || [expected]).some((alias) => actual.includes(alias));
}

function inferMockTranslation(prompt) {
  const text = String(prompt || "");
  let target = "中文";
  if (/(英文|英语|English|\bto English\b)/i.test(text)) target = "英文";
  if (/(中文|汉语|Chinese|\bto Chinese\b)/i.test(text)) target = "中文";
  if (/(日语|日文|Japanese|\bto Japanese\b)/i.test(text)) target = "日语";
  if (/(西班牙语|Spanish|\bto Spanish\b)/i.test(text)) target = "西班牙语";
  if (/(法语|French|\bto French\b)/i.test(text)) target = "法语";

  const source = /这是一个电机培训系统/.test(text)
    ? "这是一个电机培训系统"
    : /这是一台水泵/.test(text)
      ? "这是一台水泵"
    : /末尾校验标记XYZ/.test(text)
      ? "长文本尾部校验"
    : /这个电机适合工业场景/.test(text)
      ? "这个电机适合工业场景"
      : /high efficiency motor/i.test(text)
        ? "high efficiency motor"
        : /\bhello\b/i.test(text)
          ? "hello"
          : "高效电机";

  const dictionary = {
    "英文|这是一个电机培训系统": "This is a motor training system.",
    "英文|这是一台水泵": "This is a water pump.",
    "中文|hello": "你好",
    "日语|这个电机适合工业场景": "このモーターは産業用途に適しています。",
    "西班牙语|high efficiency motor": "motor de alta eficiencia",
    "中文|high efficiency motor": "高效电机",
    "英文|高效电机": "high efficiency motor",
    "英文|长文本尾部校验": "long text tail marker XYZ",
    "法语|high efficiency motor": "moteur à haut rendement",
    "法语|高效电机": "moteur à haut rendement",
  };
  const translated = dictionary[`${target}|${source}`] || `[${target}] ${source}`;
  return { targetLanguage: target, sourceText: source, translatedText: translated };
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
      const translation = inferMockTranslation(prompt);
      const wantsJson = /JSON|json|translatedText|targetLanguage/.test(prompt);
      const content = wantsJson ? JSON.stringify(translation) : translation.translatedText;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-translation-eval",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
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
  process.env.TRAINING_LLM_BASE_URL = mockUrl;
  process.env.TRAINING_LLM_API_KEY = "translation-eval-key";
  process.env.TRAINING_LLM_MODEL = "translation-eval-mock";
}

async function stopMockServer() {
  if (!mockServer) return;
  await new Promise((resolve, reject) => {
    mockServer.close((error) => (error ? reject(error) : resolve()));
  });
  mockServer = null;
}

async function startAppServer(createApp) {
  appServer = http.createServer(createApp({ host: "127.0.0.1", port: 0 }));
  await new Promise((resolve, reject) => {
    appServer.once("error", reject);
    appServer.listen(0, "127.0.0.1", () => {
      appServer.off("error", reject);
      resolve();
    });
  });
  const address = appServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopAppServer() {
  if (!appServer) return;
  await new Promise((resolve, reject) => {
    appServer.close((error) => (error ? reject(error) : resolve()));
  });
  appServer = null;
  baseUrl = "";
}

async function request(pathname, options = {}) {
  const body = options.body && typeof options.body === "object"
    ? JSON.stringify(options.body)
    : options.body;
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { accept: "application/json", "content-type": "application/json", ...(options.headers || {}) },
    ...options,
    body,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { ok: response.ok, status: response.status, payload };
}

async function dispatch(message, sessionId = "translation-eval") {
  return await request("/api/agent/dispatch", {
    method: "POST",
    body: { sessionId, message },
  });
}

function assertTranslationResult(id, response, expectedLanguage) {
  const payload = response.payload || {};
  assert(response.ok, `${id}: expected 2xx translation response, got ${response.status} ${JSON.stringify(payload)}`);
  assert(payload.action === "translation", `${id}: expected action translation, got ${payload.action || "(missing)"} ${JSON.stringify(payload)}`);
  assert(translatedText(payload), `${id}: translatedText should be non-empty`);
  if (expectedLanguage) {
    assert(languageMatches(targetLanguage(payload), expectedLanguage), `${id}: expected targetLanguage ${expectedLanguage}, got ${targetLanguage(payload) || "(missing)"}`);
  }
}

async function runTranslationCase({ id, message, expectedLanguage, sessionId }) {
  const response = await dispatch(message, sessionId || `translation-eval-${id}`);
  assertTranslationResult(id, response, expectedLanguage);
  results.push({
    id,
    ok: true,
    action: response.payload.action,
    targetLanguage: targetLanguage(response.payload),
    translatedText: compact(translatedText(response.payload), 80),
  });
  return response.payload;
}

try {
  await startMockServer();

  const { createApp } = await import("../src/http/app.mjs");
  const { appendBossChatMessages } = await import("../src/boss-chat/store.mjs");
  const { closeTrainingDatabase } = await import("../src/sqlite-store.mjs");
  const { parseTranslationRequest, translateText } = await import("../src/chat/translation.mjs");

  await startAppServer(createApp);

  const health = await request("/api/health");
  assert(health.ok && health.payload?.stateOk, `health check failed: ${JSON.stringify(health.payload)}`);

  const longSource = "银嘉泵业核心卖点包括自有铸造、机加工、电机装配和测试，出口高速加工设备配合严格抽检，提升水力效率并降低噪声。".repeat(130);
  const suffixParsed = parseTranslationRequest(`${longSource} 翻译成英文`);
  assert(suffixParsed.matched, "suffix parser should match long source ending with translation command");
  assert(languageMatches(suffixParsed.targetLanguage, "en"), `suffix parser expected English target, got ${suffixParsed.targetLanguage}`);
  assert(suffixParsed.sourceText.length > 6000, `suffix parser should not silently truncate at 6000 chars, got ${suffixParsed.sourceText.length}`);
  assert(!suffixParsed.sourceText.includes("翻译成英文"), "suffix parser should remove the trailing translation command from sourceText");
  results.push({
    id: "parser-long-suffix-no-silent-truncation",
    ok: true,
    targetLanguage: suffixParsed.targetLanguage,
    sourceLength: suffixParsed.sourceText.length,
  });

  const marketingWithTranslationParsed = parseTranslationRequest("请帮我生成三篇英文文章，同时附带中文翻译");
  assert(!marketingWithTranslationParsed.matched, "article generation with attached Chinese translation should not be parsed as translate_text");
  results.push({
    id: "parser-marketing-with-translation-not-translate",
    ok: true,
    matched: marketingWithTranslationParsed.matched,
  });

  const tooLongResult = await translateText(`翻译成英文：${"长文本".repeat(10050)}`);
  assert(tooLongResult.action === "translation_request", `too long source should request split input, got ${tooLongResult.action}`);
  assert(tooLongResult.sourceTooLong === true, "too long source should report sourceTooLong");
  results.push({
    id: "too-long-source-clear-request",
    ok: true,
    action: tooLongResult.action,
    sourceLength: tooLongResult.sourceLength,
  });

  await runTranslationCase({
    id: "zh-to-en-explicit",
    message: "翻译成英文：这是一个电机培训系统",
    expectedLanguage: "en",
  });
  await runTranslationCase({
    id: "pump-zh-to-en-explicit",
    message: "翻译成英文：这是一台水泵",
    expectedLanguage: "en",
  });
  await runTranslationCase({
    id: "hello-to-zh",
    message: "把 hello 翻译成中文",
    expectedLanguage: "zh",
  });
  await runTranslationCase({
    id: "zh-to-ja",
    message: "翻译成日语：这个电机适合工业场景",
    expectedLanguage: "ja",
  });
  await runTranslationCase({
    id: "en-to-es-english-command",
    message: "translate to Spanish: high efficiency motor",
    expectedLanguage: "es",
  });
  await runTranslationCase({
    id: "default-zh-for-english-source",
    message: "翻译一下：high efficiency motor",
    expectedLanguage: "zh",
  });
  await runTranslationCase({
    id: "default-en-for-chinese-source",
    message: "翻译一下：高效电机",
    expectedLanguage: "en",
  });
  await runTranslationCase({
    id: "zh-suffix-command-to-en",
    message: "这个电机适合工业场景 翻译成英文",
    expectedLanguage: "en",
  });
  const longTailSource = `${"银嘉泵业核心卖点包括自有铸造、机加工、电机装配和测试，出口高速加工设备配合严格抽检，提升水力效率并降低噪声。".repeat(130)}末尾校验标记XYZ`;
  const longTailPayload = await runTranslationCase({
    id: "long-suffix-dispatch-preserves-tail",
    message: `${longTailSource} 翻译成英文`,
    expectedLanguage: "en",
  });
  assert(longTailPayload.sourceText.length > 6000, `long dispatch should preserve source over 6000 chars, got ${longTailPayload.sourceText.length}`);
  assert(longTailPayload.sourceText.includes("末尾校验标记XYZ"), "long dispatch sourceText should keep tail marker");
  assert(/tail marker XYZ/i.test(translatedText(longTailPayload)), `long dispatch should send tail marker to mock LLM, got ${translatedText(longTailPayload)}`);

  const noContext = await dispatch("翻译成法语", "translation-eval-no-context");
  assert(noContext.ok, `no-context request should not fail HTTP: ${noContext.status} ${JSON.stringify(noContext.payload)}`);
  assert(noContext.payload?.action === "translation_request", `no-context request expected action translation_request, got ${noContext.payload?.action || "(missing)"}`);
  const requestHint = JSON.stringify(noContext.payload);
  assert(/正文|内容|文本|上下文|text|content/i.test(requestHint), `translation_request should clearly ask for text/context: ${requestHint}`);
  results.push({ id: "fr-without-context", ok: true, action: noContext.payload.action });

  const contextSessionId = "translation-eval-context";
  await appendBossChatMessages(contextSessionId, [{
    role: "user",
    content: "high efficiency motor",
    action: "user_message",
  }], { title: "翻译上下文评测" });
  const contextPayload = await runTranslationCase({
    id: "fr-from-previous-boss-chat-message",
    message: "翻译成法语",
    expectedLanguage: "fr",
    sessionId: contextSessionId,
  });
  assert(translatedText(contextPayload), "context translation should return translatedText");

  const envSnapshot = {
    TRAINING_LLM_API_KEY: process.env.TRAINING_LLM_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.TRAINING_LLM_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const missingApi = await dispatch("翻译成英文：这是一个电机培训系统", "translation-eval-missing-api");
  Object.entries(envSnapshot).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  assert(missingApi.status === 200 || missingApi.status === 503, `missing LLM API should return handled response, got ${missingApi.status}`);
  assert(missingApi.payload?.action === "translation", `missing LLM API expected action translation, got ${missingApi.payload?.action || "(missing)"}`);
  const errorText = JSON.stringify({
    error: missingApi.payload?.error,
    errorMessage: missingApi.payload?.errorMessage,
    message: missingApi.payload?.message,
    translation: missingApi.payload?.translation,
  });
  assert(/TRAINING_LLM_API_KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY|API Key|大模型 API/i.test(errorText), `missing LLM API error should be clear, got ${errorText}`);
  results.push({ id: "missing-llm-api-clear-error", ok: true, action: missingApi.payload.action, status: missingApi.status });

  const persistenceSessionId = "translation-eval-persistence";
  const persistedPayload = await runTranslationCase({
    id: "boss-chat-persists-translation",
    message: "翻译成英文：这是一个电机培训系统",
    expectedLanguage: "en",
    sessionId: persistenceSessionId,
  });
  const readSession = await request(`/api/boss-chat/sessions/${encodeURIComponent(persistenceSessionId)}`);
  assert(readSession.ok, `read persisted boss chat session failed: ${readSession.status} ${JSON.stringify(readSession.payload)}`);
  const messages = readSession.payload?.messages || [];
  assert(messages.some((message) => message.role === "assistant" && message.action === "translation"), "boss chat should contain assistant action translation");
  assert(messages.some((message) => message.role === "assistant" && message.payload?.action === persistedPayload.action), "boss chat should persist translation payload");
  results.push({ id: "boss-chat-readback-action", ok: true, messageCount: messages.length });

  console.log(JSON.stringify({
    ok: true,
    dataDir: tempDir,
    mockUrl,
    total: results.length,
    results,
  }, null, 2));

  closeTrainingDatabase();
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    results,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await stopAppServer();
  await stopMockServer();
  try {
    const { closeTrainingDatabase } = await import("../src/sqlite-store.mjs");
    closeTrainingDatabase();
  } catch {
  }
  await rm(tempDir, { recursive: true, force: true });
}
