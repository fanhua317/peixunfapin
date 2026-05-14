import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const DEFAULT_AGENT_ID = "main";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FLASH_MODEL = process.env.OPENCLAW_FLASH_MODEL || process.env.OPENCLAW_AI_MODEL || "deepseek/deepseek-v4-flash";
const GENERAL_CHAT_SIMPLE_THINKING = process.env.OPENCLAW_GENERAL_CHAT_SIMPLE_THINKING || process.env.OPENCLAW_CHAT_SIMPLE_THINKING || "low";
const GENERAL_CHAT_COMPLEX_THINKING = process.env.OPENCLAW_GENERAL_CHAT_COMPLEX_THINKING || process.env.OPENCLAW_CHAT_COMPLEX_THINKING || process.env.OPENCLAW_GENERAL_CHAT_THINKING || process.env.OPENCLAW_CHAT_THINKING || "medium";
const GENERAL_CHAT_MODEL = process.env.OPENCLAW_GENERAL_CHAT_MODEL || process.env.OPENCLAW_CHAT_MODEL || DEFAULT_FLASH_MODEL;
const sessionPatchCache = new Map();
let callGatewayPromise;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function moduleCandidateFromPath(filePath) {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  return {
    display: fullPath,
    checkPath: fullPath,
    specifier: pathToFileURL(fullPath).href,
  };
}

function getOpenClawRuntimeCandidates() {
  const candidates = [];
  if (process.env.OPENCLAW_RUNTIME_MODULE) {
    const value = process.env.OPENCLAW_RUNTIME_MODULE;
    if (/^(?:file|data|node|https?):/i.test(value)) {
      candidates.push({ display: value, specifier: value });
    } else {
      candidates.push(moduleCandidateFromPath(value));
    }
  }
  candidates.push(
    moduleCandidateFromPath(path.resolve(__dirname, "..", "..", "openclaw-runtime", "dist", "call.runtime.js")),
    moduleCandidateFromPath(path.resolve(__dirname, "..", "..", "..", "openclaw", "dist", "call.runtime.js")),
  );
  if (process.env.LOCALAPPDATA) {
    candidates.push(
      moduleCandidateFromPath(path.join(process.env.LOCALAPPDATA, "openclaw", "dist", "call.runtime.js")),
      moduleCandidateFromPath(path.join(process.env.LOCALAPPDATA, "OpenClaw", "dist", "call.runtime.js")),
    );
  }
  return candidates;
}

export async function resolveOpenClawRuntimeModule() {
  const tried = [];
  for (const candidate of getOpenClawRuntimeCandidates()) {
    tried.push(candidate.display);
    if (candidate.checkPath) {
      try {
        await access(candidate.checkPath);
      } catch {
        continue;
      }
    }
    return candidate;
  }
  throw new Error(`Cannot find OpenClaw gateway runtime call.runtime.js. Tried: ${tried.join(", ")}`);
}

