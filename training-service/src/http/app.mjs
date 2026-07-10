import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleApi } from "./api-router.mjs";
import { sendJson } from "./response.mjs";
import { createStaticHandler } from "./static.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(__dirname, "../..");
const publicDir = path.join(serviceRoot, "public");

export function createApp(context) {
  const servePublic = createStaticHandler(publicDir);
  return async function app(req, res) {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, context);
        return;
      }
      await servePublic(res, url.pathname);
    } catch (error) {
      const statusCode = Number(error?.statusCode || error?.status || 500);
      if (statusCode >= 500 && statusCode !== 503) console.error(error);
      const exposed = error?.expose === true || statusCode < 500 || statusCode === 503;
      sendJson(res, statusCode, {
        error: exposed && error instanceof Error ? error.message : "internal server error",
      });
    }
  };
}
