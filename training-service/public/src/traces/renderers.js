import { escapeHtml } from "../ui.js";

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

function metric(value, suffix = "") {
  if (value === null || value === undefined) return "无数据";
  return `${Number(value).toLocaleString()}${suffix}`;
}

function rate(value) {
  if (value === null || value === undefined) return "无数据";
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function aggregateCost(llm = {}) {
  const entries = Object.entries(llm.costByCurrency || {});
  if (!Number(llm.calls || 0)) return "无数据";
  if (!entries.length) return "未配置价格";
  return entries.map(([currency, amount]) => `${currency} ${Number(amount).toFixed(6)}`).join(" / ");
}

function runCost(llm = {}) {
  if (!Number(llm.calls || 0)) return "无数据";
  if (!llm.cost?.configured || llm.cost.amount === null || llm.cost.amount === undefined) return "未配置价格";
  return `${llm.cost.currency || "USD"} ${Number(llm.cost.amount).toFixed(6)}`;
}

function renderObservabilityCards(summary = {}) {
  const observed = Number(summary.runs?.observed || 0);
  const llm = summary.llm || {};
  const tools = summary.tools || {};
  const retrieval = summary.retrieval || {};
  return `<section class="import-panel full">
    <div class="task-section-title">24 小时可观测性${summary.skill ? ` · ${escapeHtml(summary.skill)}` : ""}</div>
    ${observed ? "" : `<div class="warning-box"><div>所选时间窗内没有带可观测指标的新 Run；历史 Run 不会显示为 0。</div></div>`}
    <div class="info-grid">
      <div><span>已观测 Run</span><strong>${observed ? escapeHtml(observed) : "无数据"}</strong></div>
      <div><span>LLM Token</span><strong>${Number(llm.calls || 0) ? escapeHtml(metric(llm.totalTokens)) : "无数据"}</strong></div>
      <div><span>估算成本</span><strong>${escapeHtml(aggregateCost(llm))}</strong></div>
      <div><span>流式 TTFT p95</span><strong>${escapeHtml(metric(llm.ttftMs?.p95, " ms"))}</strong></div>
      <div><span>工具成功率</span><strong>${escapeHtml(rate(tools.successRate))}</strong></div>
      <div><span>在线证据命中率</span><strong>${escapeHtml(rate(retrieval.evidenceHitRate))}</strong></div>
      <div><span>检索 p95</span><strong>${escapeHtml(metric(retrieval.latencyMs?.p95, " ms"))}</strong></div>
      <div><span>Reranker p95</span><strong>${escapeHtml(metric(retrieval.rerankerLatencyMs?.p95, " ms"))}</strong></div>
    </div>
    <p class="muted">在线证据命中率表示检索是否返回至少一条可用证据，不等同于离线 ground-truth Hit@K。</p>
  </section>`;
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

export function renderShell(data, filters) {
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
            ${["create_training_draft", "show_training_status", "delete_training_records", "generate_marketing_article", "translate_text", "answer_knowledge_question", "answer_general_chat"].map((skill) => `<option value="${skill}" ${filters.skill === skill ? "selected" : ""}>${skill}</option>`).join("")}
          </select>
          <select name="action">
            <option value="">全部 action</option>
            ${["draft", "status", "delete_records", "marketing_article", "translation", "translation_request", "intent_confirm", "chat"].map((action) => `<option value="${action}" ${filters.action === action ? "selected" : ""}>${action}</option>`).join("")}
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

      ${renderObservabilityCards(data.observability || {})}

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

export function renderRunDetail(run) {
  const steps = run.steps || [];
  const observability = run.summary?.observability || null;
  const llm = observability?.llm || {};
  const tools = observability?.tools || {};
  const retrieval = observability?.retrieval || {};
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
    <div class="task-section-title">可观测指标</div>
    ${observability ? `<div class="info-grid">
      <div><span>LLM 调用 / Token</span><strong>${escapeHtml(llm.calls || 0)} / ${escapeHtml(metric(llm.totalTokens))}</strong></div>
      <div><span>实际 / 估算调用</span><strong>${escapeHtml(Math.max(0, Number(llm.calls || 0) - Number(llm.estimatedCalls || 0)))} / ${escapeHtml(llm.estimatedCalls || 0)}</strong></div>
      <div><span>估算成本</span><strong>${escapeHtml(runCost(llm))}</strong></div>
      <div><span>流式 TTFT</span><strong>${escapeHtml(metric(llm.ttftMs?.p95, " ms"))}</strong></div>
      <div><span>工具成功率</span><strong>${escapeHtml(rate(tools.successRate))}</strong></div>
      <div><span>在线证据命中率</span><strong>${escapeHtml(rate(retrieval.evidenceHitRate))}</strong></div>
      <div><span>检索延迟</span><strong>${escapeHtml(metric(retrieval.latencyMs?.p95, " ms"))}</strong></div>
      <div><span>Reranker 延迟</span><strong>${escapeHtml(metric(retrieval.rerankerLatencyMs?.p95, " ms"))}</strong></div>
    </div>
    <pre class="command-box">${escapeHtml(JSON.stringify(observability, null, 2))}</pre>` : `<div class="warning-box"><div>该历史 Run 没有可观测指标。</div></div>`}
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

export function renderTraceDetail(trace) {
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
