import { createHash } from "node:crypto";

function updateCanonicalHash(hash, value, seen = new Set()) {
  if (value === null) {
    hash.update("null;");
    return;
  }
  const type = typeof value;
  if (type === "string") {
    hash.update(`string:${Buffer.byteLength(value, "utf8")}:`);
    hash.update(value);
    hash.update(";");
    return;
  }
  if (["number", "boolean", "bigint", "undefined"].includes(type)) {
    hash.update(`${type}:${String(value)};`);
    return;
  }
  if (type !== "object") {
    hash.update(`${type}:${String(value)};`);
    return;
  }
  if (seen.has(value)) throw new TypeError("State revisions require JSON-compatible chunks.");
  seen.add(value);
  if (Array.isArray(value)) {
    hash.update(`array:${value.length}:[`);
    for (const item of value) updateCanonicalHash(hash, item, seen);
    hash.update("];");
  } else {
    const keys = Object.keys(value).sort();
    hash.update(`object:${keys.length}:{`);
    for (const key of keys) {
      updateCanonicalHash(hash, key, seen);
      updateCanonicalHash(hash, value[key], seen);
    }
    hash.update("};");
  }
  seen.delete(value);
}

export function computeChunksRevision(chunks = []) {
  const hash = createHash("sha256");
  hash.update("juzhou-state-chunks-v1;");
  updateCanonicalHash(hash, Array.isArray(chunks) ? chunks : []);
  return hash.digest("hex");
}

export function prepareStateCommit(state, updatedAt = new Date().toISOString()) {
  const value = state && typeof state === "object" ? state : {};
  value.meta = {
    ...(value.meta || {}),
    version: 1,
    updatedAt,
    chunksRevision: computeChunksRevision(value.chunks),
  };
  return value;
}
