import { api } from "./api.js";
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

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function statusBadge(status, error) {
  const klass = error || status === "failed" ? "warn" : status === "succeeded" ? "success" : "";
  return `<span class="badge ${klass}">${escapeHtml(error ? "error" : status || "-")}</span>`;
}

function renderRunRow(run) {
  return `<article class="trace-row ${run.error ? "has-error" : ""}" data-run-id="${escapeHtml(run.id)}">
    <div class="trace-main">
      <div>
        <div class="job-title">${escapeHtml(run.messagePreview || "(空消息)")}</div>
        <div class="muted">${escapeHtml(formatDate(run.createdAt))} · ${escapeHtml(run.transport)} · ${escapeHtml(run.route)}</div>
      </div>
      ${statusBadge(run.status, run.error)}
    </div>
    <div class="trace-grid">
      <span>intent: <strong>${escapeHtml(run.intent || "-")}</strong></span>
      <span>skill: <strong>${escapeHtml(run.skill || run.confirmedSkill || "-")}</strong></span>
      <span>action: <strong>${escapeHtml(run.action || "-")}</strong></span>
      <span>latency: <strong>${escapeHtml(run.latencyMs || 0)} ms</strong></span>
      <span>confirmed: <strong>${run.confirmationVerified ? "yes" : run.confirmationTokenPresent ? "token" : "no"}</strong></span>
    </div>
    ${run.error ? `<p class="error-text">${escapeHtml(run.error)}</p>` : ""}
    <button type="button" class="secondary run-detail-btn" data-run-id="${escapeHtml(run.id)}">查看运行步骤</button>
  </article>`;
}

function renderTraceRow(trace) {
  const decision = trace.decision || {};
  const result = trace.result || {};
  return `<article class="trace-row ${trace.error ? "has-error" : ""}" data-trace-id="${escapeHtml(trace.id)}">
    <div class="trace-main">
      <div>
        <div class="job-title">${escapeHtml(trace.messagePreview || "(空消息)")}</div>
        <div class="muted">${escapeHtml(formatDate(trace.createdAt))} · ${escapeHtml(trace.transport)} · ${escapeHtml(trace.route)}${trace.runId ? ` · run ${escapeHtml(trace.runId)}` : ""}</div>
      </div>
      <span class="badge ${trace.error ? "warn" : "success"}">${escapeHtml(result.action || (trace.error ? "error" : "-"))}</span>
    </div>
    <div class="trace-grid">
      <span>intent: <strong>${escapeHtml(decision.intent || "-")}</strong></span>
      <span>skill: <strong>${escapeHtml(decision.skill || trace.confirmedSkill || "-")}</strong></span>
      <span>confidence: <strong>${escapeHtml(decision.confidence ?? "-")}</strong></span>
      <span>latency: <strong>${escapeHtml(trace.latencyMs || 0)} ms</strong></span>
    </div>
    ${trace.error ? `<p class="error-text">${escapeHtml(trace.error)}</p>` : ""}
    <button type="button" class="secondary trace-detail-btn" data-trace-id="${escapeHtml(trace.id)}">查看旧 Trace</button>
  </article>`;
}

function renderToolRegistry(tools) {
  const grouped = (tools || []).reduce((acc, tool) => {
    const key = tool.kind || "tool";
    acc[key] = acc[key] || [];
    acc[key].push(tool);
    return acc;
  }, {});
  return Object.entries(grouped).map(([kind, items]) => `
    <div class="task-section-title">${escapeHtml(kind)}</div>
    <div class="trace-list">
      ${items.map((tool) => `<article class="trace-row">
        <div class="trace-main">
          <div>
            <div class="job-title">${escapeHtml(tool.id)}</div>
            <div class="muted">${escapeHtml(tool.label || "")}</div>
          </div>
          <span class="badge ${tool.risk === "high" ? "warn" : "success"}">${escapeHtml(tool.risk || "low")}</span>
        </div>
        <p>${escapeHtml(tool.description || "")}</p>
        <div class="trace-grid">
          <span>confirm: <strong>${tool.requiresConfirmation ? "yes" : "no"}</strong></span>
          <span>idempotent: <strong>${tool.idempotent ? "yes" : "no"}</strong></span>
          <span>timeout: <strong>${escapeHtml(tool.timeoutMs || 0)} ms</strong></span>
          <span>endpoint: <strong>${escapeHtml(tool.endpoint || "-")}</strong></span>
        </div>
      </article>`).join("")}
    </div>
  `).join("");
}

