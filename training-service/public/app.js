let currentDraft = null;
let currentInvite = null;
let currentQuiz = null;

const inviteMatch = window.location.pathname.match(/^\/t\/([^/]+)/);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (response.status === 401) {
    renderLoginGate(payload.error || "请先输入访问密钥");
    throw new Error(payload.error || "access key required");
  }
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

function renderLoginGate(errorMessage = "") {
  document.body.classList.add("auth-mode");
  document.body.innerHTML = `
    <main class="login-shell">
      <section class="login-card">
        <div class="brand-row">
          <div class="brand-mark">钜</div>
          <div>
            <strong>培训系统</strong>
            <p>请输入访问密钥</p>
          </div>
        </div>
        <form id="loginForm" class="login-form">
          <input id="accessKeyInput" type="password" autocomplete="current-password" placeholder="访问密钥" />
          <button type="submit">进入系统</button>
        </form>
        <p id="loginError" class="error-text">${escapeHtml(errorMessage)}</p>
      </section>
    </main>
  `;
  const input = document.querySelector("#accessKeyInput");
  const form = document.querySelector("#loginForm");
  if (input) input.focus();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const key = input.value.trim();
    const error = document.querySelector("#loginError");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "登录失败");
      window.location.reload();
    } catch (errorValue) {
      error.textContent = errorValue instanceof Error ? errorValue.message : String(errorValue);
    }
  });
}

