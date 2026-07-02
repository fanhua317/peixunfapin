import { escapeHtml, formatDate, renderQualitySummary, renderStageProgress } from "../ui.js";
import { renderMarkdown } from "../markdown.js";

function renderDraftStatusNote(status) {
  return {
    canceled: "这版草稿已取消。",
    published: "这版草稿已发布。",
    superseded: "这版草稿已被后续草稿替代。",
  }[status] || "";
}

export function renderDraftCard(draft, { status = "pending" } = {}) {
  const matchedEmployees = (draft.employees || []).map((employee) => employee.temporary
    ? `${employee.name}（自定义）`
    : `${employee.name}（${employee.department} / ${employee.role}）`);
  const temporaryEmployees = (draft.unmatchedEmployees || []).map((employee) => `${employee.name}（临时学习链接）`);
  const employees = matchedEmployees.length ? matchedEmployees.join("、") : temporaryEmployees.join("、") || "未指定";
  const warnings = draft.warnings?.length
    ? `<div class="warning-box">${draft.warnings.map((warning) => `<div>${escapeHtml(warning)}</div>`).join("")}</div>`
    : "";
  const statusNote = renderDraftStatusNote(status);
  return `
    <h2>请确认培训安排</h2>
    ${statusNote ? `<p class="muted draft-status-note">${escapeHtml(statusNote)}</p>` : ""}
    <div class="info-grid">
      <div><span>培训主题</span><strong>${escapeHtml(draft.title)}</strong></div>
      <div><span>培训对象</span><strong>${escapeHtml(employees)}</strong></div>
      <div><span>培训资料</span><strong>${escapeHtml(draft.knowledgeBase?.name || "未匹配")}</strong></div>
      <div><span>截止时间</span><strong>${formatDate(draft.deadline)}</strong></div>
      <div><span>题目数量</span><strong>${escapeHtml(draft.quizCount)} 道</strong></div>
      <div><span>通过分数</span><strong>${escapeHtml(draft.passScore)} 分</strong></div>
    </div>
    ${renderQualitySummary(draft.knowledgeBase?.quality)}
    ${warnings}
  `;
}

export function canForcePublishUnmatched(draft) {
  return Boolean(
    draft?.knowledgeBase?.id &&
    (!Array.isArray(draft.employees) || draft.employees.length === 0) &&
    Array.isArray(draft.unmatchedEmployees) &&
    draft.unmatchedEmployees.length > 0,
  );
}

export function canPublishDraft(draft) {
  return Boolean(
    draft?.knowledgeBase?.id &&
    Array.isArray(draft.employees) &&
    draft.employees.length > 0,
  );
}

export function isDraftConfirmationMessage(message) {
  const text = String(message || "").trim().replace(/[，,。.!！?？\s]/g, "").toLowerCase();
  if (!text || text.length > 14) return false;
  return /^(确认|确定|确认发布|直接发布|直接发|继续发布|发吧|就这样|没问题|可以|可以发布|可以直接发布|同意|ok|yes)$/.test(text)
    || /^(不用匹配|不需要匹配|无需匹配|不用管)(员工|人员)?(确认|继续|直接)(?:发布)?$/.test(text);
}

export function intentDisplayName(skill) {
  return {
    create_training_draft: "创建培训草稿",
    show_training_status: "查询培训进度",
    delete_training_records: "删除培训记录",
    generate_marketing_article: "生成营销软文",
    translate_text: "多语言翻译",
    answer_knowledge_question: "知识库答疑",
    answer_general_chat: "普通聊天",
  }[skill] || "执行操作";
}