function renderShell(data) {
  const runs = data.runs || [];
  const traces = data.traces || [];
  const tools = data.tools || [];
  return `<article class="message assistant-message import-page">
    <div class="avatar">AI</div>
    <div class="bubble import-shell">
      <div class="import-hero">
        <div>
          <p class="section-kicker">Agent Run</p>
          <h1>运行轨迹可视化</h1>
          <p>这里展示脱敏后的 Agent 运行记录、步骤时间线、tool 元信息和旧 Trace 摘要。</p>
        </div>
        <a class="nav-button secondary" href="/">返回聊天</a>
      </div>

      <section class="import-panel full">
        <form id="traceFilterForm" class="trace-filter">
          <input name="q" placeholder="搜索消息预览或原因" value="${escapeHtml(filters.q)}" />
          <select name="skill">
            <option value="">全部 skill</option>
            ${["create_training_draft", "show_training_status", "delete_training_records", "generate_marketing_article", "answer_general_chat"].map((skill) => `<option value="${skill}" ${filters.skill === skill ? "selected" : ""}>${skill}</option>`).join("")}
          </select>
          <select name="action">
            <option value="">全部 action</option>
            ${["draft", "status", "delete_records", "marketing_article", "intent_confirm", "chat"].map((action) => `<option value="${action}" ${filters.action === action ? "selected" : ""}>${action}</option>`).join("")}
          </select>
          <select name="transport">
            <option value="">全部通道</option>
            <option value="http" ${filters.transport === "http" ? "selected" : ""}>http</option>
            <option value="ws" ${filters.transport === "ws" ? "selected" : ""}>ws</option>
          </select>
          <label class="inline-check"><input name="hasError" type="checkbox" ${filters.hasError ? "checked" : ""} /> 仅错误</label>
          <button type="submit">筛选</button>
          <button id="refreshTracesBtn" type="button" class="secondary">刷新</button>
        </form>
        <div class="info-grid">
          <div><span>Agent Run</span><strong>${escapeHtml(runs.length)} 条</strong></div>
          <div><span>Tool Registry</span><strong>${escapeHtml(tools.length)} 个</strong></div>
          <div><span>旧 Trace</span><strong>${escapeHtml(traces.length)} 条</strong></div>
        </div>
      </section>

      <section class="import-panel full">
        <h2>Agent Run</h2>
        <div class="trace-list">${runs.length ? runs.map(renderRunRow).join("") : `<p class="muted">暂无运行记录。</p>`}</div>
      </section>

      <section id="runDetail" class="import-result"></section>

      <section class="import-panel full">
        <h2>Tool Registry</h2>
        ${renderToolRegistry(tools)}
      </section>

      <section class="import-panel full">
        <h2>兼容 Trace 摘要</h2>
        ${data.traceEnabled ? "" : `<div class="warning-box"><div>Trace 当前未开启。设置 TRAINING_AGENT_TRACE=1 后会继续记录。</div></div>`}
        <p class="muted">文件：${escapeHtml(data.tracePath || "")}</p>
        <div class="trace-list">${traces.length ? traces.map(renderTraceRow).join("") : `<p class="muted">暂无 trace 记录。</p>`}</div>
      </section>
      <section id="traceDetail" class="import-result"></section>
    </div>
  </article>`;
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
  const [runsData, tracesData, toolsData] = await Promise.all([
    api(`/api/agent-runs?${qs}`),
    api(`/api/traces?${qs}`),
    api("/api/tools/registry"),
  ]);
  setMessages(renderShell({
    runs: runsData.runs || [],
    traces: tracesData.traces || [],
    traceEnabled: tracesData.enabled,
    tracePath: tracesData.path,
    tools: toolsData.tools || [],
  }));
  wireTracePage();
}

function renderRunDetail(run) {
  const steps = run.steps || [];
  return `<div class="result-card">
    <h2>Run 详情</h2>
    <div class="info-grid">
      <div><span>ID</span><strong>${escapeHtml(run.id)}</strong></div>
      <div><span>状态</span><strong>${escapeHtml(run.status)}</strong></div>
      <div><span>通道</span><strong>${escapeHtml(run.transport)}</strong></div>
      <div><span>耗时</span><strong>${escapeHtml(run.latencyMs || 0)} ms</strong></div>
    </div>
    <div class="task-section-title">消息摘要</div>
    <pre class="command-box">${escapeHtml(JSON.stringify({
      messagePreview: run.messagePreview,
      messageHash: run.messageHash,
      messageLength: run.messageLength,
    }, null, 2))}</pre>
    <div class="task-section-title">步骤时间线</div>
    <div class="trace-list">
      ${steps.map((step, index) => `<article class="trace-row ${step.status === "failed" ? "has-error" : ""}">
        <div class="trace-main">
          <div>
            <div class="job-title">${escapeHtml(index + 1)}. ${escapeHtml(step.type)} / ${escapeHtml(step.name)}</div>
            <div class="muted">${escapeHtml(formatDate(step.startedAt))} · ${escapeHtml(step.latencyMs || 0)} ms</div>
          </div>
          ${statusBadge(step.status, step.error)}
        </div>
        <pre class="command-box">${escapeHtml(JSON.stringify(step.summary || {}, null, 2))}</pre>
        ${step.error ? `<p class="error-text">${escapeHtml(step.error)}</p>` : ""}
      </article>`).join("") || `<p class="muted">暂无步骤。</p>`}
    </div>
    ${run.error ? `<p class="error-text">${escapeHtml(run.error)}</p>` : ""}
  </div>`;
}

function renderTraceDetail(trace) {
  return `<div class="result-card">
    <h2>旧 Trace 详情</h2>
    <div class="info-grid">
      <div><span>ID</span><strong>${escapeHtml(trace.id)}</strong></div>
      <div><span>Run</span><strong>${escapeHtml(trace.runId || "-")}</strong></div>
      <div><span>通道</span><strong>${escapeHtml(trace.transport)}</strong></div>
      <div><span>耗时</span><strong>${escapeHtml(trace.latencyMs || 0)} ms</strong></div>
    </div>
    <div class="task-section-title">消息摘要</div>
    <pre class="command-box">${escapeHtml(JSON.stringify({
      messagePreview: trace.messagePreview,
      messageHash: trace.messageHash,
      messageLength: trace.messageLength,
    }, null, 2))}</pre>
    <div class="task-section-title">决策</div>
    <pre class="command-box">${escapeHtml(JSON.stringify(trace.decision || {}, null, 2))}</pre>
    <div class="task-section-title">结果</div>
    <pre class="command-box">${escapeHtml(JSON.stringify(trace.result || {}, null, 2))}</pre>
    ${trace.error ? `<p class="error-text">${escapeHtml(trace.error)}</p>` : ""}
  </div>`;
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
