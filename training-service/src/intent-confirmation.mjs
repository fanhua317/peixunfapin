import crypto from "node:crypto";

const TOKEN_VERSION = 1;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function tokenSecret() {
  return String(
    process.env.TRAINING_CONFIRMATION_SECRET ||
      process.env.TRAINING_ACCESS_KEY ||
      "juzhou-training-local-confirmation",
  );
}

function hashMessage(message) {
  return crypto.createHash("sha256").update(String(message || ""), "utf8").digest("hex");
}

function signPayload(encodedPayload) {
  return crypto.createHmac("sha256", tokenSecret()).update(encodedPayload).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createIntentConfirmationToken(message, skill, options = {}) {
  const issuedAt = Number(options.now) || Date.now();
  const ttlMs = Number(options.ttlMs) || DEFAULT_TTL_MS;
  const payload = {
    v: TOKEN_VERSION,
    skill: String(skill || ""),
    messageHash: hashMessage(message),
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return {
    token: `${encodedPayload}.${signPayload(encodedPayload)}`,
    expiresAt: new Date(payload.expiresAt).toISOString(),
  };
}

export function verifyIntentConfirmationToken(token, { message, skill, now = Date.now() } = {}) {
  const value = String(token || "").trim();
  if (!value) return { ok: false, reason: "missing_confirmation_token" };
  const [encodedPayload, signature, extra] = value.split(".");
  if (!encodedPayload || !signature || extra) return { ok: false, reason: "invalid_confirmation_token" };
  if (!safeEqual(signature, signPayload(encodedPayload))) return { ok: false, reason: "invalid_confirmation_signature" };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid_confirmation_payload" };
  }
  if (payload?.v !== TOKEN_VERSION) return { ok: false, reason: "unsupported_confirmation_token" };
  if (payload.skill !== String(skill || "")) return { ok: false, reason: "confirmation_skill_mismatch" };
  if (payload.messageHash !== hashMessage(message)) return { ok: false, reason: "confirmation_message_mismatch" };
  if (!Number.isFinite(payload.expiresAt) || Number(now) > payload.expiresAt) {
    return { ok: false, reason: "confirmation_token_expired" };
  }
  return {
    ok: true,
    issuedAt: new Date(payload.issuedAt).toISOString(),
    expiresAt: new Date(payload.expiresAt).toISOString(),
  };
}
