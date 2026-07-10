import { createHash } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_WS_MESSAGE_BYTES = 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function acceptKey(key) {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

export function acceptWebSocket(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key || req.headers["sec-websocket-version"] !== "13") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return false;
  }
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    "\r\n",
  ].join("\r\n"));
  return true;
}

function framePayload(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

export function sendWsJson(socket, payload) {
  if (socket.destroyed || !socket.writable) return;
  socket.write(framePayload(JSON.stringify(payload), 0x1));
}

export function sendWsPong(socket, payload = Buffer.alloc(0)) {
  if (socket.destroyed || !socket.writable) return;
  socket.write(framePayload(payload, 0xA));
}

export function closeWebSocket(socket, code = 1000, reason = "") {
  if (socket.destroyed || !socket.writable) return;
  const reasonBuffer = Buffer.from(String(reason).slice(0, 120));
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  socket.write(framePayload(payload, 0x8));
  socket.end();
}

export function createWebSocketParser({ onText, onClose, onPing, onProtocolError, maxMessageBytes = MAX_WS_MESSAGE_BYTES }) {
  let buffer = Buffer.alloc(0);
  let failed = false;
  const fail = (code, reason) => {
    if (failed) return;
    failed = true;
    if (onProtocolError) onProtocolError(code, reason);
  };
  return function parse(chunk) {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maxMessageBytes + 14) {
      fail(1009, "message too large");
      return;
    }
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const final = (first & 0x80) !== 0;
      const reserved = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      const control = opcode >= 0x8;
      if (reserved || !final || !masked || ![0x1, 0x8, 0x9, 0xA].includes(opcode)) {
        fail(1002, "invalid websocket frame");
        return;
      }
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const bigLength = buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(maxMessageBytes)) {
          fail(1009, "message too large");
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }
      if (length > maxMessageBytes || (control && length > 125)) {
        fail(length > maxMessageBytes ? 1009 : 1002, length > maxMessageBytes ? "message too large" : "invalid control frame");
        return;
      }
      let mask = null;
      if (buffer.length < offset + 4) return;
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      if (opcode === 0x8) {
        if (onClose) onClose();
        return;
      }
      if (opcode === 0x9) {
        if (onPing) onPing(payload);
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 && onText) {
        try {
          onText(utf8Decoder.decode(payload));
        } catch {
          fail(1007, "invalid UTF-8");
          return;
        }
      }
    }
  };
}

export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const expectedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase();
    const expectedProtocol = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https" ? "https:" : "http:";
    return parsed.host.toLowerCase() === expectedHost && parsed.protocol === expectedProtocol;
  } catch {
    return false;
  }
}
