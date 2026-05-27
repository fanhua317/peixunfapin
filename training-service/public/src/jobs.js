import { api } from "./api.js";
import { escapeHtml, renderStageProgress } from "./ui.js";

let pollTimer = null;
let currentStatus = "";

function setComposerHidden(hidden = true) {
  const composer = document.querySelector("#chatForm");
  if (composer) composer.hidden = hidden;
}

function setMessages(html) {
  const messages = document.querySelector("#messages");
  if (messages) messages.innerHTML = html;
}

function statusName(status) {
  return {
    queued: "排队中",
    running: "执行中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }[status] || status || "-";
}

function jobTypeName(type) {
  return {
    import_directory: "目录导入",
    import_upload: "上传导入",
    embed_local: "向量索引",
  }[type] || type || "-";
}

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function renderStats(jobs) {
  const counts = jobs.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, {});
  return `<div class="job-stats">
    ${["queued", "running", "succeeded", "failed", "cancelled"].map((status) => `
      <button class="job-stat ${currentStatus === status ? "active" : ""}" data-status="${status}">
        <span>${statusName(status)}</span><strong>${counts[status] || 0}</strong>
      </button>
    `).join("")}
  </div>`;
}

function renderJobRow(job) {
  const progress = job.progress || {};
  const canCancel = ["queued", "running"].includes(job.status);
  return `<article class="job-row status-${escapeHtml(job.status)}" data-job-id="${escapeHtml(job.id)}">
    <div class="job-row-main">
      <div>
        <div class="job-title">${escapeHtml(job.title || jobTypeName(job.type))}</div>
        <div class="muted">${escapeHtml(job.id)} · ${escapeHtml(jobTypeName(job.type))} · ${escapeHtml(formatDate(job.createdAt))}</div>
      </div>
      <span class="badge ${job.status === "failed" ? "warn" : job.status === "succeeded" ? "success" : ""}">${escapeHtml(statusName(job.status))}</span>
    </div>
    ${renderStageProgress({
      label: progress.label || statusName(job.status),
      detail: progress.detail || job.error || "",
      progress: progress.percent || 0,
    })}
    <div class="job-row-actions">
      <button type="button" class="secondary job-detail-btn" data-job-id="${escapeHtml(job.id)}">查看详情</button>
      ${canCancel ? `<button type="button" class="secondary danger job-cancel-btn" data-job-id="${escapeHtml(job.id)}">取消</button>` : ""}
    </div>
  </article>`;
}

function renderShell(jobs = []) {
  return `<article class="message assistant-message import-page">
    <div class="avatar">AI</div>
    <div class="bubble import-shell">
      <div class="import-hero">
        <div>
          <p class="section-kicker">任务中心</p>
          <h1>异步任务队列</h1>
          <p>导入资料和重建本地向量索引会在这里排队执行。BM25 在导入完成后立即可用，向量索引任务失败不会回滚知识库。</p>
        </div>
        <a class="nav-button secondary" href="/">返回聊天</a>
      </div>
      <section class="import-panel full">
        <div class="import-card-head">
          <div>
            <h2>任务列表</h2>
            <p class="muted">筛选：${escapeHtml(currentStatus || "全部")}</p>
          </div>
          <div class="button-row">
            <button id="allJobsBtn" type="button" class="secondary">全部</button>
            <button id="refreshJobsBtn" type="button" class="secondary">刷新</button>
          </div>
        </div>
        ${renderStats(jobs)}
        <div id="jobList" class="job-list">
          ${jobs.length ? jobs.map(renderJobRow).join("") : `<p class="muted">暂无任务。</p>`}
        </div>
      </section>
      <section id="jobDetail" class="import-result"></section>
    </div>
  </article>`;
}

async function loadJobs() {
  const params = new URLSearchParams();
  if (currentStatus) params.set("status", currentStatus);
  params.set("limit", "100");
  const result = await api(`/api/jobs?${params.toString()}`);
  return result.jobs || [];
}

async function refreshJobs() {
  const jobs = await loadJobs();
  setMessages(renderShell(jobs));
  wireJobsPage();
  if (jobs.some((job) => ["queued", "running"].includes(job.status))) startPolling();
  else stopPolling();
}

function renderDetail(job) {
  const events = (job.events || []).slice().reverse().map((event) => `
    <li><span>${escapeHtml(formatDate(event.at))}</span>${escapeHtml(event.message || "")}</li>
  `).join("");
  return `<div class="result-card">
    <h2>${escapeHtml(job.title || job.id)}</h2>
    <div class="info-grid">
      <div><span>状态</span><strong>${escapeHtml(statusName(job.status))}</strong></div>
      <div><span>类型</span><strong>${escapeHtml(jobTypeName(job.type))}</strong></div>
      <div><span>创建时间</span><strong>${escapeHtml(formatDate(job.createdAt))}</strong></div>
      <div><span>结束时间</span><strong>${escapeHtml(formatDate(job.finishedAt))}</strong></div>
    </div>
    ${job.error ? `<p class="error-text">${escapeHtml(job.error)}</p>` : ""}
    <div class="task-section-title">输入摘要</div>
    <pre class="command-box">${escapeHtml(JSON.stringify(job.inputSummary || {}, null, 2))}</pre>
    <div class="task-section-title">结果摘要</div>
    <pre class="command-box">${escapeHtml(JSON.stringify(job.resultSummary || {}, null, 2))}</pre>
    ${job.childJobIds?.length ? `<p class="muted">子任务：${job.childJobIds.map(escapeHtml).join(", ")}</p>` : ""}
    <div class="task-section-title">事件</div>
    <ul class="compact-list job-events">${events || "<li>暂无事件</li>"}</ul>
  </div>`;
}

async function showJobDetail(jobId) {
  const result = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
  const target = document.querySelector("#jobDetail");
  if (target) target.innerHTML = renderDetail(result.job);
}

async function cancelJob(jobId) {
  await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: JSON.stringify({}) });
  await refreshJobs();
}

function wireJobsPage() {
  document.querySelector("#refreshJobsBtn")?.addEventListener("click", () => refreshJobs().catch(showError));
  document.querySelector("#allJobsBtn")?.addEventListener("click", () => {
    currentStatus = "";
    refreshJobs().catch(showError);
  });
  document.querySelectorAll(".job-stat").forEach((button) => {
    button.addEventListener("click", () => {
      currentStatus = button.dataset.status || "";
      refreshJobs().catch(showError);
    });
  });
  document.querySelectorAll(".job-detail-btn").forEach((button) => {
    button.addEventListener("click", () => showJobDetail(button.dataset.jobId || "").catch(showError));
  });
  document.querySelectorAll(".job-cancel-btn").forEach((button) => {
    button.addEventListener("click", () => cancelJob(button.dataset.jobId || "").catch(showError));
  });
}

function showError(error) {
  const target = document.querySelector("#jobDetail") || document.querySelector("#messages");
  if (target) target.innerHTML = `<p class="error-text">${escapeHtml(error.message || String(error))}</p>`;
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => refreshJobs().catch(showError), 2500);
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
}

export async function setupJobsApp() {
  setComposerHidden(true);
  setMessages(`<article class="message assistant-message"><div class="avatar">AI</div><div class="bubble">${renderStageProgress({ label: "加载任务中心", detail: "正在读取任务队列", progress: 35 })}</div></article>`);
  await refreshJobs();
}
