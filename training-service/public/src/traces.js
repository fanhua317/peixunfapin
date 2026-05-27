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

function renderTraceRow(trace) {
  const decision = trace.decision || {};
  const result = trace.result || {};
  return `<article class="trace-row ${trace.error ? "has-error" : ""}" data-trace-id="${escapeHtml(trace.id)}">
    <div class="trace-main">
      <div>
        <div class="job-title">${escapeHtml(trace.messagePreview || "(空消息)")}</div>
        <div class="muted">${escapeHtml(formatDate(trace.createdAt))} · ${escapeHtml(trace.transport)} · ${escapeHtml(trace.route)}</div>
      </div>
      <span class="badge ${trace.error ? "warn" : "success"}">${escapeHtml(result.action || (trace.error ? "error" : "-"))}</span>
    </div>
    <div class="trace-grid">
      <span>intent: <strong>${escapeHtml(decision.intent || "-")}</strong></span>
      <span>skill: <strong>${escapeHtml(decision.skill || trace.confirmedSkill || "-")}</strong></span>
      <span>confidence: <strong>${escapeHtml(decision.confidence ?? "-")}</strong></span>
      <span>latency: <strong>${escapeHtml(trace.latencyMs || 0)} ms</strong></span>
      <span>confirmed: <strong>${trace.confirmationVerified ? "yes" : trace.confirmationTokenPresent ? "token" : "no"}</strong></span>
    </div>
    ${trace.error ? `<p class="error-text">${escapeHtml(trace.error)}</p>` : ""}
    <button type="button" class="secondary trace-detail-btn" data-trace-id="${escapeHtml(trace.id)}">查看详情</button>
  </article>`;
}

function renderShell(data) {
  const traces = data.traces || [];
  return `<article class="message assistant-message import-page">
    <div class="avatar">AI</div>
    <div class="bubble import-shell">
      <div class="import-hero">
        <div>
          <p class="section-kicker">Agent Trace</p>
          <h1>意图路由可视化</h1>
          <p>这里展示脱敏后的路由轨迹，只包含消息预览、意图、skill、确认状态、结果摘要、耗时和错误。</p>
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
        ${data.enabled ? "" : `<div class="warning-box"><div>Trace 当前未开启。设置 TRAINING_AGENT_TRACE=1 后会继续记录。</div></div>`}
        <p class="muted">文件：${escapeHtml(data.path || "")}</p>
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
  const data = await api(`/api/traces?${queryString()}`);
  setMessages(renderShell(data));
  wireTracePage();
}

function renderDetail(trace) {
  return `<div class="result-card">
    <h2>Trace 详情</h2>
    <div class="info-grid">
      <div><span>ID</span><strong>${escapeHtml(trace.id)}</strong></div>
      <div><span>时间</span><strong>${escapeHtml(formatDate(trace.createdAt))}</strong></div>
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

async function showTraceDetail(traceId) {
  const result = await api(`/api/traces/${encodeURIComponent(traceId)}`);
  const target = document.querySelector("#traceDetail");
  if (target) target.innerHTML = renderDetail(result.trace);
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
  document.querySelectorAll(".trace-detail-btn").forEach((button) => {
    button.addEventListener("click", () => showTraceDetail(button.dataset.traceId || "").catch(showError));
  });
}

function showError(error) {
  const target = document.querySelector("#traceDetail") || document.querySelector("#messages");
  if (target) target.innerHTML = `<p class="error-text">${escapeHtml(error.message || String(error))}</p>`;
}

export async function setupTracesApp() {
  setComposerHidden(true);
  setMessages(`<article class="message assistant-message"><div class="avatar">AI</div><div class="bubble">${renderStageProgress({ label: "加载 Trace", detail: "正在读取脱敏轨迹", progress: 35 })}</div></article>`);
  await refreshTraces();
}
