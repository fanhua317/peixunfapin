import { readFile } from "node:fs/promises";
import path from "node:path";

import { sendText } from "./response.mjs";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
]);

export function createStaticHandler(publicDir) {
  return async function servePublic(res, pathname) {
    const fileName = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    const filePath = path.resolve(publicDir, fileName);
    if (!filePath.startsWith(publicDir)) {
      sendText(res, 403, "Forbidden");
      return;
    }
    try {
      const content = await readFile(filePath, "utf8");
      const contentType = contentTypes.get(path.extname(filePath)) || "text/html; charset=utf-8";
      sendText(res, 200, content, contentType);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        const index = await readFile(path.join(publicDir, "index.html"), "utf8");
        sendText(res, 200, index, "text/html; charset=utf-8");
        return;
      }
      throw error;
    }
  };
}
