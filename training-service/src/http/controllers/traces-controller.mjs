import { getAgentTrace, listAgentTraces } from "../../traces.mjs";
import { sendJson } from "../response.mjs";

export async function handleTraces(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/traces") {
    sendJson(res, 200, await listAgentTraces({
      limit: url.searchParams.get("limit") || 100,
      skill: url.searchParams.get("skill") || "",
      action: url.searchParams.get("action") || "",
      transport: url.searchParams.get("transport") || "",
      hasError: url.searchParams.get("hasError") || "",
      q: url.searchParams.get("q") || "",
    }));
    return true;
  }

  const detailMatch = url.pathname.match(/^\/api\/traces\/([^/]+)$/);
  if (req.method === "GET" && detailMatch) {
    const result = await getAgentTrace(detailMatch[1]);
    if (!result.trace) sendJson(res, 404, { error: "trace not found", enabled: result.enabled, path: result.path });
    else sendJson(res, 200, result);
    return true;
  }

  return false;
}
