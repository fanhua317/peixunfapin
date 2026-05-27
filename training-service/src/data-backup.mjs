import Database from "better-sqlite3";
import { unzipSync, zipSync } from "fflate";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import packageInfo from "../package.json" with { type: "json" };
import { knowledgeBaseVersionsPath } from "./knowledge-base-versions.mjs";
import { conversationHistoryPath, loadMemoryStore, memoryPath } from "./memory/store.mjs";
import { dataDir, loadState, statePath } from "./store.mjs";
import { closeTrainingDatabase, openTrainingDatabase, sqlitePathFor, SQLITE_SCHEMA_VERSION } from "./sqlite-store.mjs";

export const BACKUP_MANIFEST_VERSION = 1;
export const BACKUP_KIND = "juzhou-training-data-backup";

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function timestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function optionalFile(filePath) {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? stats : null;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function collectFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(rootDir, absolute));
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = toPosix(path.relative(rootDir, absolute));
    const data = await readFile(absolute);
    files.push({
      path: relative,
      absolute,
      data,
      size: data.length,
      sha256: sha256(data),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveOutputPath(options = {}) {
  const defaultDir = path.join(dataDir, "backups");
  const out = options.out ? path.resolve(options.out) : defaultDir;
  const initialPath = path.extname(out).toLowerCase() === ".zip"
    ? out
    : path.join(out, `training-backup-${timestampForFile()}.zip`);
  if (!existsSync(initialPath)) return initialPath;
  const parsed = path.parse(initialPath);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a unique backup path near: ${initialPath}`);
}

async function copyOptionalRuntimeFile(sourcePath, stagingDir, relativePath) {
  const stats = await optionalFile(sourcePath);
  if (!stats) return false;
  const target = path.join(stagingDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await readFile(sourcePath));
  return true;
}

async function copyVectorIndexes(stagingDir) {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch((error) => {
    if (error && error.code === "ENOENT") return [];
    throw error;
  });
  const copied = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^vector-index-.+\.json$/i.test(entry.name)) continue;
    const source = path.join(dataDir, entry.name);
    const target = path.join(stagingDir, entry.name);
    await writeFile(target, await readFile(source));
    copied.push(entry.name);
  }
  return copied;
}

async function writeSqliteSnapshot(stagingDir) {
  const sqlitePath = sqlitePathFor(dataDir);
  await mkdir(stagingDir, { recursive: true });
  await loadState();
  await loadMemoryStore();
  const db = openTrainingDatabase(dataDir);
  const targetPath = path.join(stagingDir, "training.db");
  await db.backup(targetPath);
  closeTrainingDatabase();
  return { sqlitePath, targetPath };
}

export async function createDataBackup(options = {}) {
  const backupPath = resolveOutputPath(options);
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-backup-stage-"));
  try {
    await mkdir(path.dirname(backupPath), { recursive: true });
    const sqlite = await writeSqliteSnapshot(stagingDir);
    const state = await loadState();
    const memory = await loadMemoryStore();
    await writeJson(path.join(stagingDir, "state.json"), state);
    await writeJson(path.join(stagingDir, "memory.json"), memory);
    await copyOptionalRuntimeFile(conversationHistoryPath, stagingDir, "conversation-history.jsonl");
    await copyOptionalRuntimeFile(path.join(dataDir, "agent-traces.jsonl"), stagingDir, "agent-traces.jsonl");
    await copyOptionalRuntimeFile(path.join(dataDir, "jobs.json"), stagingDir, "jobs.json");
    await copyOptionalRuntimeFile(knowledgeBaseVersionsPath, stagingDir, "knowledge-base-versions.json");
    await copyVectorIndexes(stagingDir);

    const stagedFiles = (await collectFiles(stagingDir)).filter((file) => file.path !== "manifest.json");
    const manifest = {
      kind: BACKUP_KIND,
      version: BACKUP_MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      project: {
        name: packageInfo.name,
        version: packageInfo.version,
      },
      schemaVersion: SQLITE_SCHEMA_VERSION,
      dataDir,
      sqlitePath: sqlite.sqlitePath,
      storage: process.env.TRAINING_STORAGE || "sqlite",
      files: stagedFiles.map((file) => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        required: ["training.db", "state.json", "memory.json"].includes(file.path),
      })),
    };
    await writeJson(path.join(stagingDir, "manifest.json"), manifest);

    const files = await collectFiles(stagingDir);
    const zipEntries = Object.fromEntries(files.map((file) => [file.path, file.data]));
    const zipped = zipSync(zipEntries, { level: 6 });
    await writeFile(backupPath, Buffer.from(zipped));
    const backupStats = await stat(backupPath);
    return {
      ok: true,
      backupPath,
      bytes: backupStats.size,
      fileCount: manifest.files.length,
      manifest,
    };
  } finally {
    closeTrainingDatabase();
    await rm(stagingDir, { recursive: true, force: true });
  }
}

function getZipEntries(zipPath) {
  const buffer = existsSync(zipPath) ? Buffer.from(readFileSync(zipPath)) : null;
  if (!buffer) throw new Error(`Backup file not found: ${zipPath}`);
  return unzipSync(buffer);
}

function parseManifest(entries) {
  const raw = entries["manifest.json"];
  if (!raw) throw new Error("Backup manifest.json is missing.");
  const manifest = JSON.parse(Buffer.from(raw).toString("utf8"));
  if (manifest.kind !== BACKUP_KIND) throw new Error(`Unsupported backup kind: ${manifest.kind || ""}`);
  if (manifest.version !== BACKUP_MANIFEST_VERSION) throw new Error(`Unsupported backup manifest version: ${manifest.version}`);
  return manifest;
}

async function verifySqliteBytes(data) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-backup-verify-"));
  try {
    const dbPath = path.join(tempDir, "training.db");
    await writeFile(dbPath, Buffer.from(data));
    const db = new Database(dbPath, { readonly: true });
    try {
      const result = db.pragma("integrity_check", { simple: true });
      if (result !== "ok") throw new Error(`SQLite integrity_check failed: ${result}`);
    } finally {
      db.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function verifyDataBackup(options = {}) {
  const sourcePath = options.from || options.backupPath;
  if (!sourcePath) throw new Error("Missing --from <backup.zip>.");
  const backupPath = path.resolve(sourcePath);
  const entries = getZipEntries(backupPath);
  const manifest = parseManifest(entries);
  const verifiedFiles = [];
  for (const file of manifest.files || []) {
    const data = entries[file.path];
    if (!data) {
      if (file.required) throw new Error(`Required backup file is missing: ${file.path}`);
      continue;
    }
    const buffer = Buffer.from(data);
    const actualSha = sha256(buffer);
    if (buffer.length !== file.size) throw new Error(`Backup file size mismatch: ${file.path}`);
    if (actualSha !== file.sha256) throw new Error(`Backup file checksum mismatch: ${file.path}`);
    verifiedFiles.push(file.path);
  }
  if (entries["training.db"]) await verifySqliteBytes(entries["training.db"]);
  return {
    ok: true,
    backupPath,
    manifest,
    fileCount: verifiedFiles.length,
    verifiedFiles,
  };
}

async function writeRestoredFile(relativePath, data) {
  const target = path.join(dataDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(data));
  return target;
}

async function removeIfExists(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}

export async function restoreDataBackup(options = {}) {
  const sourcePath = options.from || options.backupPath;
  if (!sourcePath) throw new Error("Missing --from <backup.zip>.");
  const backupPath = path.resolve(sourcePath);
  const verification = await verifyDataBackup({ from: backupPath });
  if (!options.force) {
    return {
      ok: true,
      restored: false,
      requiresForce: true,
      backupPath,
      manifest: verification.manifest,
      message: "Backup verified. Re-run with --force to restore.",
    };
  }

  const entries = getZipEntries(backupPath);
  const safetyBackup = await createDataBackup();
  closeTrainingDatabase();
  await mkdir(dataDir, { recursive: true });
  const sqlitePath = sqlitePathFor(dataDir);
  await removeIfExists(sqlitePath);
  await removeIfExists(`${sqlitePath}-wal`);
  await removeIfExists(`${sqlitePath}-shm`);

  const restored = [];
  for (const file of verification.manifest.files || []) {
    const data = entries[file.path];
    if (!data) continue;
    if (file.path === "training.db") {
      await writeFile(sqlitePath, Buffer.from(data));
      restored.push(sqlitePath);
      continue;
    }
    if (
      file.path === "state.json" ||
      file.path === "memory.json" ||
      file.path === "conversation-history.jsonl" ||
      file.path === "agent-traces.jsonl" ||
      file.path === "jobs.json" ||
      file.path === "knowledge-base-versions.json" ||
      /^vector-index-.+\.json$/i.test(file.path)
    ) {
      restored.push(await writeRestoredFile(file.path, data));
    }
  }

  const state = await loadState();
  const memory = await loadMemoryStore();
  closeTrainingDatabase();
  return {
    ok: true,
    restored: true,
    backupPath,
    safetyBackupPath: safetyBackup.backupPath,
    restoredFiles: restored,
    counts: {
      knowledgeBases: state.knowledgeBases?.length || 0,
      chunks: state.chunks?.length || 0,
      tasks: state.tasks?.length || 0,
      memories: memory.memories?.length || 0,
    },
  };
}
