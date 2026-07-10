import { getObservabilitySummary } from "../../observability/summary.mjs";
import { sendJson } from "../response.mjs";

export async function handleObservability(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/api/observability/summary") return false;
  sendJson(res, 200, await getObservabilitySummary({
    hours: url.searchParams.get("hours") || 24,
    skill: url.searchParams.get("skill") || "",
  }));
  return true;
}
