import { getRun, listRuns } from "../../agent-runs/store.mjs";
import { sendJson } from "../response.mjs";

export async function handleAgentRuns(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/agent-runs") {
    sendJson(res, 200, {
      runs: await listRuns({
        limit: url.searchParams.get("limit") || 100,
        status: url.searchParams.get("status") || "",
        skill: url.searchParams.get("skill") || "",
        action: url.searchParams.get("action") || "",
        transport: url.searchParams.get("transport") || "",
        hasError: url.searchParams.get("hasError") || "",
        q: url.searchParams.get("q") || "",
      }),
    });
    return true;
  }

  const detailMatch = url.pathname.match(/^\/api\/agent-runs\/([^/]+)$/);
  if (req.method === "GET" && detailMatch) {
    const run = await getRun(detailMatch[1]);
    if (!run) sendJson(res, 404, { error: "agent run not found" });
    else sendJson(res, 200, { run });
    return true;
  }

  return false;
}

