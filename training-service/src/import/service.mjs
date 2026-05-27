import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRuntimeHealth, getVectorIndexStatus } from "../health.mjs";
import { getKnowledgeBaseQuality } from "../quality.mjs";
import { dataDir, loadState } from "../store.mjs";
import { cleanRawDirectory, walkFiles } from "./cleaner.mjs";
import { importCleanDirectory } from "./importer.mjs";

export const ALLOWED_IMPORT_EXTENSIONS = new Set([".pdf", ".xlsx", ".csv", ".md", ".txt"]);
const CLEAN_REQUIRED_EXTENSIONS = new Set([".pdf", ".xlsx", ".csv"]);
const CLEAN_READY_EXTENSIONS = new Set([".md", ".txt"]);

let activeImport = null;

export function importMaxUploadBytes() {
  const mb = Number(process.env.TRAINING_IMPORT_MAX_UPLOAD_MB || 200);
  return Math.max(1, mb) * 1024 * 1024;
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function parseAliases(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeCleanMode(value) {
  const mode = String(value || "auto").toLowerCase();
  if (["auto", "clean", "direct"].includes(mode)) return mode;
  return "auto";
}

function uniqueExtensions(files) {
  return [...new Set(files.map((file) => path.extname(file).toLowerCase()).filter(Boolean))].sort();
}

function hasAnyExt(extensions, set) {
  return extensions.some((ext) => set.has(ext));
}

async function assertDirectory(dir) {
  const resolved = path.resolve(dir || "");
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`${resolved} 不是目录`);
  return resolved;
}

function safeRelativePath(value, fallback) {
  const raw = String(value || fallback || "upload.txt").replace(/\\/g, "/");
  const parts = raw
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== "." && part !== ".." && !/^[A-Za-z]:$/.test(part))
    .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, "_").slice(0, 120));
  return parts.join("/") || fallback || "upload.txt";
}

function embedCommands(kbId) {
  return {
    full: "npm run embed:local -- --full",
    knowledgeBase: `npm run embed:local -- --kb=${kbId}`,
  };
}

async function summarizeKnowledgeBases() {
  const state = await loadState();
  const runtime = await getRuntimeHealth(state);
  const knowledgeBases = [];
  for (const kb of state.knowledgeBases || []) {
    const vectorIndex = await getVectorIndexStatus(state, kb.id, runtime);
    knowledgeBases.push({
      id: kb.id,
      name: kb.name,
      aliases: kb.aliases || [],
      description: kb.description || "",
      status: kb.status,
      version: kb.version || "",
      quality: getKnowledgeBaseQuality(state, kb.id, vectorIndex),
    });
  }
  return { runtime, knowledgeBases };
}

async function runExclusiveImport(type, work) {
  if (activeImport) {
    const error = new Error(`已有导入任务正在运行：${activeImport.type}`);
    error.statusCode = 409;
    throw error;
  }
  activeImport = { type, startedAt: new Date().toISOString() };
  try {
    return await work();
  } finally {
    activeImport = null;
  }
}

function shouldClean({ cleanMode, extensions }) {
  if (cleanMode === "clean") return true;
  if (cleanMode === "direct") return false;
  return hasAnyExt(extensions, CLEAN_REQUIRED_EXTENSIONS);
}

async function importPreparedDirectory({ sourceDir, kbName, aliases, cleanMode, stagingDir }) {
  const files = await walkFiles(sourceDir, { extensions: ALLOWED_IMPORT_EXTENSIONS });
  if (!files.length) throw new Error("没有找到支持导入的文件。");
  const extensions = uniqueExtensions(files);
  const clean = shouldClean({ cleanMode, extensions });
  const hasCleanReady = hasAnyExt(extensions, CLEAN_READY_EXTENSIONS);
  if (!clean && !hasCleanReady) {
    throw new Error("直接导入模式只支持 .md/.txt；PDF、XLSX、CSV 需要先清洗。");
  }

  let cleanResult = null;
  const inputDir = clean ? path.join(stagingDir, "clean") : sourceDir;
  if (clean) {
    cleanResult = await cleanRawDirectory({ rawDir: sourceDir, cleanDir: inputDir });
    if (cleanResult.failed) {
      throw new Error(`清洗失败 ${cleanResult.failed} 个文件：${cleanResult.failures.map((item) => item.input).join(", ")}`);
    }
    if (!cleanResult.cleaned) throw new Error("清洗后没有生成可导入的 Markdown 文件。");
  }

  const imported = await importCleanDirectory({ inputDir, kbName, aliases });
  const overview = await summarizeKnowledgeBases();
  const quality = overview.knowledgeBases.find((kb) => kb.id === imported.kbId)?.quality || null;
  return {
    ok: true,
    mode: clean ? "cleaned" : "direct",
    sourceDir,
    inputDir,
    extensions,
    clean: cleanResult,
    imported,
    quality,
    embedCommands: embedCommands(imported.kbId),
    retrievalMode: overview.runtime.retrievalMode,
  };
}

export async function getImportOverview() {
  const overview = await summarizeKnowledgeBases();
  return {
    activeImport,
    config: {
      dataDir,
      importsDir: path.join(dataDir, "imports"),
      allowedExtensions: [...ALLOWED_IMPORT_EXTENSIONS],
      maxUploadBytes: importMaxUploadBytes(),
      maxUploadMB: Math.round(importMaxUploadBytes() / 1024 / 1024),
      vectorRebuild: "manual",
    },
    retrievalMode: overview.runtime.retrievalMode,
    knowledgeBases: overview.knowledgeBases,
  };
}

export async function importFromDirectory({ inputDir, kbName, aliases = [], cleanMode = "auto" }) {
  return await runExclusiveImport("directory", async () => {
    const sourceDir = await assertDirectory(inputDir);
    const stagingDir = path.join(dataDir, "imports", `directory-${timestampId()}`);
    await mkdir(stagingDir, { recursive: true });
    return await importPreparedDirectory({
      sourceDir,
      kbName: kbName || path.basename(sourceDir),
      aliases: parseAliases(aliases),
      cleanMode: normalizeCleanMode(cleanMode),
      stagingDir,
    });
  });
}

export async function importUploadedFiles({ files, kbName, aliases = [], cleanMode = "auto" }) {
  return await runExclusiveImport("upload", async () => {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) throw new Error("没有收到上传文件。");
    const totalBytes = list.reduce((sum, file) => sum + Number(file.content?.length || 0), 0);
    if (totalBytes > importMaxUploadBytes()) {
      throw new Error(`上传文件总量超过限制：${Math.round(importMaxUploadBytes() / 1024 / 1024)}MB`);
    }
    const stagingDir = path.join(dataDir, "imports", `upload-${timestampId()}`);
    const uploadDir = path.join(stagingDir, "upload");
    await mkdir(uploadDir, { recursive: true });
    let index = 0;
    for (const file of list) {
      const relative = safeRelativePath(file.relativePath || file.filename, `upload-${index}${path.extname(file.filename || "") || ".txt"}`);
      const ext = path.extname(relative).toLowerCase();
      if (!ALLOWED_IMPORT_EXTENSIONS.has(ext)) throw new Error(`不支持的文件类型：${relative}`);
      const target = path.resolve(uploadDir, relative);
      if (!target.startsWith(uploadDir)) throw new Error(`非法上传路径：${relative}`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
      index += 1;
    }
    return await importPreparedDirectory({
      sourceDir: uploadDir,
      kbName: kbName || "上传资料库",
      aliases: parseAliases(aliases),
      cleanMode: normalizeCleanMode(cleanMode),
      stagingDir,
    });
  });
}
