import { api } from "./api.js";
import {
  cleanLearningList,
  cleanLearningText,
  escapeHtml,
  formatDate,
  inferLearningHeading,
  isUsefulLearningText,
  renderAnswerContent,
  renderStageProgress,
  renderStudyGuide,
} from "./ui.js";

let currentInvite = null;
let currentQuiz = null;

function renderInviteApp() {
  document.body.innerHTML = `<main class="shell">
    <section class="card" id="inviteApp">
      <p class="eyebrow">苏州钜洲工业有限公司</p>
      <h1>培训任务加载中...</h1>
      <p class="muted">正在读取员工专属邀请链接。</p>
    </section>
  </main>`;
}

function materialGeneratedByLabel(material) {
  const source = String(material?.generatedBy || "").toLowerCase();
  const model = String(material?.model || "").toLowerCase();
  if (source === "openclaw-text") return "OpenClaw 文本";
  if (source === "llm-api") return model.includes("deepseek") ? "DeepSeek" : "直连模型";
  if (source === "openclaw") return "OpenClaw";
  return source ? source : "AI 生成";
}

function renderWebSourcesDetails(result = {}) {
  if (result.webSearchMode !== "on") return "";
  const items = (result.webSources || []).slice(0, 6)
    .map((source) => `<li><strong>${escapeHtml(source.title || source.url || "联网来源")}</strong>${source.url ? `<a class="source-url" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.url)}</a>` : ""}${source.contentPreview ? `<div class="source-snippet">${escapeHtml(source.contentPreview)}</div>` : ""}</li>`)
    .join("");
  return `<details class="source-details"><summary>联网来源（${escapeHtml(result.webSearchStatus || "-")}）</summary>${items ? `<ul>${items}</ul>` : "<p>无</p>"}</details>`;
}

function renderTrainingMaterial(material, summary) {
  if (!material) {
    return `<section class="task learning-card">
      <div class="task-head"><div><strong>学习内容未生成</strong><p class="muted">当前培训没有可展示讲义。请联系管理员配置大模型 API 后重新发布培训。</p></div></div>
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
  const materialLabel = materialGeneratedByLabel(material);
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
    ${renderWebSourcesDetails(material)}
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
      <div class="actions">
        <label class="inline-check web-search-toggle"><input id="answerWebSearchToggle" type="checkbox" /> 联网搜索</label>
        <button id="askBtn">提问</button>
      </div>
      <div id="answerOutput" class="answer-output">等待提问...</div>
    </section>
    <section class="task">
      <div class="task-head">
        <div>
          <strong>在线考试</strong>
          <p class="muted">题目将由系统结合资料生成，并按性价比策略选择思考强度。</p>
        </div>
        <span class="badge">${escapeHtml(result.task.quizCount)} 题 / ${escapeHtml(result.task.passScore)} 分通过</span>
      </div>
      <div class="actions">
        <label class="inline-check web-search-toggle"><input id="quizWebSearchToggle" type="checkbox" /> 联网搜索</label>
        <button id="startQuizBtn">生成并开始测试</button>
      </div>
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

export async function loadInvite(token) {
  renderInviteApp();
  const result = await api(`/api/invites/${token}`);
  currentInvite = result;
  renderInvite(result);
}

async function askQuestion() {
  const question = document.querySelector("#question").value;
  const output = document.querySelector("#answerOutput");
  output.innerHTML = renderStageProgress({
    label: "检索资料中",
    detail: "正在筛选相关知识片段",
    progress: 32,
  });
  const timer = setTimeout(() => {
    output.innerHTML = renderStageProgress({
      label: "生成答案中",
      detail: "正在基于命中资料组织回答",
      progress: 68,
    });
  }, 1200);
  let result;
  try {
    result = await api("/api/answer", {
      method: "POST",
      body: JSON.stringify({
        token: currentInvite.invite.token,
        question,
        webSearchMode: document.querySelector("#answerWebSearchToggle")?.checked ? "on" : "off",
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  const sourceRefs = result.sourceRefs?.length ? result.sourceRefs : (result.sources || []).map((source) => source.sourceRef);
  const sources = [...new Set(sourceRefs || [])].map((source) => `<li>${escapeHtml(source)}</li>`).join("");
  const webSources = (result.webSources || []).map((source) => `<li><strong>${escapeHtml(source.title || source.url || "联网来源")}</strong>${source.url ? `<a class="source-url" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.url)}</a>` : ""}${source.contentPreview ? `<div class="source-snippet">${escapeHtml(source.contentPreview)}</div>` : ""}</li>`).join("");
  output.innerHTML = `<div class="answer-card">
    ${renderAnswerContent(result)}
    <details ${sources ? "" : "open"}><summary>知识库来源</summary>${sources ? `<ul>${sources}</ul>` : "<p>无</p>"}</details>
    ${result.webSearchMode === "on" ? `<details ${webSources ? "" : "open"}><summary>联网来源（${escapeHtml(result.webSearchStatus || "-")}）</summary>${webSources ? `<ul>${webSources}</ul>` : "<p>无</p>"}</details>` : ""}
  </div>`;
}

async function startQuiz() {
  const output = document.querySelector("#quizOutput");
  const startBtn = document.querySelector("#startQuizBtn");
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = "生成题目中...";
  }
  output.innerHTML = renderStageProgress({
    label: "读取培训资料中",
    detail: "正在准备出题上下文",
    progress: 28,
  });
  const timer = setTimeout(() => {
    output.innerHTML = renderStageProgress({
      label: "生成题目中",
      detail: "正在按培训内容组织考试题",
      progress: 64,
    });
  }, 1200);
  let result;
  try {
    result = await api("/api/quiz/generate", {
      method: "POST",
      body: JSON.stringify({
        taskId: currentInvite.task.id,
        token: currentInvite.invite.token,
        webSearchMode: document.querySelector("#quizWebSearchToggle")?.checked ? "on" : "off",
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  currentQuiz = result.quiz;
  const form = document.querySelector("#quizForm");
  form.innerHTML = `<div class="quiz-meta">
    <span class="badge success">${escapeHtml(currentQuiz.generatedBy || "llm")}${currentQuiz.thinking ? ` / ${escapeHtml(currentQuiz.thinking)}` : ""}${currentQuiz.model ? ` / ${escapeHtml(currentQuiz.model)}` : ""}</span>
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
  output.innerHTML = `<p class="muted">请完成题目后提交。</p>${renderWebSourcesDetails(currentQuiz)}`;
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
