import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "..", "..");
export const defaultAuditOutDir = path.join(repoRoot, "server-audit-output");
export const defaultDataDir = process.env.TRAINING_DATA_DIR || path.resolve("D:/juzhou-agent/data/training-index");
export const defaultProductionUrl = "http://47.95.194.219:8787";

export function timestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const eqIndex = item.indexOf("=");
    if (eqIndex >= 0) {
      args[item.slice(2, eqIndex)] = item.slice(eqIndex + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

export function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function asList(value, fallback) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

export function asNumberList(value, fallback) {
  return asList(value, fallback).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
}

export function cleanBaseUrl(value) {
  return String(value || defaultProductionUrl).replace(/\/+$/, "");
}

export function accessKeyFromArgs(args = {}) {
  return args.accessKey || args["access-key"] || process.env.TRAINING_ACCESS_KEY || process.env.OPENCLAW_TRAINING_ACCESS_KEY || "";
}

export function redact(value) {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/tvly-[A-Za-z0-9_-]{8,}/g, "tvly-[redacted]")
    .replace(/(TRAINING_LLM_API_KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY|TRAINING_ACCESS_KEY|TRAINING_WEB_SEARCH_API_KEY|TAVILY_API_KEY)=([^\s]+)/g, "$1=[redacted]");
}

export function safeJson(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/key|token|secret|password/i.test(key)) return item ? "[redacted]" : item;
    return typeof item === "string" ? redact(item) : item;
  }));
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeJsonArtifact(outDir, prefix, payload) {
  await ensureDir(outDir);
  const filePath = path.join(outDir, `${prefix}-${timestampForFile()}.json`);
  await writeFile(filePath, `${JSON.stringify(safeJson(payload), null, 2)}\n`, "utf8");
  return filePath;
}

export async function requestJson(baseUrl, endpoint, {
  method = "GET",
  body,
  accessKey = "",
  timeoutMs = 15_000,
} = {}) {
  const controller = new AbortController();
  const startedAt = performance.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${cleanBaseUrl(baseUrl)}${endpoint}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(accessKey ? { "x-training-access-key": accessKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text.slice(0, 500) };
    }
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
      payload,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveCommand(command, args) {
  if (process.platform === "win32" && (command === "npm" || command === "npx")) {
    const cliName = command === "npm" ? "npm-cli.js" : "npx-cli.js";
    const cliPath = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", cliName);
    if (existsSync(cliPath)) return { command: process.execPath, args: [cliPath, ...args] };
  }
  return { command, args };
}

export async function runCommand(command, args = [], {
  cwd = repoRoot,
  env = {},
  timeoutMs = 120_000,
} = {}) {
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const resolved = resolveCommand(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        command,
        args,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        timedOut,
        stdout: "",
        stderr: error.message,
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        command,
        args,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        timedOut,
        stdout: redact(stdout).slice(-20_000),
        stderr: redact(stderr).slice(-20_000),
      });
    });
  });
}

export function sha256(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

export function percentile(values, pct) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return Math.round(sorted[index]);
}

export function summarizeRequests(results, durationMs) {
  const latencies = results.map((item) => item.latencyMs).filter(Number.isFinite);
  const errors = results.filter((item) => !item.ok).length;
  const statusCounts = {};
  for (const item of results) statusCounts[item.status || 0] = (statusCounts[item.status || 0] || 0) + 1;
  return {
    requests: results.length,
    ok: results.length - errors,
    errors,
    errorRate: results.length ? Number((errors / results.length).toFixed(4)) : 0,
    rps: durationMs > 0 ? Number((results.length / (durationMs / 1000)).toFixed(2)) : 0,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    minMs: latencies.length ? Math.min(...latencies) : 0,
    maxMs: latencies.length ? Math.max(...latencies) : 0,
    statusCounts,
  };
}

