import { readFile } from "node:fs/promises";
import path from "node:path";

import { decodePathname } from "./errors.mjs";
import { sendText } from "./response.mjs";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
]);

export function createStaticHandler(publicDir) {
  const root = path.resolve(publicDir);
  return async function servePublic(res, pathname) {
    const decodedPathname = decodePathname(pathname);
    const fileName = decodedPathname === "/" ? "index.html" : decodedPathname.replace(/^\//, "");
    const filePath = path.resolve(root, fileName);
    const relativePath = path.relative(root, filePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      sendText(res, 403, "Forbidden");
      return;
    }
    try {
      const content = await readFile(filePath, "utf8");
      const contentType = contentTypes.get(path.extname(filePath)) || "text/html; charset=utf-8";
      sendText(res, 200, content, contentType);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        if (!path.extname(decodedPathname)) {
          const index = await readFile(path.join(root, "index.html"), "utf8");
          sendText(res, 200, index, "text/html; charset=utf-8");
          return;
        }
        sendText(res, 404, "Not Found");
        return;
      }
      throw error;
    }
  };
}
