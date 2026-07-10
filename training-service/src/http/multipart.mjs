import { HttpError } from "./errors.mjs";

function parseBoundary(contentType) {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] || match?.[2] || "";
}

async function readRawBody(req, maxBytes) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, `请求体超过限制：${Math.round(maxBytes / 1024 / 1024)}MB`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) {
      throw new HttpError(413, `请求体超过限制：${Math.round(maxBytes / 1024 / 1024)}MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function multipartTextField(parts, name, fallback = "") {
  return parts.find((part) => part.name === name && !part.filename)?.text?.trim() || fallback;
}

export function multipartStringArrayField(parts, name) {
  try {
    const parsed = JSON.parse(multipartTextField(parts, name, "[]"));
    return Array.isArray(parsed) ? parsed.map((item) => String(item || "")) : [];
  } catch {
    return [];
  }
}

function indexOfBuffer(buffer, target, start = 0) {
  return buffer.indexOf(target, start);
}

function trimCrlf(buffer) {
  let start = 0;
  let end = buffer.length;
  if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
  if (buffer[end - 2] === 13 && buffer[end - 1] === 10) end -= 2;
  return buffer.subarray(start, end);
}

function parseContentDisposition(value) {
  const result = {};
  for (const part of String(value || "").split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    const raw = rest.join("=");
    result[key] = raw ? raw.replace(/^"|"$/g, "") : true;
  }
  return result;
}

export async function readMultipart(req, { maxBytes }) {
  const contentType = req.headers["content-type"] || "";
  const boundary = parseBoundary(contentType);
  if (!boundary) throw new Error("缺少 multipart boundary");
  const body = await readRawBody(req, maxBytes);
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const separator = Buffer.from("\r\n\r\n");
  const parts = [];
  let cursor = indexOfBuffer(body, boundaryBuffer);
  while (cursor >= 0) {
    const next = indexOfBuffer(body, boundaryBuffer, cursor + boundaryBuffer.length);
    if (next < 0) break;
    let segment = trimCrlf(body.subarray(cursor + boundaryBuffer.length, next));
    if (segment[0] === 45 && segment[1] === 45) break;
    const headerEnd = indexOfBuffer(segment, separator);
    if (headerEnd >= 0) {
      const headerText = segment.subarray(0, headerEnd).toString("utf8");
      const content = segment.subarray(headerEnd + separator.length);
      const headers = {};
      for (const line of headerText.split(/\r?\n/)) {
        const index = line.indexOf(":");
        if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      const disposition = parseContentDisposition(headers["content-disposition"]);
      parts.push({
        name: disposition.name || "",
        filename: disposition.filename || "",
        contentType: headers["content-type"] || "",
        content,
        text: content.toString("utf8"),
      });
    }
    cursor = next;
  }
  return parts;
}