async function ensureAuthenticated() {
  const response = await fetch("/api/auth/status", { headers: { "content-type": "application/json" } });
  const status = await response.json();
  if (status.enabled && !status.authenticated) {
    renderLoginGate();
    return false;
  }
  return true;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function cleanLearningText(value, maxLength = 220) {
  const text = String(value || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[#*_`>]/g, "")
    .replace(/来源文件[:：]\s*[^\s。；;\n]+/g, "")
    .replace(/页数[:：]\s*\d+/g, "")
    .replace(/页码[:：]\s*\d+/g, "")
    .replace(/第\s*\d+\s*页/g, "")
    .replace(/\bhttps?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function isUsefulLearningText(value) {
  const text = cleanLearningText(value, 500);
  return text.length >= 8 && !/(来源文件|页数|页码|未能从|OCR|抽取|复制文本|导入|扫描件)/i.test(text);
}

function splitLearningText(value, limit = 4) {
  return [...new Set((cleanLearningText(value, 1200).match(/[^。！？；;.!?]+[。！？；;.!?]?/g) || [])
    .map((part) => cleanLearningText(part, 130))
    .filter(isUsefulLearningText))]
    .slice(0, limit);
}

function cleanLearningList(values, limit = 8) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  return [...new Set(list
    .flatMap((value) => splitLearningText(value, 2))
    .filter(isUsefulLearningText))]
    .slice(0, limit);
}

function inferLearningHeading(heading, points, index) {
  const current = cleanLearningText(heading, 80);
  if (current && !/^学习模块\s*\d+$/i.test(current)) return current;
  const text = points.join(" ");
  if (/定子|转子|绕组|铁芯|铸铝/.test(text)) return "电机结构与核心部件";
  if (/功率|电压|电流|转速|效率|功率因数|防护|绝缘|参数|铭牌/.test(text)) return "关键参数与铭牌识读";
  if (/启动|变频|运行|转差|转矩|调速|温升/.test(text)) return "运行特性与使用条件";
  if (/选型|客户|销售|拒绝|话术|沟通|应用/.test(text)) return "客户沟通与销售应用";
  if (/维护|检查|故障|安全|安装|保养/.test(text)) return "安装维护与安全要点";
  return `学习模块 ${index + 1}`;
}

function renderStudyGuide(value) {
  const lines = String(value || "")
    .split(/\n+/)
    .flatMap((line) => splitLearningText(line, 3))
    .filter(isUsefulLearningText)
    .slice(0, 6);
  return lines.length ? `<div class="study-guide">${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>` : "";
}

function cleanAnswerDisplayText(value) {
  return String(value || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderAnswerContent(result) {
  const keyPointList = Array.isArray(result.keyPoints) ? result.keyPoints : result.keyPoints ? [result.keyPoints] : [];
  const caveatList = Array.isArray(result.caveats) ? result.caveats : result.caveats ? [result.caveats] : [];
  const keyPoints = keyPointList.map((point) => `<li>${escapeHtml(cleanLearningText(point, 180))}</li>`).join("");
  const caveats = caveatList.map((item) => `<li>${escapeHtml(cleanLearningText(item, 180))}</li>`).join("");
  const badge = result.generatedBy
    ? `<span class="badge success">${escapeHtml(result.generatedBy)}${result.thinking ? ` / ${escapeHtml(result.thinking)}` : ""}${result.model ? ` / ${escapeHtml(result.model)}` : ""}</span>`
    : "";
  return `<div class="answer-main">
    <div class="task-head">
      <strong>资料回答</strong>
      ${badge}
    </div>
    <p>${escapeHtml(cleanAnswerDisplayText(result.answer || "未找到答案。")).replaceAll("\n", "<br />")}</p>
    ${keyPoints ? `<div class="task-section-title">关键要点</div><ul class="compact-list">${keyPoints}</ul>` : ""}
    ${caveats ? `<div class="task-section-title">注意事项</div><ul class="compact-list">${caveats}</ul>` : ""}
  </div>`;
}

function renderQualitySummary(quality) {
  if (!quality) return "";
  const warningItems = (quality.warnings || []).slice(0, 4).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const mode = quality.vectorIndex?.status === "ready" ? "语义检索可用" : "关键词检索模式";
  return `<div class="quality-box ${quality.warnings?.length ? "warn" : "ok"}">
    <div class="quality-head">
      <strong>资料质量 ${escapeHtml(quality.qualityScore ?? "-")} 分</strong>
      <span>${escapeHtml(mode)}</span>
    </div>
    <div class="quality-metrics">
      <span>文档 ${escapeHtml(quality.documents)}</span>
      <span>有效片段 ${escapeHtml(quality.usableChunks)}/${escapeHtml(quality.chunks)}</span>
      <span>OCR 占位 ${escapeHtml(quality.ocrPlaceholderChunks)}</span>
      <span>短文本 ${escapeHtml(quality.shortTextChunks)}</span>
    </div>
    ${warningItems ? `<ul class="compact-list">${warningItems}</ul>` : `<p class="muted">资料状态良好，可以用于学习和出题。</p>`}
  </div>`;
}

function scrollToBottom() {
  const messages = document.querySelector("#messages");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

function appendMessage(role, html, actions = []) {
  const messages = document.querySelector("#messages");
  const article = document.createElement("article");
  article.className = `message ${role}-message`;
  article.innerHTML = `
    <div class="avatar">${role === "user" ? "您" : "AI"}</div>
    <div class="bubble">${html}</div>
  `;
  const bubble = article.querySelector(".bubble");
  if (actions.length) {
    const actionsWrap = document.createElement("div");
    actionsWrap.className = "message-actions";
    actions.forEach((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.className = action.variant === "secondary" ? "secondary" : "";
      button.addEventListener("click", () => action.onClick(button));
      actionsWrap.append(button);
    });
    bubble.append(actionsWrap);
  }
  messages.append(article);
  scrollToBottom();
  return article;
}

function appendUserText(text) {
  return appendMessage("user", `<p>${escapeHtml(text)}</p>`);
}

function appendAssistantHtml(html, actions = []) {
  return appendMessage("assistant", html, actions);
}

function appendTyping() {
  return appendAssistantHtml(`<p class="typing">正在处理...</p>`);
}

function removeMessage(article) {
  if (article) article.remove();
}

function shouldQueryStatus(text) {
  return /(查询|查看|进度|完成情况|成绩|谁完成|谁没完成|状态|报表)/.test(text);
}

function shouldCreateTrainingDraft(text) {
  return (
    /(发布|安排|创建|新建|布置|分配|指派|生成|制定|做|建).*(培训|学习|考试|课程|题|计划|考察)/.test(text) ||
    /给.+(培训|学习|考试|课程)/.test(text) ||
    /(出|生成|做)\s*\d+\s*(道)?\s*(题|考题|试题)/.test(text) ||
    /(全部|所有|全员|全体).*(培训|学习|考试|课程|考察)/.test(text) ||
    /(培训|学习|考试|课程).*(全部|所有|全员|全体|员工|人员)/.test(text) ||
    /(及格|通过分数|截止时间|员工专属链接)/.test(text)
  );
}

function renderDraftCard(draft) {
  const matchedEmployees = (draft.employees || []).map((employee) => `${employee.name}（${employee.department} / ${employee.role}）`);
  const temporaryEmployees = (draft.unmatchedEmployees || []).map((employee) => `${employee.name}（临时学习链接）`);
  const employees = matchedEmployees.length ? matchedEmployees.join("、") : temporaryEmployees.join("、") || "未匹配";
  const warnings = draft.warnings?.length
    ? `<div class="warning-box">${draft.warnings.map((warning) => `<div>${escapeHtml(warning)}</div>`).join("")}</div>`
    : "";
  return `
    <h2>请确认培训安排</h2>
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

function canForcePublishUnmatched(draft) {
  return Boolean(
    draft?.knowledgeBase?.id &&
    (!Array.isArray(draft.employees) || draft.employees.length === 0) &&
    Array.isArray(draft.unmatchedEmployees) &&
    draft.unmatchedEmployees.length > 0,
  );
}

function draftActionButtons(draft) {
  const actions = [];
  if (!draft.warnings?.length) {
    actions.push({ label: "确认发布", onClick: publishCurrentDraft });
  } else if (canForcePublishUnmatched(draft)) {
    actions.push({ label: "生成临时链接并发布", onClick: (button) => publishCurrentDraft(button, { allowUnmatchedEmployees: true }) });
  }
  actions.push({ label: "重新输入", variant: "secondary", onClick: focusComposer });
  return actions;
}

function isDraftConfirmationMessage(message) {
  return /(直接发布|确认发布|不用匹配|不需要匹配|无需匹配|不用管|继续发布|发吧|就这样|没问题|可以发布|确认)/.test(String(message || ""));
}

function renderPublishResult(result) {
  const links = result.inviteLinks
    .map((link) => `<li><strong>${escapeHtml(link.employeeName)}${link.temporary ? "（临时）" : ""}</strong><a href="${link.url}" target="_blank" rel="noreferrer">${escapeHtml(link.url)}</a></li>`)
    .join("");
  return `
    <h2>培训已发布</h2>
    <p>任务：${escapeHtml(result.task.title)}</p>
    <p>请将以下员工专属链接转发给对应人员：</p>
    <ul class="link-list">${links}</ul>
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

function renderTaskStatusResult(tasks) {
  if (!tasks?.length) {
    return `<p>当前还没有培训任务。您可以直接输入培训安排，我会先生成确认草稿。</p>`;
  }
  return `
    <h2>培训进度</h2>
    <div class="status-list">${tasks.map(renderTaskStatus).join("")}</div>
  `;
}

async function showTaskStatus() {
  const typing = appendTyping();
  try {
    const result = await api("/api/tasks");
    removeMessage(typing);
    appendAssistantHtml(renderTaskStatusResult(result.tasks));
  } catch (error) {
    removeMessage(typing);
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

async function createDraftFromInstruction(instruction) {
  const typing = appendTyping();
  try {
    const result = await api("/api/agent/draft", {
      method: "POST",
      body: JSON.stringify({ instruction }),
    });
    currentDraft = result.draft;
    removeMessage(typing);
    appendAssistantHtml(renderDraftCard(currentDraft), draftActionButtons(currentDraft));
  } catch (error) {
    removeMessage(typing);
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

async function publishCurrentDraft(button, options = {}) {
  if (!currentDraft) return;
  const draft = currentDraft;
  currentDraft = null;
  if (button) {
    button.disabled = true;
    button.textContent = "发布中...";
  }
  const typing = appendTyping();
  try {
    const result = await api("/api/tasks/publish", {
      method: "POST",
      body: JSON.stringify({ draft: { ...draft, ...options } }),
    });
    removeMessage(typing);
    appendAssistantHtml(renderPublishResult(result));
  } catch (error) {
    currentDraft = draft;
    removeMessage(typing);
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

async function answerGeneralMessage(message) {
  const typing = appendTyping();
  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    removeMessage(typing);
    appendAssistantHtml(`<p>${escapeHtml(result.answer).replaceAll("\n", "<br />")}</p>`);
  } catch (error) {
    removeMessage(typing);
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

function appendDraftResult(result) {
  currentDraft = result.draft;
  const decision = result.decision
    ? `<p class="muted">已由 OpenClaw 判定意图：${escapeHtml(result.decision.intent || result.decision.skill)} ｜ ${escapeHtml(result.decision.source || "local")}${result.decision.thinking ? ` ｜ ${escapeHtml(result.decision.thinking)}` : ""}${result.decision.model ? ` ｜ ${escapeHtml(result.decision.model)}` : ""}</p>`
    : "";
  appendAssistantHtml(`${decision}${renderDraftCard(currentDraft)}`, draftActionButtons(currentDraft));
}

async function dispatchUserMessage(message) {
  if (currentDraft && isDraftConfirmationMessage(message)) {
    if (!currentDraft.warnings?.length) {
      await publishCurrentDraft();
      return;
    }
    if (canForcePublishUnmatched(currentDraft)) {
      await publishCurrentDraft(null, { allowUnmatchedEmployees: true });
      return;
    }
    appendAssistantHtml(`<p class="error-text">当前草稿还不能发布，请先补充知识库或培训对象。</p>`);
    return;
  }
  const typing = appendTyping();
  try {
    const result = await api("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    removeMessage(typing);
    if (result.action === "draft") {
      appendDraftResult(result);
      return;
    }
    if (result.action === "status") {
      appendAssistantHtml(renderTaskStatusResult(result.tasks));
      return;
    }
    appendAssistantHtml(`<p>${escapeHtml(result.answer || "已处理。").replaceAll("\n", "<br />")}</p>`);
  } catch (error) {
    removeMessage(typing);
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

function focusComposer() {
  const input = document.querySelector("#chatInput");
  if (input) input.focus();
}

async function handleUserText(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  appendUserText(trimmed);
  await dispatchUserMessage(trimmed);
}

function setupChatApp() {
  const form = document.querySelector("#chatForm");
  const input = document.querySelector("#chatInput");
  const sendBtn = document.querySelector("#sendBtn");

  document.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.command || "";
      input.focus();
    });
  });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value;
    input.value = "";
    input.style.height = "auto";
    sendBtn.disabled = true;
    try {
      await handleUserText(text);
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  });
}

function renderInviteApp() {
  document.body.innerHTML = `<main class="shell">
    <section class="card" id="inviteApp">
      <p class="eyebrow">苏州钜洲工业有限公司</p>
      <h1>培训任务加载中...</h1>
      <p class="muted">正在读取员工专属邀请链接。</p>
    </section>
  </main>`;
}

function renderTrainingMaterial(material, summary) {
  if (!material) {
    const fallbackLines = splitLearningText(summary, 5);
    return `<section class="task learning-card">
      <div class="task-head"><div><strong>学习内容</strong><p class="muted">基于当前知识库自动摘要。</p></div></div>
      <div class="study-guide">${fallbackLines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>
    </section>`;
  }
  const outline = (material.outline || [])
    .map((item, index) => ({
      points: cleanLearningList(item.points, 4),
      rawHeading: item.heading || `学习模块 ${index + 1}`,
    }))
    .map((item, index) => ({
      heading: inferLearningHeading(item.rawHeading, item.points, index),
      points: item.points,
    }))
    .filter((item) => item.heading && item.points.length)
    .map((item, index) => `<div class="module-card">
      <span>模块 ${index + 1}</span>
      <strong>${escapeHtml(item.heading)}</strong>
      <ul>${item.points.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>
    </div>`)
    .join("");
  const keyPoints = cleanLearningList(material.keyPoints, 8).map((point) => `<li>${escapeHtml(point)}</li>`).join("");
  const tips = cleanLearningList(material.practiceTips, 5).map((tip) => `<span class="badge">${escapeHtml(tip)}</span>`).join("");
  const sources = (material.sourceRefs || []).map((source) => `<li>${escapeHtml(source)}</li>`).join("");
  const materialLabel = material.generatedBy === "fallback" ? "本地整理" : material.generatedBy === "openclaw-text" ? "OpenClaw 文本" : "OpenClaw";
  const summaryCandidate = cleanLearningText(material.summary || summary || "", 260);
  const summaryText = isUsefulLearningText(summaryCandidate) ? summaryCandidate : "请按下方学习路径完成培训，先理解核心概念，再结合模块要点复盘，最后进入在线考试。";
  const studyGuide = renderStudyGuide(material.studyGuide);
  return `<section class="task learning-card">
    <div class="task-head learning-hero">
      <div>
        <span class="eyebrow">学习讲义</span>
        <strong>${escapeHtml(material.title || "培训内容")}</strong>
        <p class="material-summary">${escapeHtml(summaryText)}</p>
      </div>
      <span class="badge success">${escapeHtml(materialLabel)}${material.thinking ? ` / ${escapeHtml(material.thinking)}` : ""}${material.model ? ` / ${escapeHtml(material.model)}` : ""}</span>
    </div>
    ${keyPoints ? `<div class="task-section-title">本次要掌握</div><ul class="keypoint-list">${keyPoints}</ul>` : ""}
    ${outline ? `<div class="module-grid">${outline}</div>` : ""}
    ${studyGuide}
    ${tips ? `<div class="badges">${tips}</div>` : ""}
    ${sources ? `<details class="source-details"><summary>查看资料来源</summary><ul>${sources}</ul></details>` : ""}
  </section>`;
}

function renderInvite(result) {
  const root = document.querySelector("#inviteApp");
  if (result.expired || result.invite.status === "expired") {
    root.innerHTML = `<p class="eyebrow">苏州钜洲工业有限公司员工培训</p>
      <h1>${escapeHtml(result.task?.title || "培训任务已过期")}</h1>
      <section class="task">
        <strong>邀请链接已过期</strong>
        <p class="muted">该培训链接的截止时间为 ${formatDate(result.invite.expiresAt)}。请联系管理员重新发布或延长期限。</p>
      </section>`;
    return;
  }
  root.innerHTML = `<p class="eyebrow">苏州钜洲工业有限公司员工培训</p>
    <h1>${escapeHtml(result.task.title)}</h1>
    <p class="muted">学习人：${escapeHtml(result.invite.employeeName)} ｜ 截止时间：${formatDate(result.task.deadline)}</p>
    ${renderTrainingMaterial(result.trainingMaterial, result.summary)}
    <section class="task">
      <strong>向资料提问</strong>
      <p class="muted">学习过程中可以随时向资料库提问，系统会返回答案和引用来源。</p>
      <textarea id="question" rows="3" placeholder="例如：电机主要应用领域有哪些？"></textarea>
      <div class="actions"><button id="askBtn">提问</button></div>
      <div id="answerOutput" class="answer-output">等待提问...</div>
    </section>
    <section class="task">
      <div class="task-head">
        <div>
          <strong>在线考试</strong>
          <p class="muted">题目将由 OpenClaw 结合资料生成，并按性价比策略选择思考强度。</p>
        </div>
        <span class="badge">${escapeHtml(result.task.quizCount)} 题 / ${escapeHtml(result.task.passScore)} 分通过</span>
      </div>
      <div class="actions"><button id="startQuizBtn">生成并开始测试</button></div>
      <form id="quizForm" class="quiz"></form>
      <div id="quizOutput" class="quiz-output">还未开始测试。</div>
    </section>`;

  document.querySelector("#askBtn").addEventListener("click", () => askQuestion().catch((error) => {
    document.querySelector("#answerOutput").textContent = error.message;
  }));
  document.querySelector("#startQuizBtn").addEventListener("click", () => startQuiz().catch((error) => {
    document.querySelector("#quizOutput").textContent = error.message;
  }));
}

async function loadInvite(token) {
  renderInviteApp();
  const result = await api(`/api/invites/${token}`);
  currentInvite = result;
  renderInvite(result);
}

async function askQuestion() {
  const question = document.querySelector("#question").value;
  const output = document.querySelector("#answerOutput");
  output.innerHTML = `<p class="typing">检索资料中...</p>`;
  const result = await api("/api/answer", {
    method: "POST",
    body: JSON.stringify({ token: currentInvite.invite.token, question }),
  });
  const sourceRefs = result.sourceRefs?.length ? result.sourceRefs : (result.sources || []).map((source) => source.sourceRef);
  const sources = [...new Set(sourceRefs || [])].map((source) => `<li>${escapeHtml(source)}</li>`).join("");
  output.innerHTML = `<div class="answer-card">
    ${renderAnswerContent(result)}
    <details ${sources ? "" : "open"}><summary>引用来源</summary>${sources ? `<ul>${sources}</ul>` : "<p>无</p>"}</details>
  </div>`;
}

async function startQuiz() {
  const output = document.querySelector("#quizOutput");
  const startBtn = document.querySelector("#startQuizBtn");
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = "生成题目中...";
  }
  output.innerHTML = `<p class="typing">OpenClaw 正在按性价比策略生成题目...</p>`;
  const result = await api("/api/quiz/generate", {
    method: "POST",
    body: JSON.stringify({ taskId: currentInvite.task.id }),
  });
  currentQuiz = result.quiz;
  const form = document.querySelector("#quizForm");
  form.innerHTML = `<div class="quiz-meta">
    <span class="badge success">${escapeHtml(currentQuiz.generatedBy || "fallback")}${currentQuiz.thinking ? ` / ${escapeHtml(currentQuiz.thinking)}` : ""}${currentQuiz.model ? ` / ${escapeHtml(currentQuiz.model)}` : ""}</span>
    <span class="muted">共 ${currentQuiz.questions.length} 题，请全部作答后提交。</span>
  </div>` + currentQuiz.questions.map((question, index) => `<fieldset class="question question-card">
    <legend><span>${index + 1}</span>${escapeHtml(question.prompt)}</legend>
    <div class="option-list">
      ${question.options.map((option) => `<label class="option-card"><input type="radio" name="${question.id}" value="${escapeHtml(option)}" /> <span>${escapeHtml(option)}</span></label>`).join("")}
    </div>
  </fieldset>`).join("") + `<div class="actions sticky-submit"><button type="submit">提交答案</button></div>`;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitQuiz().catch((error) => { output.textContent = error.message; });
  }, { once: true });
  output.innerHTML = `<p class="muted">请完成题目后提交。</p>`;
  if (startBtn) startBtn.textContent = "题目已生成";
}

async function submitQuiz() {
  const output = document.querySelector("#quizOutput");
  const answers = {};
  for (const question of currentQuiz.questions) {
    const checked = document.querySelector(`input[name="${question.id}"]:checked`);
    answers[question.id] = checked ? checked.value : "";
  }
  const result = await api("/api/quiz/submit", {
    method: "POST",
    body: JSON.stringify({ token: currentInvite.invite.token, answers }),
  });
  document.querySelectorAll("#quizForm input").forEach((input) => {
    input.disabled = true;
  });
  const details = result.attempt.answers.map((entry, index) => `<div class="review-row ${entry.correct ? "correct" : "wrong"}">
    <div><strong>${index + 1}. ${entry.correct ? "正确" : "错误"}</strong><p>${escapeHtml(entry.prompt)}</p></div>
    <div class="review-answer">
      <span>你的答案：${escapeHtml(entry.submitted || "未作答")}</span>
      <span>正确答案：${escapeHtml(entry.correctAnswer)}</span>
      <p>${escapeHtml(entry.explanation || "").replaceAll("\n", "<br />")}</p>
    </div>
  </div>`).join("");
  output.innerHTML = `<div class="score-card ${result.attempt.passed ? "passed" : "failed"}">
    <strong>${result.attempt.score} 分</strong>
    <span>${result.attempt.passed ? "已通过" : "未通过"}</span>
  </div>
  <div class="review-list">${details}</div>`;
}

async function bootstrapApp() {
  if (!(await ensureAuthenticated())) return;
  if (inviteMatch) {
    await loadInvite(inviteMatch[1]);
  } else {
    setupChatApp();
  }
}

bootstrapApp().catch((error) => {
  document.body.innerHTML = `<main class="shell"><section class="card"><h1>链接不可用</h1><p class="muted">${escapeHtml(error.message)}</p></section></main>`;
});
