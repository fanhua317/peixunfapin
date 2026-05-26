export function publicBaseUrl(req, { host, port }) {
  const configured = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/$/, "") : "";
  const mode = String(process.env.PUBLIC_BASE_URL_MODE || process.env.TRAINING_PUBLIC_BASE_URL_MODE || "request").toLowerCase();
  const proto = req.headers["x-forwarded-proto"] || "http";
  const hostHeader = req.headers.host || `${host}:${port}`;
  const requestBase = `${proto}://${hostHeader}`.replace(/\/$/, "");
  if (mode === "env" && configured) return configured;
  if (mode === "auto" && configured && /^https?:\/\//i.test(configured)) return configured;
  return requestBase || configured;
}