export function renderTranslationResult(result) {
  if (result.error) {
    return `
      <div class="translation-card">
        <p class="section-kicker">多语言翻译</p>
        <h2>翻译失败</h2>
        <p class="error-text">${escapeHtml(result.error)}</p>
      </div>
    `;
  }
  return `
    <div class="translation-card">
      <p class="section-kicker">多语言翻译</p>
      <h2>已翻译成${escapeHtml(result.targetLanguage || "目标语言")}</h2>
      <div class="translation-grid">
        <div>
          <div class="task-section-title">原文</div>
          <div class="translation-source">${escapeHtml(result.sourceText || "")}</div>
        </div>
        <div>
          <div class="task-section-title">译文</div>
          <div class="translation-output markdown-body">${renderMarkdown(result.translatedText || "")}</div>
        </div>
      </div>
      ${result.model || result.webSearchMode === "on" ? `<p class="muted">${escapeHtml([
        result.model ? `模型：${result.model}` : "",
        result.webSearchMode === "on" ? `联网：${result.webSearchStatus || "-"}` : "",
      ].filter(Boolean).join(" ｜ "))}</p>` : ""}
      ${renderWarningBox(result.warnings || [])}
      ${renderWebSourcesSection(result)}
    </div>
  `;
}

export function renderTranslationRequest(result) {
  return `
    <div class="translation-card">
      <p class="section-kicker">多语言翻译</p>
      <h2>需要补充原文</h2>
      <p>${escapeHtml(result.message || "请提供要翻译的内容和目标语言。")}</p>
      ${result.targetLanguage ? `<p class="muted">目标语言：${escapeHtml(result.targetLanguage)}</p>` : ""}
    </div>
  `;
}

function decisionMeta(decision) {
  if (!decision) return "";
  const parts = [
    decision.source || "local",
    Number.isFinite(Number(decision.confidence)) ? `置信度 ${Math.round(Number(decision.confidence) * 100)}%` : "",
    decision.model ? `模型 ${decision.model}` : "",
  ].filter(Boolean);
  return parts.join(" ｜ ");
}

export function renderIntentConfirmResult(result) {
  const decision = result.decision || {};
  const confirmation = result.confirmation || {};
  const skill = confirmation.skill || decision.skill;
  const alternatives = (decision.alternatives || [])
    .map((item) => `<li>${escapeHtml(intentDisplayName(item.skill || item.intent))}${item.reason ? `：${escapeHtml(item.reason)}` : ""}</li>`)
    .join("");
  const warning = confirmation.risk === "high"
    ? `<div class="warning-box"><div>${escapeHtml(confirmation.description || "这是高风险操作，请确认后再执行。")}</div></div>`
    : "";
  return `
    <h2>${escapeHtml(confirmation.title || `确认${intentDisplayName(skill)}？`)}</h2>
    <p>${escapeHtml(decision.reason || confirmation.description || `我理解你想${intentDisplayName(skill)}。`)}</p>
    <div class="info-grid">
      <div><span>识别意图</span><strong>${escapeHtml(intentDisplayName(skill))}</strong></div>
      <div><span>来源</span><strong>${escapeHtml(decisionMeta(decision) || "-")}</strong></div>
    </div>
    ${warning}
    ${alternatives ? `<div class="task-section-title">可能的其他理解</div><ul class="compact-list">${alternatives}</ul>` : ""}
  `;
}