async function directoryStats(rootDir, { maxFiles = 200_000 } = {}) {
  const summary = {
    exists: existsSync(rootDir),
    rootDir,
    fileCount: 0,
    bytes: 0,
    byExtension: {},
    byTopLevel: {},
  };
  if (!summary.exists) return summary;
  async function walk(currentDir) {
    if (summary.fileCount >= maxFiles) return;
    const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = await stat(absolute).catch(() => null);
      if (!stats) continue;
      const relative = path.relative(rootDir, absolute);
      const top = relative.split(path.sep)[0] || ".";
      const ext = path.extname(entry.name).toLowerCase() || "(none)";
      summary.fileCount += 1;
      summary.bytes += stats.size;
      summary.byExtension[ext] = (summary.byExtension[ext] || 0) + stats.size;
      summary.byTopLevel[top] = (summary.byTopLevel[top] || 0) + stats.size;
    }
  }
  await walk(rootDir);
  return summary;
}

export async function collectStateStats(dataDir = defaultDataDir) {
  process.env.TRAINING_DATA_DIR = dataDir;
  const stats = {
    dataDir,
    state: null,
    files: await directoryStats(dataDir),
  };
  try {
    const { loadState, getStorageStatus } = await import("../../src/store.mjs");
    const state = await loadState();
    stats.storage = getStorageStatus();
    stats.state = {
      knowledgeBases: state.knowledgeBases?.length || 0,
      documents: state.documents?.length || 0,
      chunkParents: state.chunkParents?.length || 0,
      chunks: state.chunks?.length || 0,
      employees: state.employees?.length || 0,
      tasks: state.tasks?.length || 0,
      invites: state.invites?.length || 0,
      quizzes: state.quizzes?.length || 0,
      attempts: state.attempts?.length || 0,
      events: state.events?.length || 0,
    };
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error);
  }
  return stats;
}

export async function collectDiskStatus(targetPath = defaultDataDir) {
  if (process.platform === "win32") {
    const root = path.parse(path.resolve(targetPath)).root.replace(/\\$/, "");
    const result = await runCommand("powershell", [
      "-NoProfile",
      "-Command",
      `$d=Get-PSDrive -Name '${root.replace(":", "")}'; [pscustomobject]@{Name=$d.Name;Used=$d.Used;Free=$d.Free;Root=$d.Root} | ConvertTo-Json -Compress`,
    ], { cwd: repoRoot, timeoutMs: 10_000 });
    if (result.ok) {
      try { return JSON.parse(result.stdout); } catch { /* ignore */ }
    }
    return { error: result.stderr || result.stdout || "disk status unavailable" };
  }
  const result = await runCommand("df", ["-k", targetPath], { cwd: repoRoot, timeoutMs: 10_000 });
  return { raw: result.stdout.trim(), ok: result.ok };
}

export function resourceSnapshot(dataDir = defaultDataDir) {
  return {
    at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    loadavg: os.loadavg(),
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    processMemory: process.memoryUsage(),
    dataDir,
  };
}

export function classifyFailure(result) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}\n${result.error || ""}`;
  if (result.timedOut) return "timeout";
  if (/access key required|401|invalid access key/i.test(text)) return "auth_required";
  if (/TRAINING_LLM_API_KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY|大模型|LLM/i.test(text)) return "llm_or_model_config";
  if (/ECONNREFUSED|ENOTFOUND|network|fetch failed/i.test(text)) return "network_or_service";
  if (/No knowledge base|No knowledge base found|知识库/i.test(text)) return "data_or_knowledge_base";
  return result.ok === false ? "code_or_behavior" : "";
}

export async function readLatestArtifacts(outDir = defaultAuditOutDir) {
  const files = await readdir(outDir).catch(() => []);
  const artifacts = {};
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const prefix = file.replace(/-\d{8}-\d{6}\.json$/, "");
    const fullPath = path.join(outDir, file);
    try {
      const raw = await readFile(fullPath, "utf8");
      artifacts[prefix] = {
        path: fullPath,
        data: JSON.parse(raw.replace(/^\uFEFF/, "")),
      };
    } catch {
      // ignore broken artifact
    }
  }
  return artifacts;
}
