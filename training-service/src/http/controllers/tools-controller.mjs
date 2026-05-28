import { listTools } from "../../tools/registry.mjs";
import { sendJson } from "../response.mjs";

export async function handleTools(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/api/tools/registry") return false;
  sendJson(res, 200, { tools: listTools() });
  return true;
}

