import { api } from "./api.js";
import { escapeHtml, renderQualitySummary, renderStageProgress } from "./ui.js";

let overview = null;

function setComposerHidden(hidden = true) {
  const composer = document.querySelector("#chatForm");
  if (composer) composer.hidden = hidden;
}

function setMessages(html) {
  const messages = document.querySelector("#messages");
  if (messages) messages.innerHTML = html;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function diffCountText(diff) {
  const counts = diff?.counts || {};
  return `新增 ${counts.added || 0} / 删除 ${counts.removed || 0} / 变更 ${counts.changed || 0} / 未变 ${counts.unchanged || 0}`;
}

function renderDocDiffList(label, items = []) {
  const list = items.slice(0, 20).map((item) => `<li>${escapeHtml(item.path || item.title || "-")}</li>`).join("");
  const more = items.length > 20 ? `<li>还有 ${escapeHtml(items.length - 20)} 项未显示</li>` : "";
  return `<div class="task-section-title">${escapeHtml(label)}（${escapeHtml(items.length)}）</div>
    <ul class="compact-list">${list || "<li>无</li>"}${more}</ul>`;
}

function renderVersionSummary(version, title) {
  if (!version) {
    return `<section class="import-panel"><h3>${escapeHtml(title)}</h3><p class="muted">暂无版本。</p></section>`;
  }
  const summary = version.summary || {};
  const quality = summary.quality || {};
  return `<section class="import-panel">
    <div class="import-card-head">
      <div>
        <h3>${escapeHtml(title)} #${escapeHtml(version.versionNo || "-")}</h3>
        <p class="muted">${escapeHtml(version.id)} / ${escapeHtml(version.source || "-")} / ${escapeHtml(formatDate(version.createdAt))}</p>
      </div>
      <span class="badge ${version.slot === "current" ? "success" : ""}">${escapeHtml(version.slot || "-")}</span>
    </div>
    <div class="info-grid">
      <div><span>文档</span><strong>${escapeHtml(summary.documents || 0)}</strong></div>
      <div><span>父块</span><strong>${escapeHtml(summary.chunkParents || 0)}</strong></div>
      <div><span>子块</span><strong>${escapeHtml(summary.chunks || 0)}</strong></div>
      <div><span>表格行</span><strong>${escapeHtml(summary.tableRowParentCount || 0)}</strong></div>
      <div><span>最长子块</span><strong>${escapeHtml(summary.maxChildChars || 0)}</strong></div>
      <div><span>质量分</span><strong>${escapeHtml(quality.qualityScore ?? "-")}</strong></div>
    </div>
  </section>`;
}

function renderVersionPanel(kbId, versions) {
  const current = versions.current || null;
  const previous = versions.previous || null;
  const diff = current?.diffFromPrevious || versions.diffSummary || null;
  return `<div class="result-card">
    <div class="import-card-head">
      <div>
        <h2>版本与导入差异</h2>
        <p class="muted">${escapeHtml(kbId)} / ${escapeHtml(diffCountText(diff))}</p>
      </div>
      <button type="button" class="secondary" id="closeVersionPanelBtn">关闭</button>
    </div>
    <div class="import-layout">
      ${renderVersionSummary(current, "当前版")}
      ${renderVersionSummary(previous, "上一版")}
    </div>
    ${diff ? `
      <div class="task-section-title">文档级差异</div>
      <div class="info-grid">
        <div><span>上版文档</span><strong>${escapeHtml(diff.totals?.previousDocuments || 0)}</strong></div>
        <div><span>当前文档</span><strong>${escapeHtml(diff.totals?.currentDocuments || 0)}</strong></div>
        <div><span>上版父块</span><strong>${escapeHtml(diff.totals?.previousParents || 0)}</strong></div>
        <div><span>当前父块</span><strong>${escapeHtml(diff.totals?.currentParents || 0)}</strong></div>
        <div><span>上版子块</span><strong>${escapeHtml(diff.totals?.previousChunks || 0)}</strong></div>
        <div><span>当前子块</span><strong>${escapeHtml(diff.totals?.currentChunks || 0)}</strong></div>
      </div>
      ${renderDocDiffList("新增文档", diff.added || [])}
      ${renderDocDiffList("删除文档", diff.removed || [])}
      ${renderDocDiffList("变更文档", diff.changed || [])}
    ` : `<p class="muted">暂无可比较的上一版。</p>`}
    <div class="button-row">
      ${previous ? `<button type="button" class="secondary danger kb-rollback-btn" data-kb-id="${escapeHtml(kbId)}" data-version-id="${escapeHtml(previous.id)}">回滚到上一版</button>` : ""}
      <a class="nav-button secondary" href="/jobs">打开任务中心</a>
    </div>
  </div>`;
}

function renderKbCard(kb) {
  const quality = kb.quality || {};
  const versions = kb.versions || {};
  const diff = versions.diffSummary || versions.current?.diffFromPrevious || null;
  return `<article class="import-kb-card">
    <div class="import-card-head">
      <div>
        <h3>${escapeHtml(kb.name)}</h3>
        <p class="muted">${escapeHtml(kb.id)}</p>
      </div>
      <span class="badge ${quality.warnings?.length ? "warn" : "success"}">${escapeHtml(kb.status || "ready")}</span>
    </div>
    <div class="import-metrics">
      <span>文档 ${escapeHtml(quality.documents ?? 0)}</span>
      <span>父块 ${escapeHtml(quality.chunkParents ?? 0)}</span>
      <span>子块 ${escapeHtml(quality.chunks ?? 0)}</span>
      <span>表格行 ${escapeHtml(quality.tableRowParents ?? 0)}</span>
      <span>最长 ${escapeHtml(quality.longestChildChars ?? 0)} 字</span>
    </div>
    <p class="muted">版本：当前 #${escapeHtml(versions.current?.versionNo || "-")}，上一版 ${escapeHtml(versions.previous ? `#${versions.previous.versionNo}` : "无")}；${escapeHtml(diffCountText(diff))}</p>
    ${renderQualitySummary(quality)}
    <div class="button-row">
      <button type="button" class="secondary kb-version-btn" data-kb-id="${escapeHtml(kb.id)}">查看版本/差异</button>
    </div>
  </article>`;
}

function renderOverview() {
  const config = overview?.config || {};
  const knowledgeBases = overview?.knowledgeBases || [];
  const cards = knowledgeBases.length
    ? knowledgeBases.map(renderKbCard).join("")
    : `<p class="muted">当前还没有知识库。</p>`;
  return `<article class="message assistant-message import-page">
    <div class="avatar">AI</div>
    <div class="bubble import-shell">
      <div class="import-hero">
        <div>
          <p class="section-kicker">导入管理</p>
          <h1>知识库导入与质量检查</h1>
          <p>支持本机目录导入和浏览器上传。导入会进入后台任务队列，完成后 BM25 立即可用，并自动创建本地向量索引任务。</p>
        </div>
        <a class="nav-button secondary" href="/">返回聊天</a>
      </div>

      <div class="import-layout">
        <section class="import-panel">
          <h2>本机目录导入</h2>
          <form id="directoryImportForm" class="import-form">
            <label>目录路径<input name="inputDir" placeholder="D:\\OpenClawData\\training-clean" required /></label>
            <label>知识库名称<input name="kbName" placeholder="电机培训资料库" required /></label>
            <label>别名<input name="aliases" placeholder="电机, 电机培训" /></label>
            <label>清洗模式
              <select name="cleanMode">
                <option value="auto">自动判断</option>
                <option value="direct">直接导入 md/txt</option>
                <option value="clean">先清洗再导入</option>
              </select>
            </label>
            <button type="submit">导入目录</button>
          </form>
        </section>

        <section class="import-panel">
          <h2>浏览器上传</h2>
          <form id="uploadImportForm" class="import-form">
            <label>知识库名称<input name="kbName" placeholder="上传资料库" required /></label>
            <label>别名<input name="aliases" placeholder="产品资料, 培训资料" /></label>
            <label>清洗模式
              <select name="cleanMode">
                <option value="auto">自动判断</option>
                <option value="direct">直接导入 md/txt</option>
                <option value="clean">先清洗再导入</option>
              </select>
            </label>
            <label>资料文件
              <input name="files" type="file" multiple webkitdirectory />
            </label>
            <label>补充选择文件
              <input name="filesFlat" type="file" multiple accept=".pdf,.xlsx,.csv,.md,.txt" />
            </label>
            <p class="muted">允许扩展名：${escapeHtml((config.allowedExtensions || []).join(", "))}；总量上限 ${escapeHtml(config.maxUploadMB || 200)} MB。</p>
            <button type="submit">上传并导入</button>
          </form>
        </section>
      </div>

      <section id="importResult" class="import-result"></section>

      <section class="import-panel full">
        <div class="import-card-head">
          <div>
            <h2>当前知识库</h2>
            <p class="muted">检索模式：${escapeHtml(overview?.retrievalMode || "-")}</p>
          </div>
          <button id="refreshImportsBtn" type="button" class="secondary">刷新</button>
        </div>
        <div class="import-kb-grid">${cards}</div>
      </section>
    </div>
  </article>`;
}

function renderImportResult(result) {
  const imported = result.imported || {};
  const warnings = (result.quality?.warnings || []).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  return `<div class="result-card">
    <h2>导入完成</h2>
    <div class="info-grid">
      <div><span>知识库</span><strong>${escapeHtml(imported.kbName || "-")}</strong></div>
      <div><span>ID</span><strong>${escapeHtml(imported.kbId || "-")}</strong></div>
      <div><span>文档</span><strong>${escapeHtml(imported.fileCount || 0)} 个</strong></div>
      <div><span>父块</span><strong>${escapeHtml(imported.parentCount || 0)} 个</strong></div>
      <div><span>子块</span><strong>${escapeHtml(imported.chunkCount || 0)} 个</strong></div>
      <div><span>表格行父块</span><strong>${escapeHtml(imported.tableRowParentCount || 0)} 个</strong></div>
      <div><span>最长子块</span><strong>${escapeHtml(imported.maxChildChars || 0)} 字</strong></div>
      <div><span>导入模式</span><strong>${escapeHtml(result.mode || "-")}</strong></div>
      <div><span>向量任务</span><strong>${escapeHtml(result.embeddingJobId || "未创建")}</strong></div>
      <div><span>版本</span><strong>#${escapeHtml(imported.versionNo || imported.version?.current?.versionNo || "-")}</strong></div>
    </div>
    ${imported.diffSummary ? `<p class="muted">导入差异：${escapeHtml(diffCountText(imported.diffSummary))}</p>` : ""}
    ${warnings ? `<div class="warning-box"><ul class="compact-list">${warnings}</ul></div>` : `<p class="muted">资料已导入，BM25 检索可立即使用。</p>`}
    <div class="task-section-title">向量索引</div>
    <pre class="command-box">${escapeHtml(result.embedCommands?.knowledgeBase || "npm run embed:local -- --full")}</pre>
    <p class="muted">页面导入会自动创建当前知识库的向量索引任务；如需手动重建，仍可运行上面的命令。</p>
  </div>`;
}

function renderRollbackResult(job) {
  return `<div class="result-card">
    <h2>回滚任务已完成</h2>
    <p class="muted">知识库内容已恢复，系统已按配置创建向量索引子任务。</p>
    <pre class="command-box">${escapeHtml(JSON.stringify(job.resultSummary || {}, null, 2))}</pre>
    <div class="button-row">
      <a class="nav-button" href="/jobs">打开任务中心</a>
    </div>
  </div>`;
}

function renderJobCreated(job) {
  return `<div class="result-card">
    <h2>导入任务已创建</h2>
    <p class="muted">任务会在后台执行，导入成功后会自动创建当前知识库的本地向量索引任务。</p>
    ${renderStageProgress({
      label: job.progress?.label || "等待执行",
      detail: job.progress?.detail || job.id,
      progress: job.progress?.percent || 0,
    })}
    <div class="button-row">
      <a class="nav-button" href="/jobs">打开任务中心</a>
    </div>
  </div>`;
}

async function waitForJob(jobId) {
  let last = null;
  for (let index = 0; index < 180; index += 1) {
    const result = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    last = result.job;
    if (last.status === "succeeded") return last;
    if (["failed", "cancelled"].includes(last.status)) {
      const error = new Error(last.error || `任务${last.status === "cancelled" ? "已取消" : "失败"}`);
      error.job = last;
      throw error;
    }
    setResult(renderJobCreated(last));
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const error = new Error("任务仍在后台执行，请到任务中心查看。");
  error.job = last;
  throw error;
}

function setResult(html) {
  const target = document.querySelector("#importResult");
  if (target) target.innerHTML = html;
}

function formValue(form, name) {
  return form.elements[name]?.value?.trim() || "";
}

async function refreshOverview() {
  overview = await api("/api/imports");
  setMessages(renderOverview());
  wireImportPage();
}

async function showVersions(kbId) {
  const versions = await api(`/api/knowledge-bases/${encodeURIComponent(kbId)}/versions`);
  setResult(renderVersionPanel(kbId, versions));
  document.querySelector("#closeVersionPanelBtn")?.addEventListener("click", () => setResult(""));
  document.querySelectorAll(".kb-rollback-btn").forEach((button) => {
    button.addEventListener("click", () => rollbackKnowledgeBase(button.dataset.kbId || "", button.dataset.versionId || "").catch((error) => {
      setResult(`<p class="error-text">${escapeHtml(error.message)}</p>`);
    }));
  });
}

async function rollbackKnowledgeBase(kbId, versionId) {
  const confirmText = window.prompt("输入 ROLLBACK 确认回滚到上一版。回滚不会删除培训任务、邀请、考试或记忆。");
  if (confirmText !== "ROLLBACK") return;
  setResult(renderStageProgress({ label: "创建回滚任务", detail: kbId, progress: 24 }));
  const { job } = await api(`/api/jobs/knowledge-bases/${encodeURIComponent(kbId)}/rollback`, {
    method: "POST",
    body: JSON.stringify({ versionId, confirm: "ROLLBACK", autoEmbed: true }),
  });
  setResult(renderJobCreated(job));
  const completed = await waitForJob(job.id);
  setResult(renderRollbackResult(completed));
  overview = await api("/api/imports");
  document.querySelector(".import-kb-grid").innerHTML = (overview.knowledgeBases || []).map(renderKbCard).join("");
  wireVersionButtons();
}

async function handleDirectoryImport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  setResult(renderStageProgress({ label: "读取目录中", detail: "正在检查本机资料目录", progress: 22 }));
  try {
    setResult(renderStageProgress({ label: "导入知识库中", detail: "正在清洗、切片并写入数据库", progress: 55 }));
    const { job } = await api("/api/jobs/import/directory", {
      method: "POST",
      body: JSON.stringify({
        inputDir: formValue(form, "inputDir"),
        kbName: formValue(form, "kbName"),
        aliases: formValue(form, "aliases"),
        cleanMode: formValue(form, "cleanMode"),
        autoEmbed: true,
      }),
    });
    setResult(renderJobCreated(job));
    const completed = await waitForJob(job.id);
    setResult(renderImportResult(completed.result || {}));
    overview = await api("/api/imports");
    document.querySelector(".import-kb-grid").innerHTML = (overview.knowledgeBases || []).map(renderKbCard).join("");
    wireVersionButtons();
  } catch (error) {
    setResult(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  } finally {
    button.disabled = false;
  }
}

function selectedFiles(form) {
  return [
    ...Array.from(form.elements.files?.files || []),
    ...Array.from(form.elements.filesFlat?.files || []),
  ];
}

async function handleUploadImport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const files = selectedFiles(form);
  if (!files.length) {
    setResult(`<p class="error-text">请先选择要上传的文件或文件夹。</p>`);
    return;
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  setResult(renderStageProgress({ label: "上传资料中", detail: `${files.length} 个文件，${formatBytes(totalBytes)}`, progress: 24 }));
  try {
    const formData = new FormData();
    formData.append("kbName", formValue(form, "kbName"));
    formData.append("aliases", formValue(form, "aliases"));
    formData.append("cleanMode", formValue(form, "cleanMode"));
    formData.append("relativePaths", JSON.stringify(files.map((file) => file.webkitRelativePath || file.name)));
    files.forEach((file) => {
      formData.append("files", file, file.name);
    });
    setResult(renderStageProgress({ label: "导入知识库中", detail: "上传完成后正在清洗和切片", progress: 58 }));
    formData.append("autoEmbed", "true");
    const { job } = await api("/api/jobs/import/upload", { method: "POST", body: formData });
    setResult(renderJobCreated(job));
    const completed = await waitForJob(job.id);
    setResult(renderImportResult(completed.result || {}));
    overview = await api("/api/imports");
    document.querySelector(".import-kb-grid").innerHTML = (overview.knowledgeBases || []).map(renderKbCard).join("");
    wireVersionButtons();
  } catch (error) {
    setResult(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  } finally {
    button.disabled = false;
  }
}

function wireVersionButtons() {
  document.querySelectorAll(".kb-version-btn").forEach((button) => {
    button.addEventListener("click", () => showVersions(button.dataset.kbId || "").catch((error) => {
      setResult(`<p class="error-text">${escapeHtml(error.message)}</p>`);
    }));
  });
}

function wireImportPage() {
  document.querySelector("#directoryImportForm")?.addEventListener("submit", handleDirectoryImport);
  document.querySelector("#uploadImportForm")?.addEventListener("submit", handleUploadImport);
  document.querySelector("#refreshImportsBtn")?.addEventListener("click", () => {
    refreshOverview().catch((error) => setResult(`<p class="error-text">${escapeHtml(error.message)}</p>`));
  });
  wireVersionButtons();
}

export async function setupImportsApp() {
  setComposerHidden(true);
  setMessages(`<article class="message assistant-message"><div class="avatar">AI</div><div class="bubble">${renderStageProgress({ label: "加载导入管理", detail: "正在读取知识库状态", progress: 35 })}</div></article>`);
  await refreshOverview();
}
