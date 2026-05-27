import path from "node:path";
import { dataDir } from "../../store.mjs";
import { importMaxUploadBytes, stageUploadedFiles } from "../../import/service.mjs";
import { cancelJob, enqueueJob } from "../../jobs/scheduler.mjs";
import { getJob, listJobs, summarizeJob } from "../../jobs/store.mjs";
import { readMultipart } from "../multipart.mjs";
import { readBody } from "../request.mjs";
import { sendJson } from "../response.mjs";

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function boolValue(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

function jobResponse(job) {
  return { job: summarizeJob(job) };
}

function sendError(res, error) {
  sendJson(res, error.statusCode || 400, { error: error instanceof Error ? error.message : String(error) });
}

function jsonField(parts, name, fallback = "") {
  return parts.find((part) => part.name === name && !part.filename)?.text?.trim() || fallback;
}

function parseRelativePaths(parts) {
  const raw = jsonField(parts, "relativePaths", "[]");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item || "")) : [];
  } catch {
    return [];
  }
}

async function enqueueDirectoryImport(body) {
  return await enqueueJob({
    type: "import_directory",
    title: `导入知识库：${body.kbName || body.inputDir || "本机目录"}`,
    input: {
      sourceDir: body.inputDir,
      kbName: body.kbName || "",
      aliases: body.aliases || "",
      cleanMode: body.cleanMode || "auto",
      autoEmbed: boolValue(body.autoEmbed, true),
      embeddingModel: body.embeddingModel || "",
    },
    inputSummary: {
      source: "directory",
      inputDir: body.inputDir || "",
      kbName: body.kbName || "",
      cleanMode: body.cleanMode || "auto",
      autoEmbed: boolValue(body.autoEmbed, true),
    },
  });
}

async function enqueueUploadImport(parts) {
  const relativePaths = parseRelativePaths(parts);
  const fileParts = parts.filter((part) => part.name === "files" && part.filename);
  const files = fileParts.map((part, index) => ({
    filename: part.filename,
    relativePath: relativePaths[index] || part.filename,
    content: part.content,
  }));
  const stagingDir = path.join(dataDir, "imports", `job-upload-${timestampId()}`);
  const staged = await stageUploadedFiles({ files, stagingDir });
  return await enqueueJob({
    type: "import_upload",
    title: `上传导入：${jsonField(parts, "kbName", "上传资料库")}`,
    input: {
      sourceDir: staged.uploadDir,
      stagingDir,
      kbName: jsonField(parts, "kbName", "上传资料库"),
      aliases: jsonField(parts, "aliases", ""),
      cleanMode: jsonField(parts, "cleanMode", "auto"),
      autoEmbed: boolValue(jsonField(parts, "autoEmbed", "true"), true),
      embeddingModel: jsonField(parts, "embeddingModel", ""),
    },
    inputSummary: {
      source: "upload",
      fileCount: staged.fileCount,
      totalBytes: staged.totalBytes,
      kbName: jsonField(parts, "kbName", "上传资料库"),
      cleanMode: jsonField(parts, "cleanMode", "auto"),
      autoEmbed: boolValue(jsonField(parts, "autoEmbed", "true"), true),
    },
  });
}

export async function handleJobs(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/jobs") {
    const jobs = await listJobs({
      status: url.searchParams.get("status") || "",
      type: url.searchParams.get("type") || "",
      limit: url.searchParams.get("limit") || 100,
    });
    sendJson(res, 200, { jobs: jobs.map(summarizeJob) });
    return true;
  }

  const detailMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === "GET" && detailMatch) {
    const job = await getJob(detailMatch[1]);
    if (!job) sendJson(res, 404, { error: "job not found" });
    else sendJson(res, 200, { job });
    return true;
  }

  const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch) {
    const job = await cancelJob(cancelMatch[1]);
    if (!job) sendJson(res, 404, { error: "job not found" });
    else sendJson(res, 200, jobResponse(job));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/import/directory") {
    try {
      const body = await readBody(req);
      sendJson(res, 202, jobResponse(await enqueueDirectoryImport(body)));
    } catch (error) {
      sendError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/import/upload") {
    try {
      const parts = await readMultipart(req, { maxBytes: importMaxUploadBytes() + 1024 * 1024 });
      sendJson(res, 202, jobResponse(await enqueueUploadImport(parts)));
    } catch (error) {
      sendError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/embed") {
    try {
      const body = await readBody(req);
      const full = boolValue(body.full, false);
      const kbId = String(body.kbId || body.knowledgeBaseId || "").trim();
      if (!full && !kbId) throw new Error("请提供 kbId，或设置 full=true 重建全部索引。");
      const job = await enqueueJob({
        type: "embed_local",
        title: full ? "重建全部本地向量索引" : `重建向量索引：${kbId}`,
        input: {
          kbId,
          full,
          model: body.model || "",
        },
        inputSummary: {
          kbId,
          full,
          model: body.model || "默认模型",
        },
      });
      sendJson(res, 202, jobResponse(job));
    } catch (error) {
      sendError(res, error);
    }
    return true;
  }

  return false;
}