export async function getOpenClawRuntimeStatus() {
  try {
    const candidate = await resolveOpenClawRuntimeModule();
    return { ok: true, module: candidate.display };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function getCallGateway() {
  if (!callGatewayPromise) {
    callGatewayPromise = resolveOpenClawRuntimeModule()
      .then((candidate) => import(candidate.specifier))
      .then((module) => {
        if (typeof module.callGateway !== "function") {
          throw new Error("OpenClaw runtime did not export callGateway");
        }
        return module.callGateway;
      })
      .catch((error) => {
        callGatewayPromise = undefined;
        throw new Error(`OpenClaw gateway runtime unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
  return await callGatewayPromise;
}

function readConfig() {
  const agentId = process.env.OPENCLAW_AGENT_ID || DEFAULT_AGENT_ID;
  return {
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    token: process.env.OPENCLAW_GATEWAY_TOKEN || process.env.GATEWAY_TOKEN,
    password: process.env.OPENCLAW_GATEWAY_PASSWORD || process.env.GATEWAY_PASSWORD,
    sessionKey: process.env.OPENCLAW_SESSION_KEY || `agent:${agentId}:main`,
    timeoutMs: Number(process.env.OPENCLAW_CHAT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    agentId,
  };
}

function extractTextFromMessage(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function messageSeq(message) {
  const seq = message?.__openclaw?.seq;
  return typeof seq === "number" ? seq : 0;
}

function maxMessageSeq(messages) {
  return Array.isArray(messages) ? Math.max(0, ...messages.map(messageSeq)) : 0;
}

function latestAssistantTextAfter(messages, minSeq) {
  if (!Array.isArray(messages)) return "";
  for (const message of [...messages].reverse()) {
    const role = String(message?.role || "").toLowerCase();
    if (role !== "assistant") continue;
    if (messageSeq(message) <= minSeq) continue;
    const text = extractTextFromMessage(message);
    if (text) return text;
  }
  for (const message of [...messages].reverse()) {
    if (String(message?.role || "").toLowerCase() !== "assistant") continue;
    const text = extractTextFromMessage(message);
    if (text) return text;
  }
  return "";
}

function fallbackReply(error) {
  return [
    "我已经把网页端设计成可转接 OpenClaw 的套壳，但当前 training-service 无法连接 OpenClaw Gateway。",
    `原因：${error instanceof Error ? error.message : String(error)}`,
    "请确认 OpenClaw Gateway 正在运行，并给 training-service 配置 OPENCLAW_GATEWAY_URL 以及 OPENCLAW_GATEWAY_TOKEN 或 OPENCLAW_GATEWAY_PASSWORD。",
  ].join("\n");
}

function resolveGeneralChatThinking(text) {
  return /(分析|方案|对比|比较|为什么|如何|怎么|策略|设计|优化|权衡|规划|推理|复杂|详细|深度|长文|报告)/.test(String(text || ""))
    ? GENERAL_CHAT_COMPLEX_THINKING
    : GENERAL_CHAT_SIMPLE_THINKING;
}

function shouldPatchSession() {
  return !["0", "false", "off", "no"].includes(String(process.env.OPENCLAW_SESSION_PATCH || "").toLowerCase());
}

async function patchOpenClawSession({ base, sessionKey, thinking, model, timeoutMs }) {
  if (!shouldPatchSession()) return null;
  const patch = {
    ...(model ? { model } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {}),
  };
  if (!Object.keys(patch).length) return null;
  const cacheKey = JSON.stringify({ sessionKey, ...patch });
  if (sessionPatchCache.has(cacheKey)) return sessionPatchCache.get(cacheKey);
  try {
    const callGateway = await getCallGateway();
    const result = await callGateway({
      ...base,
      scopes: ["admin"],
      method: "sessions.patch",
      params: {
        key: sessionKey,
        ...patch,
      },
      timeoutMs,
    });
    const value = { ok: true, model, thinking, resolved: result?.resolved };
    sessionPatchCache.set(cacheKey, value);
    return value;
  } catch (error) {
    const value = {
      ok: false,
      model,
      thinking,
      error: error instanceof Error ? error.message : String(error),
    };
    sessionPatchCache.set(cacheKey, value);
    return value;
  }
}

async function waitForOpenClawReply({ config, message, thinking, model }) {
  const runId = randomUUID();
  const callGateway = await getCallGateway();
  const base = {
    url: process.env.OPENCLAW_GATEWAY_URL ? config.gatewayUrl : undefined,
    token: config.token,
    password: config.password,
    timeoutMs: config.timeoutMs,
    clientName: "gateway-client",
    clientDisplayName: "juzhou-web-shell",
    mode: "backend",
    scopes: ["operator.read", "operator.write"],
  };
  const sessionPatch = await patchOpenClawSession({
    base,
    sessionKey: config.sessionKey,
    thinking,
    model,
    timeoutMs: config.timeoutMs,
  });
  const beforeHistory = await callGateway({
    ...base,
    method: "chat.history",
    params: {
      sessionKey: config.sessionKey,
      limit: 20,
    },
  });
  const beforeSeq = maxMessageSeq(beforeHistory?.messages);
  const sendResult = await callGateway({
    ...base,
    method: "chat.send",
    params: {
      sessionKey: config.sessionKey,
      message,
      ...(thinking ? { thinking } : {}),
      deliver: false,
      idempotencyKey: runId,
      timeoutMs: config.timeoutMs,
    },
  });
  const finalRunId = sendResult?.runId || runId;
  const waitResult = await callGateway({
    ...base,
    method: "agent.wait",
    params: {
      runId: finalRunId,
      timeoutMs: config.timeoutMs,
    },
  });
  if (waitResult?.status !== "ok") {
    throw new Error(`OpenClaw run did not finish: ${waitResult?.status || "unknown"}`);
  }
  const afterHistory = await callGateway({
    ...base,
    method: "chat.history",
    params: {
      sessionKey: config.sessionKey,
      limit: 30,
    },
  });
  return {
    answer: latestAssistantTextAfter(afterHistory?.messages, beforeSeq) || "OpenClaw 已完成处理，但没有返回可显示文本。",
    source: "openclaw",
    sessionKey: afterHistory?.sessionKey || config.sessionKey,
    runId: finalRunId,
    thinking,
    model,
    sessionPatch,
  };
}

export async function askOpenClaw(message, options = {}) {
  const config = {
    ...readConfig(),
    ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
    ...(options.timeoutMs ? { timeoutMs: Number(options.timeoutMs) } : {}),
  };
  return await waitForOpenClawReply({
    config,
    message,
    thinking: options.thinking || options.thinkingLevel,
    model: options.model,
  });
}

export async function answerGeneralChat(message) {
  const text = String(message || "").trim();
  if (!text) {
    return { answer: "请先输入你的问题。", source: "fallback" };
  }

  try {
    return await askOpenClaw(text, {
      thinking: resolveGeneralChatThinking(text),
      model: GENERAL_CHAT_MODEL,
    });
  } catch (error) {
    return { answer: fallbackReply(error), source: "fallback" };
  }
}
