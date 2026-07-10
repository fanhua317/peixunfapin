import { api } from "./api.js";
import { renderRunDetail, renderShell, renderTraceDetail } from "./traces/renderers.js";
import { escapeHtml, renderStageProgress } from "./ui.js";

let filters = {
  skill: "",
  action: "",
  transport: "",
  hasError: "",
  q: "",
};

function setComposerHidden(hidden = true) {
  const composer = document.querySelector("#chatForm");
  if (composer) composer.hidden = hidden;
}

function setMessages(html) {
  const messages = document.querySelector("#messages");
  if (messages) messages.innerHTML = html;
}

function queryString() {
  const params = new URLSearchParams();
  params.set("limit", "100");
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

async function refreshTraces() {
  const qs = queryString();
  const observabilityParams = new URLSearchParams({ hours: "24" });
  if (filters.skill) observabilityParams.set("skill", filters.skill);
  const [runsData, tracesData, toolsData, observability] = await Promise.all([
    api(`/api/agent-runs?${qs}`),
    api(`/api/traces?${qs}`),
    api("/api/tools/registry"),
    api(`/api/observability/summary?${observabilityParams}`),
  ]);
  setMessages(renderShell({
    runs: runsData.runs || [],
    traces: tracesData.traces || [],
    traceEnabled: tracesData.enabled,
    tracePath: tracesData.path,
    tools: toolsData.tools || [],
    observability,
  }, filters));
  wireTracePage();
}

async function showRunDetail(runId) {
  const result = await api(`/api/agent-runs/${encodeURIComponent(runId)}`);
  const target = document.querySelector("#runDetail");
  if (target) target.innerHTML = renderRunDetail(result.run);
}

async function showTraceDetail(traceId) {
  const result = await api(`/api/traces/${encodeURIComponent(traceId)}`);
  const target = document.querySelector("#traceDetail");
  if (target) target.innerHTML = renderTraceDetail(result.trace);
}

function wireTracePage() {
  document.querySelector("#traceFilterForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    filters = {
      q: form.elements.q.value.trim(),
      skill: form.elements.skill.value,
      action: form.elements.action.value,
      transport: form.elements.transport.value,
      hasError: form.elements.hasError.checked ? "true" : "",
    };
    refreshTraces().catch(showError);
  });
  document.querySelector("#refreshTracesBtn")?.addEventListener("click", () => refreshTraces().catch(showError));
  document.querySelectorAll(".run-detail-btn").forEach((button) => {
    button.addEventListener("click", () => showRunDetail(button.dataset.runId || "").catch(showError));
  });
  document.querySelectorAll(".trace-detail-btn").forEach((button) => {
    button.addEventListener("click", () => showTraceDetail(button.dataset.traceId || "").catch(showError));
  });
}

function showError(error) {
  const target = document.querySelector("#runDetail") || document.querySelector("#messages");
  if (target) target.innerHTML = `<p class="error-text">${escapeHtml(error.message || String(error))}</p>`;
}

export async function setupTracesApp() {
  setComposerHidden(true);
  setMessages(`<article class="message assistant-message"><div class="avatar">AI</div><div class="bubble">${renderStageProgress({ label: "加载运行轨迹", detail: "正在读取 Agent Run 和 Trace", progress: 35 })}</div></article>`);
  await refreshTraces();
}
