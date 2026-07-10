import { HttpError, badRequest } from "./errors.mjs";

export const DEFAULT_BODY_LIMIT = 1024 * 1024;

export async function readBody(req, { limit = DEFAULT_BODY_LIMIT } = {}) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new HttpError(413, "request body too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest("invalid JSON body");
  }
}
