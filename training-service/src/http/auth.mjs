import { createHmac, timingSafeEqual } from "node:crypto";

const accessKey = process.env.TRAINING_ACCESS_KEY || process.env.OPENCLAW_TRAINING_ACCESS_KEY || "";
const accessCookieName = "training_access";
const accessCookieMaxAge = Number(process.env.TRAINING_ACCESS_COOKIE_MAX_AGE || 60 * 60 * 24 * 30);

export function authEnabled() {
  return Boolean(accessKey) && !["1", "true", "yes", "on"].includes(String(process.env.TRAINING_AUTH_DISABLED || "").toLowerCase());
}

export function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function accessToken() {
  return createHmac("sha256", accessKey).update("juzhou-agent-training-access").digest("base64url");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(header.split(";").map((part) => {
    const [name, ...valueParts] = part.trim().split("=");
    const rawValue = valueParts.join("=") || "";
    try {
      return [name, decodeURIComponent(rawValue)];
    } catch {
      return [name, rawValue];
    }
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

export function isAuthenticated(req) {
  if (!authEnabled()) return true;
  const headerKey = requestAccessKey(req);
  if (headerKey && safeEqual(headerKey, accessKey)) return true;
  const cookieToken = parseCookies(req)[accessCookieName];
  return Boolean(cookieToken) && safeEqual(cookieToken, accessToken());
}

export function loginWithAccessKey(req, res, key) {
  if (!authEnabled()) return { ok: true, enabled: false, authenticated: true };
  if (!safeEqual(key || "", accessKey)) return null;
  const secure = isSecureRequest(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${accessCookieName}=${encodeURIComponent(accessToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${accessCookieMaxAge}${secure}`);
  return { ok: true, enabled: true, authenticated: true };
}

export function clearAccessCookie(res) {
  res.setHeader("Set-Cookie", `${accessCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
