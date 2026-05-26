import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const DEFAULT_AGENT_ID = "main";
const DEFAULT_TIMEOUT_MS = 120_000;
const sessionPatchCache = new Map();
let callGatewayPromise;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function canUseBuiltInWebSocket() {
  return typeof globalThis.WebSocket === "function";
}

async function probeGatewaySocket(url, timeoutMs) {
  const WebSocketCtor = globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    return { ok: false, error: "Node.js WebSocket client is unavailable" };
  }
  return await new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocketCtor(url);
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
      }
      resolve(value);
    };
    const timer = setTimeout(() => done({ ok: false, error: `OpenClaw gateway probe timeout after ${timeoutMs}ms` }), timeoutMs);
    ws.addEventListener("open", () => done({ ok: true }));
    ws.addEventListener("error", () => done({ ok: false, error: `OpenClaw gateway WebSocket error: ${url}` }));
    ws.addEventListener("close", () => done({ ok: false, error: `OpenClaw gateway closed before probe succeeded: ${url}` }));
  });
}

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
    moduleCandidateFromPath(path.resolve(__dirname, "..", "..", "..", "openclaw-runtime", "dist", "call.runtime.js")),
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
    return { ok: true, transport: "runtime", module: candidate.display };
  } catch (error) {
    if (canUseBuiltInWebSocket()) {
      const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || DEFAULT_GATEWAY_URL;
      const probe = await probeGatewaySocket(gatewayUrl, Number(process.env.OPENCLAW_HEALTH_TIMEOUT_MS || process.env.TRAINING_HEALTH_TIMEOUT_MS || 1000));
      return {
        ok: probe.ok,
        transport: "websocket",
        gatewayUrl,
        module: null,
        websocketAvailable: true,
        runtimeError: error instanceof Error ? error.message : String(error),
        ...(probe.error ? { error: probe.error } : {}),
      };
    }
    return { ok: false, transport: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
}

function readFrameText(data) {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof ArrayBuffer) return Promise.resolve(Buffer.from(data).toString("utf8"));
  if (ArrayBuffer.isView(data)) return Promise.resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
  if (data && typeof data.text === "function") return data.text();
  return Promise.resolve(String(data || ""));
}

function normalizeGatewayScopes(scopes) {
  const aliases = {
    admin: "operator.admin",
    read: "operator.read",
    write: "operator.write",
  };
  const values = Array.isArray(scopes) && scopes.length ? scopes : ["operator.read", "operator.write"];
  return [...new Set(values.map((scope) => aliases[String(scope || "").trim()] || String(scope || "").trim()).filter(Boolean))];
}

function directGatewayConnectParams(options, nonce) {
  const scopes = normalizeGatewayScopes(options.scopes);
  const auth = options.token || options.password ? {
    ...(options.token ? { token: options.token } : {}),
    ...(options.password ? { password: options.password } : {}),
  } : undefined;
  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: options.clientName || "gateway-client",
      displayName: options.clientDisplayName || "juzhou-agent-training-service",
      version: "training-service",
      platform: process.platform,
      mode: options.mode || "backend",
    },
    caps: [],
    role: "operator",
    scopes,
    ...(auth ? { auth } : {}),
    ...(nonce ? { device: undefined } : {}),
  };
}

async function callGatewayViaWebSocket(options) {
  const WebSocketCtor = globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new Error("Node.js WebSocket client is unavailable; use Node.js 24 or set OPENCLAW_RUNTIME_MODULE");
  }
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const url = options.url || DEFAULT_GATEWAY_URL;

  return await new Promise((resolve, reject) => {
    const ws = new WebSocketCtor(url);
    const pending = new Map();
    let connected = false;
    let settled = false;
    let connectSent = false;

    const cleanup = () => {
      for (const [, item] of pending) {
        clearTimeout(item.timeout);
      }
      pending.clear();
      try {
        ws.close();
      } catch {
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const request = (method, params, requestTimeoutMs = timeoutMs) => new Promise((requestResolve, requestReject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(id);
        requestReject(new Error(`OpenClaw gateway request timeout for ${method}`));
      }, requestTimeoutMs);
      pending.set(id, { resolve: requestResolve, reject: requestReject, timeout });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
    const sendConnect = async (nonce) => {
      if (connectSent) return;
      connectSent = true;
      try {
        await request("connect", directGatewayConnectParams(options, nonce), Math.min(timeoutMs, 15_000));
        connected = true;
        const result = await request(options.method, options.params, timeoutMs);
        finish(result);
      } catch (error) {
        fail(error);
      }
    };

    const connectTimer = setTimeout(() => {
      if (!connected) fail(new Error(`OpenClaw gateway connect timeout after ${Math.min(timeoutMs, 15_000)}ms`));
    }, Math.min(timeoutMs, 15_000));

    ws.addEventListener("open", () => {
      if (process.env.OPENCLAW_GATEWAY_NO_CHALLENGE === "1") {
        void sendConnect("");
      }
    });
    ws.addEventListener("message", (event) => {
      void readFrameText(event.data).then((text) => {
        if (!text) return;
        const frame = JSON.parse(text);
        if (frame?.type === "event") {
          if (frame.event === "connect.challenge") {
            clearTimeout(connectTimer);
            void sendConnect(String(frame.payload?.nonce || ""));
          }
          return;
        }
        if (frame?.type !== "res") return;
        const item = pending.get(frame.id);
        if (!item) return;
        pending.delete(frame.id);
        clearTimeout(item.timeout);
        if (frame.ok) {
          item.resolve(frame.payload);
        } else {
          const message = frame.error?.message || frame.error?.code || "OpenClaw gateway request failed";
          item.reject(new Error(message));
        }
      }).catch(fail);
    });
    ws.addEventListener("error", () => fail(new Error(`OpenClaw gateway WebSocket error: ${url}`)));
    ws.addEventListener("close", () => {
      if (!settled) fail(new Error(`OpenClaw gateway closed before response: ${url}`));
    });
  });
}

async function getCallGateway() {
  if (!callGatewayPromise) {
    callGatewayPromise = (async () => {
      if (["websocket", "direct"].includes(String(process.env.OPENCLAW_GATEWAY_TRANSPORT || "").toLowerCase())) {
        return callGatewayViaWebSocket;
      }
      try {
        const candidate = await resolveOpenClawRuntimeModule();
        const module = await import(candidate.specifier);
        if (typeof module.callGateway !== "function") {
          throw new Error("OpenClaw runtime did not export callGateway");
        }
        return module.callGateway;
      } catch {
        return callGatewayViaWebSocket;
      }
    })()
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

