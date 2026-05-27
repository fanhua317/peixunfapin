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

function renderKbCard(kb) {
  const quality = kb.quality || {};
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
    ${renderQualitySummary(quality)}
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
          <p>支持本机目录导入和浏览器上传。导入后 BM25 立即可用，向量索引按页面提示手动重建。</p>
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
    </div>
    ${warnings ? `<div class="warning-box"><ul class="compact-list">${warnings}</ul></div>` : `<p class="muted">资料已导入，BM25 检索可立即使用。</p>`}
    <div class="task-section-title">向量索引手动重建</div>
    <pre class="command-box">${escapeHtml(result.embedCommands?.knowledgeBase || "npm run embed:local -- --full")}</pre>
    <p class="muted">如果想重建全部知识库索引，可运行：${escapeHtml(result.embedCommands?.full || "npm run embed:local -- --full")}</p>
  </div>`;
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

async function handleDirectoryImport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  setResult(renderStageProgress({ label: "读取目录中", detail: "正在检查本机资料目录", progress: 22 }));
  try {
    setResult(renderStageProgress({ label: "导入知识库中", detail: "正在清洗、切片并写入数据库", progress: 55 }));
    const result = await api("/api/imports/directory", {
      method: "POST",
      body: JSON.stringify({
        inputDir: formValue(form, "inputDir"),
        kbName: formValue(form, "kbName"),
        aliases: formValue(form, "aliases"),
        cleanMode: formValue(form, "cleanMode"),
      }),
    });
    setResult(renderImportResult(result));
    overview = await api("/api/imports");
    document.querySelector(".import-kb-grid").innerHTML = (overview.knowledgeBases || []).map(renderKbCard).join("");
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
    const result = await api("/api/imports/upload", { method: "POST", body: formData });
    setResult(renderImportResult(result));
    overview = await api("/api/imports");
    document.querySelector(".import-kb-grid").innerHTML = (overview.knowledgeBases || []).map(renderKbCard).join("");
  } catch (error) {
    setResult(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  } finally {
    button.disabled = false;
  }
}

function wireImportPage() {
  document.querySelector("#directoryImportForm")?.addEventListener("submit", handleDirectoryImport);
  document.querySelector("#uploadImportForm")?.addEventListener("submit", handleUploadImport);
  document.querySelector("#refreshImportsBtn")?.addEventListener("click", () => {
    refreshOverview().catch((error) => setResult(`<p class="error-text">${escapeHtml(error.message)}</p>`));
  });
}

export async function setupImportsApp() {
  setComposerHidden(true);
  setMessages(`<article class="message assistant-message"><div class="avatar">AI</div><div class="bubble">${renderStageProgress({ label: "加载导入管理", detail: "正在读取知识库状态", progress: 35 })}</div></article>`);
  await refreshOverview();
}
