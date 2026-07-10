import { getImportOverview, importFromDirectory, importMaxUploadBytes, importUploadedFiles } from "../../import/service.mjs";
import { multipartStringArrayField, multipartTextField, readMultipart } from "../multipart.mjs";
import { readBody } from "../request.mjs";
import { sendJson } from "../response.mjs";

function sendError(res, error) {
  sendJson(res, error.statusCode || 400, { error: error instanceof Error ? error.message : String(error) });
}

export async function handleImports(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/imports") {
    sendJson(res, 200, await getImportOverview());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/imports/directory") {
    try {
      const body = await readBody(req);
      sendJson(res, 200, await importFromDirectory({
        inputDir: body.inputDir,
        kbName: body.kbName,
        aliases: body.aliases,
        cleanMode: body.cleanMode,
      }));
    } catch (error) {
      sendError(res, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/imports/upload") {
    try {
      const parts = await readMultipart(req, { maxBytes: importMaxUploadBytes() + 1024 * 1024 });
      const relativePaths = multipartStringArrayField(parts, "relativePaths");
      const fileParts = parts.filter((part) => part.name === "files" && part.filename);
      const files = fileParts.map((part, index) => ({
        filename: part.filename,
        relativePath: relativePaths[index] || part.filename,
        content: part.content,
      }));
      sendJson(res, 200, await importUploadedFiles({
        files,
        kbName: multipartTextField(parts, "kbName", "上传资料库"),
        aliases: multipartTextField(parts, "aliases", ""),
        cleanMode: multipartTextField(parts, "cleanMode", "auto"),
      }));
    } catch (error) {
      sendError(res, error);
    }
    return true;
  }

  return false;
}