export function renderPublishResult(result) {
  const inviteLinks = Array.isArray(result.inviteLinks) ? result.inviteLinks : result.invites || [];
  const material = result.task?.trainingMaterial || {};
  const links = inviteLinks
    .map((link) => {
      const url = link.url || link.inviteUrl || link.link || "";
      const employeeName = link.employeeName || link.name || link.employee?.name || "学习对象";
      return `<li><strong>${escapeHtml(employeeName)}${link.temporary ? "（自定义）" : ""}</strong>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>` : ""}</li>`;
    })
    .join("");
  return `
    <h2>培训已发布</h2>
    <p>任务：${escapeHtml(result.task?.title || result.title || "培训任务")}</p>
    <p>请将以下员工专属链接转发给对应人员：</p>
    ${links ? `<ul class="link-list">${links}</ul>` : `<p class="muted">暂无学习链接。</p>`}
    ${material.webSearchMode === "on" ? `<div class="task-section-title">讲义联网状态</div><p class="muted">联网：${escapeHtml(material.webSearchStatus || "-")}</p>${renderWarningBox(material.warnings || [])}${renderWebSourcesSection(material)}` : ""}
  `;
}

function renderTaskStatus(status) {
  const total = status.summary.total || 0;
  const completed = status.summary.completed || 0;
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const attempts = (status.attempts || [])
    .map((attempt) => `<li>${escapeHtml(attempt.employeeName)}：${attempt.score} 分，${attempt.passed ? "通过" : "未通过"}</li>`)
    .join("");
  const pending = (status.summary.pendingEmployees || [])
    .map((employee) => `<li>${escapeHtml(employee.employeeName)}：${employee.expired ? "已过期" : employee.status}</li>`)
    .join("");
  const weakPoints = (status.summary.weakPoints || [])
    .map((item) => `<li>${escapeHtml(item.sourceRef)} × ${escapeHtml(item.count)}</li>`)
    .join("");
  return `
    <div class="status-card">
      <div class="status-head">
        <strong>${escapeHtml(status.task.title)}</strong>
        <span>${progress}%</span>
      </div>
      <div class="progress"><span style="width:${progress}%"></span></div>
      <div class="status-meta">
        <span>人数 ${total}</span>
        <span>已打开 ${status.summary.opened}</span>
        <span>已完成 ${completed}</span>
        <span>已过期 ${status.summary.expired || 0}</span>
        <span>平均分 ${status.summary.averageScore ?? "-"}</span>
      </div>
      ${pending ? `<div class="task-section-title">未完成</div><ul class="compact-list">${pending}</ul>` : ""}
      ${attempts ? `<ul class="compact-list">${attempts}</ul>` : `<p class="muted">暂无考试提交。</p>`}
      ${weakPoints ? `<div class="task-section-title">薄弱来源</div><ul class="compact-list">${weakPoints}</ul>` : ""}
    </div>
  `;
}

export function renderTaskStatusResult(tasks) {
  if (!tasks?.length) {
    return `<p>当前还没有培训任务。您可以直接输入培训安排，我会先生成确认草稿。</p>`;
  }
  return `
    <h2>培训进度</h2>
    <div class="status-list">${tasks.map(renderTaskStatus).join("")}</div>
  `;
}

export function renderDeleteRecordsResult(result) {
  const deleted = result.deleted || {};
  if (!deleted.tasks) {
    return `<h2>没有可删除的培训记录</h2><p>当前没有匹配到已发布的培训任务，现有知识库和员工名单不会受影响。</p>`;
  }
  return `
    <h2>培训记录已删除</h2>
    <div class="info-grid">
      <div><span>培训任务</span><strong>${escapeHtml(deleted.tasks)} 个</strong></div>
      <div><span>学习链接</span><strong>${escapeHtml(deleted.invites || 0)} 个</strong></div>
      <div><span>试卷</span><strong>${escapeHtml(deleted.quizzes || 0)} 份</strong></div>
      <div><span>答题提交</span><strong>${escapeHtml(deleted.attempts || 0)} 条</strong></div>
    </div>
    <p class="muted">知识库、员工名单和系统事件日志已保留。剩余培训任务：${escapeHtml(result.remainingTasks || 0)} 个。</p>
  `;
}

function completionWarning(result = {}) {
  return result.truncated || result.finishReason === "length"
    ? `<div class="warning-box"><div>${escapeHtml("达到模型输出上限，回答可能不完整。可以缩小问题范围后重新生成。")}</div></div>`
    : "";
}

function displayWarning(value) {
  if (value === "model_output_truncated") return "达到模型输出上限，回答可能不完整。";
  if (value === "web_search_requested_but_disabled") return "用户提到了联网搜索，但本次未开启联网搜索。";
  if (value === "web_search_unconfigured") return "联网搜索未配置，已继续使用本地/原始资料生成。";
  if (value === "web_search_failed") return "联网搜索失败，已继续使用本地/原始资料生成。";
  if (value === "web_search_empty") return "联网搜索未返回可用资料。";
  if (value === "web_search_empty_query") return "联网搜索查询为空，已跳过联网资料。";
  return String(value || "");
}

function renderWarningBox(warnings = []) {
  const items = (warnings || []).filter(Boolean)
    .map((warning) => `<div>${escapeHtml(displayWarning(warning))}</div>`)
    .join("");
  return items ? `<div class="warning-box">${items}</div>` : "";
}

function renderWebSourceItems(webSources = []) {
  return (webSources || [])
    .slice(0, 6)
    .map((source) => {
      const preview = source.contentPreview || "";
      const meta = [
        source.sourceRef || "",
        source.publishedDate ? `发布：${source.publishedDate}` : "",
        source.retrieval ? `检索：${source.retrieval}` : "",
      ].filter(Boolean).join(" ｜ ");
      return `
        <li>
          <strong>${escapeHtml(source.title || source.url || "联网来源")}</strong>
          ${source.url ? `<a class="source-url" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.url)}</a>` : ""}
          ${meta ? `<div class="source-meta">${escapeHtml(meta)}</div>` : ""}
          ${preview ? `<div class="source-snippet">${escapeHtml(preview)}</div>` : ""}
        </li>
      `;
    })
    .join("");
}

function renderWebSourcesSection(result = {}) {
  if (result.webSearchMode !== "on") return "";
  const items = renderWebSourceItems(result.webSources || []);
  const status = result.webSearchStatus || "-";
  return `
    <div class="task-section-title">联网来源（${escapeHtml(status)}）</div>
    ${items ? `<ul class="compact-list source-list web-source-list">${items}</ul>` : `<p class="muted">本次未返回可展示的联网来源。</p>`}
  `;
}

export function renderMarketingArticleResult(result) {
  const article = result.article || result || {};
  const articles = Array.isArray(article.articles) && article.articles.length ? article.articles : [article];
  const warnings = renderWarningBox(article.warnings || []);
  const meta = [
    article.knowledgeBase?.name ? `资料：${article.knowledgeBase.name}` : "",
    article.retrievalMode ? `检索：${article.retrievalMode}` : "",
    article.webSearchMode === "on" ? `联网：${article.webSearchStatus || "-"}` : "",
    article.model ? `模型：${article.model}` : "",
  ].filter(Boolean).join(" ｜ ");
  if (article.insufficient) {
    return `
      <div class="marketing-article">
        <p class="section-kicker">营销软文</p>
        <h2>${escapeHtml(article.title || "资料不足，无法生成软文")}</h2>
        <p class="error-text">${escapeHtml(article.summary || article.article || "资料不足，无法生成软文。")}</p>
        ${warnings}
        ${renderWebSourcesSection(article)}
      </div>
    `;
  }
  const renderedArticles = articles
    .map((item, index) => renderMarketingArticleBlock(item, { index, total: articles.length }))
    .join("");
  return `
    <div class="marketing-article">
      <p class="section-kicker">营销软文${articles.length > 1 ? ` · ${articles.length}篇` : ""}</p>
      <h2>${escapeHtml(article.title || articles[0]?.title || "营销软文")}</h2>
      ${article.summary ? `<p class="article-summary">${escapeHtml(article.summary)}</p>` : ""}
      ${meta ? `<p class="muted">${escapeHtml(meta)}</p>` : ""}
      ${completionWarning(article)}
      ${warnings}
      ${renderUniquenessSummary(article.uniqueness)}
      ${renderedArticles}
    </div>
  `;
}

function percentText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${Math.round(number * 1000) / 10}%`;
}

function renderMetricPill(label, value) {
  return `<span class="metric-pill"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></span>`;
}

function scoreText(value, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const threshold = Number(max);
  return Number.isFinite(threshold) ? `${Math.round(number)}/${Math.round(threshold)}` : String(Math.round(number));
}

function renderAiWritingIssues(issues = []) {
  const items = (issues || [])
    .slice(0, 5)
    .map((issue) => {
      const samples = (issue.samples || []).slice(0, 2).join(" / ");
      const label = [issue.label || issue.type || "AI writing pattern", issue.count ? `x${issue.count}` : ""].filter(Boolean).join(" ");
      return `<li>${escapeHtml(label)}${samples ? `：${escapeHtml(samples)}` : ""}</li>`;
    })
    .join("");
  return items ? `<ul class="compact-list">${items}</ul>` : "";
}

function renderUniquenessSummary(uniqueness = {}) {
  if (!uniqueness || uniqueness.enabled === false || !uniqueness.overallStatus) return "";
  const status = uniqueness.overallStatus === "ok" ? "通过" : "需注意";
  const historyDays = uniqueness.historyWindowDays || 3;
  const aiScoreLimit = uniqueness.thresholds?.aiWritingScoreMax ?? uniqueness.aiWritingScoreMax;
  const metrics = [
    renderMetricPill("状态", status),
    renderMetricPill("内部重复", percentText(uniqueness.internalRepeatRatio)),
    renderMetricPill("同批最高相似", percentText(uniqueness.batchMaxSimilarity)),
    renderMetricPill(`近${historyDays}天历史最高相似`, percentText(uniqueness.historyMaxSimilarity)),
    renderMetricPill("标题相似", percentText(uniqueness.titleSimilarity)),
    renderMetricPill("模板句命中", String(uniqueness.templatePhraseHits ?? 0)),
    renderMetricPill("AI 写作痕迹", scoreText(uniqueness.aiWritingScoreMax, aiScoreLimit)),
    renderMetricPill("AI 问题数", String(uniqueness.aiWritingIssueCount ?? 0)),
    renderMetricPill("重写次数", String(uniqueness.rewriteAttempts ?? 0)),
  ].join("");
  const issues = (uniqueness.issues || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return `
    <div class="uniqueness-summary">
      <div class="task-section-title">重复率 / AI 写作痕迹</div>
      <div class="metric-row">${metrics}</div>
      ${issues ? `<ul class="compact-list">${issues}</ul>` : ""}
      ${renderAiWritingIssues(uniqueness.aiWritingTopIssues || [])}
    </div>
  `;
}

function renderArticleUniqueness(uniqueness = null) {
  if (!uniqueness) return "";
  const metrics = [
    renderMetricPill("内部重复", percentText(uniqueness.internalRepeatRatio)),
    renderMetricPill("模板句命中", String(uniqueness.templatePhraseHits ?? 0)),
    renderMetricPill("AI 写作痕迹", scoreText(uniqueness.aiWritingScore, uniqueness.aiWritingScoreMax)),
    renderMetricPill("状态", uniqueness.status === "ok" ? "通过" : "需注意"),
  ].join("");
  return `<div class="article-uniqueness metric-row">${metrics}</div>${renderAiWritingIssues(uniqueness.aiWritingTopIssues || [])}`;
}

function renderMarketingArticleBlock(article = {}, { index = 0, total = 1 } = {}) {
  const sellingPoints = (article.sellingPoints || [])
    .map((point) => `<li>${escapeHtml(point)}</li>`)
    .join("");
  const sourceRefs = (article.sourceRefs || [])
    .map((source) => `<li>${escapeHtml(source)}</li>`)
    .join("");
  const body = renderMarkdown(article.article || "");
  return `
    <section class="article-variant">
      ${total > 1 ? `<p class="section-kicker">第 ${index + 1} 篇${article.angle ? ` · ${escapeHtml(article.angle)}` : ""}</p>` : article.angle ? `<p class="section-kicker">${escapeHtml(article.angle)}</p>` : ""}
      <h3>${escapeHtml(article.title || `营销软文 ${index + 1}`)}</h3>
      ${article.summary ? `<p class="article-summary">${escapeHtml(article.summary)}</p>` : ""}
      ${completionWarning(article)}
      ${renderWarningBox(article.warnings || [])}
      ${renderArticleUniqueness(article.uniqueness)}
      ${sellingPoints ? `<div class="task-section-title">核心卖点</div><ul class="compact-list">${sellingPoints}</ul>` : ""}
      <div class="article-body">${body || "<p>未生成正文。</p>"}</div>
      ${sourceRefs ? `<div class="task-section-title">资料来源</div><ul class="compact-list">${sourceRefs}</ul>` : ""}
      ${renderWebSourcesSection(article)}
    </section>
  `;
}

function sourcePreview(source) {
  return source.matchedPreview || source.contentPreview || "";
}

export function renderKnowledgeAnswerResult(result) {
  const sources = result.usedSources?.length ? result.usedSources : result.sources || [];
  const sourceItems = sources
    .slice(0, 6)
    .map((source) => {
      const preview = sourcePreview(source);
      const ids = [
        source.chunkId ? `chunk ${source.chunkId}` : "",
        source.parentId ? `parent ${source.parentId}` : "",
        source.retrieval ? `检索 ${source.retrieval}` : "",
      ].filter(Boolean).join(" ｜ ");
      return `
        <li>
          <strong>${escapeHtml(source.sourceRef || "未标注来源")}</strong>
          ${ids ? `<div class="source-meta">${escapeHtml(ids)}</div>` : ""}
          ${preview ? `<div class="source-snippet">${escapeHtml(preview)}</div>` : ""}
        </li>
      `;
    })
    .join("");
  const webItems = (result.webSources || [])
    .slice(0, 6)
    .map((source) => {
      const preview = source.contentPreview || "";
      const meta = [
        source.sourceRef || "",
        source.publishedDate ? `发布：${source.publishedDate}` : "",
        source.retrieval ? `检索 ${source.retrieval}` : "",
      ].filter(Boolean).join(" ｜ ");
      return `
        <li>
          <strong>${escapeHtml(source.title || source.url || "联网来源")}</strong>
          ${source.url ? `<a class="source-url" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.url)}</a>` : ""}
          ${meta ? `<div class="source-meta">${escapeHtml(meta)}</div>` : ""}
          ${preview ? `<div class="source-snippet">${escapeHtml(preview)}</div>` : ""}
        </li>
      `;
    })
    .join("");
  const caveats = (result.caveats || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const keyPoints = (result.keyPoints || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const meta = [
    result.knowledgeBase?.name ? `资料：${result.knowledgeBase.name}` : "",
    result.retrievalMode ? `检索：${result.retrievalMode}` : "",
    result.webSearchMode === "on" ? `联网：${result.webSearchStatus || "-"}` : "",
    result.confidence ? `置信度：${result.confidence}` : "",
    result.model ? `模型：${result.model}` : "",
  ].filter(Boolean).join(" ｜ ");
  if (result.insufficient || result.answerQuality?.status === "insufficient") {
    return `
      <div class="knowledge-answer">
        <p class="section-kicker">知识库答疑</p>
        <h2>资料不足，无法可靠回答</h2>
        <p class="error-text">${escapeHtml(result.answer || result.errorMessage || "当前知识库没有检索到足够相关的资料。")}</p>
        ${meta ? `<p class="muted">${escapeHtml(meta)}</p>` : ""}
        ${caveats ? `<div class="task-section-title">说明</div><ul class="compact-list">${caveats}</ul>` : ""}
      </div>
    `;
  }
  return `
    <div class="knowledge-answer">
      <p class="section-kicker">知识库答疑</p>
      ${meta ? `<p class="muted">${escapeHtml(meta)}</p>` : ""}
      ${completionWarning(result)}
      <div class="markdown-body">${renderMarkdown(result.answer || "")}</div>
      ${keyPoints ? `<div class="task-section-title">要点</div><ul class="compact-list">${keyPoints}</ul>` : ""}
      ${caveats ? `<div class="task-section-title">注意</div><ul class="compact-list">${caveats}</ul>` : ""}
      ${sourceItems ? `<div class="task-section-title">知识库来源</div><ul class="compact-list source-list">${sourceItems}</ul>` : ""}
      ${webItems ? `<div class="task-section-title">联网来源</div><ul class="compact-list source-list web-source-list">${webItems}</ul>` : ""}
    </div>
  `;
}

export function renderMemoryListResult(result) {
  const memories = result.memories || [];
  if (!memories.length) {
    return `<h2>本地记忆</h2><p class="muted">当前还没有保存的长期偏好或工作流经验。</p>`;
  }
  const items = memories.map((memory) => `
    <li>
      <strong>${escapeHtml(memory.text || memory.key)}</strong>
      <span class="muted"> ${escapeHtml(memory.status)} ｜ ${escapeHtml(memory.key)}</span>
      <button type="button" class="secondary" data-memory-delete="${escapeHtml(memory.id)}">删除</button>
    </li>
  `).join("");
  return `<h2>本地记忆</h2><ul class="compact-list">${items}</ul>`;
}

export function renderMemorySavedResult(result) {
  const saved = result.memory?.saved || [];
  if (!saved.length) return `<h2>记忆</h2><p class="muted">${escapeHtml(result.message || "没有新的记忆需要保存。")}</p>`;
  return `
    <h2>已保存记忆</h2>
    <ul class="compact-list">${saved.map((memory) => `<li>${escapeHtml(memory.text || memory.key)}</li>`).join("")}</ul>
  `;
}

export function renderMemoryConfirmResult(result) {
  const confirmation = result.confirmation || {};
  const candidates = result.memory?.candidates || (confirmation.type === "candidate" ? [confirmation] : []);
  if (confirmation.type === "clear") {
    return `
      <h2>${escapeHtml(confirmation.title || "确认清空记忆？")}</h2>
      <div class="warning-box"><div>${escapeHtml(confirmation.description || "该操作会清空本地记忆。")}</div></div>
    `;
  }
  return `
    <h2>保存这条记忆？</h2>
    <p class="muted">我识别到可能有用的长期偏好，请确认后再保存。</p>
    <ul class="compact-list">${candidates.map((item) => `<li>${escapeHtml(item.memory?.text || item.description || "")}</li>`).join("")}</ul>
  `;
}

export function renderChatAnswer(answer) {
  return `<div class="markdown-body">${renderMarkdown(answer || "")}</div>`;
}

export function renderChatResult(result = {}) {
  const notices = [];
  if (result.streamIncomplete) {
    notices.push(result.error
      ? `连接提前中断，以下为已收到内容。错误：${result.error}`
      : "连接提前中断，以下为已收到内容，回答可能不完整。");
  }
  if (result.truncated || result.finishReason === "length") {
    notices.push("达到模型输出上限，回答可能不完整。可以缩小问题范围后重新生成。");
  }
  const noticeHtml = notices.length
    ? `<div class="warning-box">${notices.map((notice) => `<div>${escapeHtml(notice)}</div>`).join("")}</div>`
    : "";
  return `${noticeHtml}${renderWarningBox(result.warnings || [])}${renderChatAnswer(result.answer || "")}${renderWebSourcesSection(result)}`;
}

export function renderStreamingAnswer(answer, stage) {
  return `${renderStageProgress(stage)}${answer ? renderChatAnswer(answer) : ""}`;
}
