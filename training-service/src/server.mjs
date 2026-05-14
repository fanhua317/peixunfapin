import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  answerQuestion,
  createTaskDraft,
  generateQuiz,
  getReportsOverview,
  getTaskStatus,
  listKnowledgeBases,
  openInvite,
  publishTask,
  searchEmployees,
  submitQuiz,
} from "./domain.mjs";
import { answerGeneralChat } from "./general-chat.mjs";
import { getRuntimeHealth, getVectorIndexStatus } from "./health.mjs";
import { getKnowledgeBaseQuality } from "./quality.mjs";
import { dataDir, loadState, mutateState } from "./store.mjs";
import { classifyTrainingIntent } from "./training-ai.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(__dirname, "..");
const publicDir = path.join(serviceRoot, "public");

const port = Number(process.env.PORT || process.env.TRAINING_SERVICE_PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const accessKey = process.env.TRAINING_ACCESS_KEY || process.env.OPENCLAW_TRAINING_ACCESS_KEY || "";
const accessCookieName = "training_access";
const accessCookieMaxAge = Number(process.env.TRAINING_ACCESS_COOKIE_MAX_AGE || 60 * 60 * 24 * 30);

function authEnabled() {
  return Boolean(accessKey) && !["1", "true", "yes", "on"].includes(String(process.env.TRAINING_AUTH_DISABLED || "").toLowerCase());
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function accessToken() {
  return createHmac("sha256", accessKey).update("openclaw-training-access").digest("base64url");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(header.split(";").map((part) => {
    const [name, ...valueParts] = part.trim().split("=");
    return [name, decodeURIComponent(valueParts.join("=") || "")];
  }).filter(([name]) => name));
}

function requestAccessKey(req) {
  const headerValue = req.headers["x-training-access-key"];
  if (typeof headerValue === "string" && headerValue) return headerValue;
  const authorization = req.headers.authorization || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  return bearer ? bearer[1] : "";
}

function isSecureRequest(req) {
  return req.socket.encrypted || req.headers["x-forwarded-proto"] === "https" || process.env.TRAINING_COOKIE_SECURE === "1";
}

function isAuthenticated(req) {
  if (!authEnabled()) return true;
  const headerKey = requestAccessKey(req);
  if (headerKey && safeEqual(headerKey, accessKey)) return true;
  const cookieToken = parseCookies(req)[accessCookieName];
  return Boolean(cookieToken) && safeEqual(cookieToken, accessToken());
}

function setAccessCookie(req, res) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${accessCookieName}=${encodeURIComponent(accessToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${accessCookieMaxAge}${secure}`);
}

function clearAccessCookie(res) {
  res.setHeader("Set-Cookie", `${accessCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function publicBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/$/, "") : "";
  const mode = String(process.env.PUBLIC_BASE_URL_MODE || process.env.TRAINING_PUBLIC_BASE_URL_MODE || "request").toLowerCase();
  const proto = req.headers["x-forwarded-proto"] || "http";
  const hostHeader = req.headers.host || `${host}:${port}`;
  const requestBase = `${proto}://${hostHeader}`.replace(/\/$/, "");
  if (mode === "env" && configured) return configured;
  if (mode === "auto" && configured && /^https?:\/\//i.test(configured)) return configured;
  return requestBase || configured;
}

async function servePublic(res, pathname) {
  const fileName = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const filePath = path.resolve(publicDir, fileName);
  if (!filePath.startsWith(publicDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const content = await readFile(filePath, "utf8");
    const ext = path.extname(filePath);
    const contentType = ext === ".css" ? "text/css; charset=utf-8" : ext === ".js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
    sendText(res, 200, content, contentType);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const index = await readFile(path.join(publicDir, "index.html"), "utf8");
      sendText(res, 200, index, "text/html; charset=utf-8");
      return;
    }
    throw error;
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    sendJson(res, 200, {
      enabled: authEnabled(),
      authenticated: isAuthenticated(req),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(req);
    if (!authEnabled()) {
      sendJson(res, 200, { ok: true, enabled: false, authenticated: true });
      return;
    }
    if (safeEqual(body.key || body.accessKey || "", accessKey)) {
      setAccessCookie(req, res);
      sendJson(res, 200, { ok: true, enabled: true, authenticated: true });
      return;
    }
    sendJson(res, 401, { error: "invalid access key" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    clearAccessCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthenticated(req)) {
    sendJson(res, 401, { error: "access key required" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    let state = null;
    let stateError = "";
    try {
      state = await loadState();
    } catch (error) {
      stateError = error instanceof Error ? error.message : String(error);
    }
    const runtime = await getRuntimeHealth();
    sendJson(res, 200, {
      ok: !stateError,
      service: "openclaw-training-service",
      stateOk: !stateError,
      stateError,
      qdrantOk: runtime.qdrantOk,
      ollamaOk: runtime.ollamaOk,
      openclawRuntimeOk: runtime.openclawRuntimeOk,
      llmProvider: runtime.llmProvider,
      llmConfigured: runtime.llmConfigured,
      retrievalMode: runtime.retrievalMode,
      dataDir,
      counts: state ? {
        knowledgeBases: state.knowledgeBases?.length || 0,
        documents: state.documents?.length || 0,
        chunks: state.chunks?.length || 0,
        tasks: state.tasks?.length || 0,
        invites: state.invites?.length || 0,
        quizzes: state.quizzes?.length || 0,
        attempts: state.attempts?.length || 0,
      } : null,
      runtime,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/knowledge-bases") {
    const state = await loadState();
    sendJson(res, 200, { knowledgeBases: listKnowledgeBases(state) });
    return;
  }

  const qualityMatch = url.pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/quality$/);
  if (req.method === "GET" && qualityMatch) {
    const state = await loadState();
    const runtime = await getRuntimeHealth();
    const knowledgeBaseId = decodeURIComponent(qualityMatch[1]);
    const vectorIndex = await getVectorIndexStatus(state, knowledgeBaseId, runtime);
    sendJson(res, 200, {
      quality: getKnowledgeBaseQuality(state, knowledgeBaseId, vectorIndex),
      retrievalMode: runtime.retrievalMode,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/reports/overview") {
    const state = await loadState();
    sendJson(res, 200, { report: getReportsOverview(state) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/employees") {
    const state = await loadState();
    sendJson(res, 200, { employees: searchEmployees(state, url.searchParams.get("q") || "") });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/draft") {
    const body = await readBody(req);
    const state = await loadState();
    sendJson(res, 200, { draft: createTaskDraft(state, body.instruction || "") });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/dispatch") {
    const body = await readBody(req);
    const message = body.message || body.instruction || "";
    const state = await loadState();
    const decision = await classifyTrainingIntent(state, message);
    if (decision.skill === "create_training_draft" || decision.intent === "create_training_draft") {
      sendJson(res, 200, {
        action: "draft",
        decision,
        draft: createTaskDraft(state, message),
      });
      return;
    }
    if (decision.skill === "show_training_status" || decision.intent === "show_training_status") {
      sendJson(res, 200, {
        action: "status",
        decision,
        tasks: state.tasks.map((task) => getTaskStatus(state, task.id)),
      });
      return;
    }
    sendJson(res, 200, {
      action: "chat",
      decision,
      ...(await answerGeneralChat(message)),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const body = await readBody(req);
    sendJson(res, 200, await answerGeneralChat(body.message || ""));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks/publish") {
    const body = await readBody(req);
    const result = await mutateState((state) => publishTask(state, body.draft));
    const base = publicBaseUrl(req);
    sendJson(res, 200, {
      ...result,
      inviteLinks: result.invites.map((invite) => ({
        employeeName: invite.employeeName,
        temporary: invite.temporary === true,
        token: invite.token,
        url: `${base}/t/${invite.token}`,
      })),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    const state = await loadState();
    sendJson(res, 200, {
      tasks: state.tasks.map((task) => getTaskStatus(state, task.id)),
    });
    return;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === "GET" && taskMatch) {
    const state = await loadState();
    const status = getTaskStatus(state, taskMatch[1]);
    if (!status) {
      sendJson(res, 404, { error: "task not found" });
      return;
    }
    const base = publicBaseUrl(req);
    sendJson(res, 200, {
      ...status,
      inviteLinks: status.invites.map((invite) => ({
        employeeName: invite.employeeName,
        temporary: invite.temporary === true,
        token: invite.token,
        url: `${base}/t/${invite.token}`,
      })),
    });
    return;
  }

  const inviteMatch = url.pathname.match(/^\/api\/invites\/([^/]+)$/);
  if (req.method === "GET" && inviteMatch) {
    const result = await mutateState((state) => openInvite(state, inviteMatch[1]));
    if (!result) {
      sendJson(res, 404, { error: "invite not found" });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/answer") {
    const body = await readBody(req);
    const state = await loadState();
    sendJson(res, 200, await answerQuestion(state, body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/quiz/generate") {
    const body = await readBody(req);
    const quiz = await mutateState((state) => generateQuiz(state, body.taskId));
    sendJson(res, 200, { quiz });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/quiz/submit") {
    const body = await readBody(req);
    try {
      const result = await mutateState((state) => submitQuiz(state, body));
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await servePublic(res, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`OpenClaw training service listening at http://${host}:${port}`);
});
