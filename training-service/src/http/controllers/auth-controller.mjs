import { authEnabled, clearAccessCookie, isAuthenticated, loginWithAccessKey } from "../auth.mjs";
import { readBody } from "../request.mjs";
import { sendJson } from "../response.mjs";

export async function handleAuth(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    sendJson(res, 200, {
      enabled: authEnabled(),
      authenticated: isAuthenticated(req),
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(req);
    const result = loginWithAccessKey(req, res, body.key || body.accessKey || "");
    if (result) {
      sendJson(res, 200, result);
      return true;
    }
    sendJson(res, 401, { error: "访问密钥不正确" });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    clearAccessCookie(res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
