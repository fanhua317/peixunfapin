import { api } from "./api.js";
import { appendAssistantHtml, appendTyping, appendUserText, removeMessage, scrollToBottom } from "./messages.js";
import { escapeHtml, formatDate, renderQualitySummary, renderStageProgress } from "./ui.js";

let currentDraft = null;
const CHAT_SESSION_KEY = "juzhouTrainingChatSessionId";
const chatSessionId = (() => {
  const existing = localStorage.getItem(CHAT_SESSION_KEY);
  if (existing) return existing;
  const value = `boss-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(CHAT_SESSION_KEY, value);
  return value;
})();

function agentBody(payload = {}) {
  return JSON.stringify({
    sessionId: chatSessionId,
    memoryMode: "auto",
    ...payload,
  });
}

function renderDraftCard(draft) {
  const matchedEmployees = (draft.employees || []).map((employee) => employee.temporary
    ? `${employee.name}（自定义）`
    : `${employee.name}（${employee.department} / ${employee.role}）`);
  const temporaryEmployees = (draft.unmatchedEmployees || []).map((employee) => `${employee.name}（临时学习链接）`);
  const employees = matchedEmployees.length ? matchedEmployees.join("、") : temporaryEmployees.join("、") || "未指定";
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

function canPublishDraft(draft) {
  return Boolean(
    draft?.knowledgeBase?.id &&
    Array.isArray(draft.employees) &&
    draft.employees.length > 0,
  );
}

function focusComposer() {
  const input = document.querySelector("#chatInput");
  if (input) input.focus();
}

function disableActionButtons(button) {
  const actions = button?.closest(".message-actions");
  actions?.querySelectorAll("button").forEach((item) => {
    item.disabled = true;
  });
}

function isCurrentDraft(draft) {
  return Boolean(currentDraft && draft && currentDraft.id === draft.id);
}

function cancelDraft(draft, button) {
  if (isCurrentDraft(draft)) {
    currentDraft = null;
  }
  disableActionButtons(button);
  if (button) button.textContent = "已取消";
  appendAssistantHtml(`<p class="muted">已取消上一版草稿，请重新输入新的培训安排。</p>`);
  focusComposer();
}

function draftActionButtons(draft) {
  const actions = [];
  if (canPublishDraft(draft)) {
    actions.push({ label: "确认发布", onClick: (button) => publishCurrentDraft(button, {}, draft) });
  } else if (canForcePublishUnmatched(draft)) {
    actions.push({ label: "确认发布", onClick: (button) => publishCurrentDraft(button, { allowUnmatchedEmployees: true }, draft) });
  }
  actions.push({ label: "重新输入", variant: "secondary", onClick: (button) => cancelDraft(draft, button) });
  return actions;
}

function isDraftConfirmationMessage(message) {
  const text = String(message || "").trim().replace(/[，,。.!！?？\s]/g, "").toLowerCase();
  if (!text || text.length > 14) return false;
  return /^(确认|确定|确认发布|直接发布|直接发|继续发布|发吧|就这样|没问题|可以|可以发布|可以直接发布|同意|ok|yes)$/.test(text)
    || /^(不用匹配|不需要匹配|无需匹配|不用管)(员工|人员)?(确认|继续|直接)(?:发布)?$/.test(text);
}

function intentDisplayName(skill) {
  return {
    create_training_draft: "创建培训草稿",
    show_training_status: "查询培训进度",
    delete_training_records: "删除培训记录",
    generate_marketing_article: "生成营销软文",
    answer_general_chat: "普通聊天",
  }[skill] || "执行操作";
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

function renderIntentConfirmResult(result) {
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

function renderPublishResult(result) {
  const links = result.inviteLinks
    .map((link) => `<li><strong>${escapeHtml(link.employeeName)}${link.temporary ? "（自定义）" : ""}</strong><a href="${link.url}" target="_blank" rel="noreferrer">${escapeHtml(link.url)}</a></li>`)
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

function renderDeleteRecordsResult(result) {
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

function renderMarketingArticleResult(result) {
  const article = result.article || result || {};
  const warnings = (article.warnings || [])
    .map((warning) => `<div>${escapeHtml(warning)}</div>`)
    .join("");
  const sellingPoints = (article.sellingPoints || [])
    .map((point) => `<li>${escapeHtml(point)}</li>`)
    .join("");
  const sourceRefs = (article.sourceRefs || [])
    .map((source) => `<li>${escapeHtml(source)}</li>`)
    .join("");
  const body = String(article.article || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br />")}</p>`)
    .join("");
  const meta = [
    article.knowledgeBase?.name ? `资料：${article.knowledgeBase.name}` : "",
    article.retrievalMode ? `检索：${article.retrievalMode}` : "",
    article.model ? `模型：${article.model}` : "",
  ].filter(Boolean).join(" ｜ ");
  if (article.insufficient) {
    return `
      <div class="marketing-article">
        <p class="section-kicker">营销软文</p>
        <h2>${escapeHtml(article.title || "资料不足，无法生成软文")}</h2>
        <p class="error-text">${escapeHtml(article.summary || article.article || "资料不足，无法生成软文。")}</p>
        ${warnings ? `<div class="warning-box">${warnings}</div>` : ""}
      </div>
    `;
  }
  return `
    <div class="marketing-article">
      <p class="section-kicker">营销软文</p>
      <h2>${escapeHtml(article.title || "营销软文")}</h2>
      ${article.summary ? `<p class="article-summary">${escapeHtml(article.summary)}</p>` : ""}
      ${meta ? `<p class="muted">${escapeHtml(meta)}</p>` : ""}
      ${warnings ? `<div class="warning-box">${warnings}</div>` : ""}
      ${sellingPoints ? `<div class="task-section-title">核心卖点</div><ul class="compact-list">${sellingPoints}</ul>` : ""}
      <div class="article-body">${body || "<p>未生成正文。</p>"}</div>
      ${sourceRefs ? `<div class="task-section-title">资料来源</div><ul class="compact-list">${sourceRefs}</ul>` : ""}
    </div>
  `;
}

function renderMemoryListResult(result) {
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

function renderMemorySavedResult(result) {
  const saved = result.memory?.saved || [];
  if (!saved.length) return `<h2>记忆</h2><p class="muted">${escapeHtml(result.message || "没有新的记忆需要保存。")}</p>`;
  return `
    <h2>已保存记忆</h2>
    <ul class="compact-list">${saved.map((memory) => `<li>${escapeHtml(memory.text || memory.key)}</li>`).join("")}</ul>
  `;
}

function renderMemoryConfirmResult(result) {
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

function appendMemoryFeedback(result) {
  if (result.memory?.saved?.length) {
    appendAssistantHtml(renderMemorySavedResult({ memory: { saved: result.memory.saved } }));
  }
  if (result.memory?.candidates?.length) {
    appendAssistantHtml(renderMemoryConfirmResult({ memory: { candidates: result.memory.candidates } }), memoryConfirmActionButtons({ memory: { candidates: result.memory.candidates } }));
  }
}

function appendAgentResult(result) {
  if (result.action === "memory_confirm") {
    appendAssistantHtml(renderMemoryConfirmResult(result), memoryConfirmActionButtons(result));
    return;
  }
  if (result.action === "memory_saved") {
    appendAssistantHtml(renderMemorySavedResult(result));
    return;
  }
  if (result.action === "memory_list") {
    const article = appendAssistantHtml(renderMemoryListResult(result), [
      { label: "刷新记忆", variant: "secondary", onClick: () => refreshMemoryList() },
      { label: "清空记忆", variant: "secondary", onClick: () => requestClearMemory() },
    ]);
    wireMemoryListButtons(article);
    return;
  }
  if (result.action === "memory_deleted" || result.action === "memory_archived" || result.action === "memory_cleared") {
    appendAssistantHtml(`<h2>记忆已更新</h2><p class="muted">${escapeHtml(result.action)}</p>`);
    return;
  }
  if (result.action === "intent_confirm") {
    appendAssistantHtml(renderIntentConfirmResult(result), intentConfirmActionButtons(result));
    return;
  }
  if (result.action === "draft") {
    appendDraftResult(result);
    appendMemoryFeedback(result);
    return;
  }
  if (result.action === "status") {
    appendAssistantHtml(renderTaskStatusResult(result.tasks));
    appendMemoryFeedback(result);
    return;
  }
  if (result.action === "delete_records") {
    appendAssistantHtml(renderDeleteRecordsResult(result));
    appendMemoryFeedback(result);
    return;
  }
  if (result.action === "marketing_article") {
    appendAssistantHtml(renderMarketingArticleResult(result));
    appendMemoryFeedback(result);
    return;
  }
  appendAssistantHtml(renderChatAnswer(result.answer || "已处理。"));
  appendMemoryFeedback(result);
}

function memoryConfirmActionButtons(result) {
  const confirmation = result.confirmation || {};
  if (confirmation.type === "clear") {
    return [
      { label: "确认清空", onClick: (button) => confirmClearMemory(confirmation, button) },
      { label: "取消", variant: "secondary", onClick: (button) => cancelIntentConfirmation(button) },
    ];
  }
  return [
    { label: "保存", onClick: (button) => confirmMemoryCandidates(result.memory?.candidates || [confirmation], button) },
    { label: "忽略", variant: "secondary", onClick: (button) => ignoreMemoryCandidates(result.memory?.candidates || [confirmation], button) },
  ];
}

async function confirmMemoryCandidates(candidates, button) {
  disableActionButtons(button);
  try {
    const saved = [];
    for (const item of candidates) {
      if (!item.memory?.id) continue;
      const response = await api(`/api/memory/${encodeURIComponent(item.memory.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "active", confirmationToken: item.token || "" }),
      });
      saved.push(...(response.memory?.saved || []));
    }
    appendAssistantHtml(renderMemorySavedResult({ memory: { saved } }));
  } catch (error) {
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

async function ignoreMemoryCandidates(candidates, button) {
  disableActionButtons(button);
  try {
    for (const item of candidates) {
      if (!item.memory?.id) continue;
      await api(`/api/memory/${encodeURIComponent(item.memory.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "archived" }),
      });
    }
    appendAssistantHtml(`<p class="muted">已忽略这次记忆候选。</p>`);
  } catch (error) {
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

async function confirmClearMemory(confirmation, button) {
  disableActionButtons(button);
  try {
    const response = await api("/api/memory", {
      method: "DELETE",
      body: JSON.stringify({ confirmationToken: confirmation.token || "" }),
    });
    appendAgentResult(response);
  } catch (error) {
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

async function refreshMemoryList() {
  try {
    appendAgentResult(await api("/api/memory"));
  } catch (error) {
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

async function requestClearMemory() {
  try {
    appendAgentResult(await api("/api/agent/dispatch", {
      method: "POST",
      body: agentBody({ message: "清空全部记忆" }),
    }));
  } catch (error) {
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

function wireMemoryListButtons(article) {
  article.querySelectorAll("[data-memory-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        appendAgentResult(await api(`/api/memory/${encodeURIComponent(button.dataset.memoryDelete || "")}`, { method: "DELETE" }));
      } catch (error) {
        appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
      }
    });
  });
}

function intentConfirmActionButtons(result) {
  const skill = result.confirmation?.skill || result.decision?.skill || "";
  return [
    {
      label: skill === "delete_training_records" ? "确认删除" : "确认执行",
      onClick: (button) => confirmIntentAction(result, button),
    },
    {
      label: "当普通聊天",
      variant: "secondary",
      onClick: (button) => sendIntentAsGeneralChat(result, button),
    },
    {
      label: "重新输入",
      variant: "secondary",
      onClick: (button) => cancelIntentConfirmation(button),
    },
  ];
}

function cancelIntentConfirmation(button) {
  disableActionButtons(button);
  if (button) button.textContent = "已取消";
  appendAssistantHtml(`<p class="muted">已取消这次操作判断，请重新输入你的需求。</p>`);
  focusComposer();
}

async function confirmIntentAction(result, button) {
  const skill = result.confirmation?.skill || result.decision?.skill || "";
  const message = result.message || "";
  disableActionButtons(button);
  if (button) button.textContent = skill === "delete_training_records" ? "删除中..." : "执行中...";
  const progress = appendAssistantHtml(renderStageProgress({
    label: "执行确认操作",
    detail: `正在${intentDisplayName(skill)}`,
    progress: 45,
  }));
  try {
    const response = await api("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({
        sessionId: chatSessionId,
        memoryMode: "auto",
        message,
        confirmedSkill: skill,
        confirmationToken: result.confirmation?.token || "",
      }),
    });
    removeMessage(progress);
    appendAgentResult(response);
  } catch (error) {
    removeMessage(progress);
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

async function sendIntentAsGeneralChat(result, button) {
  disableActionButtons(button);
  if (button) button.textContent = "聊天中...";
  const progress = appendAssistantHtml(renderStageProgress({
    label: "普通聊天中",
    detail: "正在交给大模型直接回答",
    progress: 45,
  }));
  try {
    const response = await api("/api/chat", {
      method: "POST",
      body: agentBody({ message: result.message || "" }),
    });
    removeMessage(progress);
    appendAgentResult(response);
  } catch (error) {
    removeMessage(progress);
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

function agentStreamUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/agent/stream`;
}

function renderChatAnswer(answer) {
  return `<p>${escapeHtml(answer || "").replaceAll("\n", "<br />")}</p>`;
}

function renderStreamingAnswer(answer, stage) {
  return `${renderStageProgress(stage)}${answer ? renderChatAnswer(answer) : ""}`;
}

function setArticleBubble(article, html) {
  const bubble = article?.querySelector(".bubble");
  if (!bubble) return;
  bubble.innerHTML = html;
  scrollToBottom();
}

async function dispatchUserMessageStream(message) {
  if (!("WebSocket" in window)) {
    const error = new Error("WebSocket unavailable");
    error.streamUnavailable = true;
    throw error;
  }

  const article = appendAssistantHtml(renderStageProgress({
    label: "连接模型中",
    detail: "正在建立实时输出通道",
    progress: 12,
  }));
  let answer = "";
  let settled = false;
  let opened = false;

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(agentStreamUrl());
    const fail = (error) => {
      if (settled) return;
      settled = true;
      removeMessage(article);
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    ws.addEventListener("open", () => {
      opened = true;
      setArticleBubble(article, renderStageProgress({
        label: "发送问题中",
        detail: "已连接，正在交给模型处理",
        progress: 22,
      }));
      ws.send(agentBody({ message }));
    });

    ws.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "result") {
        removeMessage(article);
        appendAgentResult(data.payload || {});
        finish();
        ws.close();
        return;
      }
      if (data.type === "start") {
        const marketing = data.action === "marketing_article";
        setArticleBubble(article, renderStageProgress({
          label: marketing ? "生成软文中" : "模型思考中",
          detail: marketing ? "正在检索本地资料并组织营销文章" : "等待第一段输出",
          progress: marketing ? 48 : 38,
        }));
        return;
      }
      if (data.type === "delta") {
        answer += data.delta || "";
        setArticleBubble(article, renderStreamingAnswer(answer, {
          label: "正在生成回答",
          detail: "内容会持续更新",
          progress: 72,
        }));
        return;
      }
      if (data.type === "done") {
        if (data.payload?.answer && data.payload.answer !== answer) {
          answer = data.payload.answer;
        }
        setArticleBubble(article, renderChatAnswer(answer));
        finish();
        ws.close();
        return;
      }
      if (data.type === "error") {
        setArticleBubble(article, `<p class="error-text">${escapeHtml(data.error || "stream failed")}</p>`);
        finish();
        ws.close();
      }
    });

    ws.addEventListener("error", () => {
      const error = new Error(opened ? "WebSocket stream failed" : "WebSocket stream unavailable");
      error.streamUnavailable = !opened;
      fail(error);
    });

    ws.addEventListener("close", () => {
      if (!settled) {
        if (answer) finish();
        else {
          const error = new Error("WebSocket stream closed before response");
          error.streamUnavailable = !opened;
          fail(error);
        }
      }
    });
  });
}

async function publishCurrentDraft(button, options = {}, expectedDraft = null) {
  if (!currentDraft) return;
  if (expectedDraft && !isCurrentDraft(expectedDraft)) {
    disableActionButtons(button);
    appendAssistantHtml(`<p class="muted">这版草稿已经不是当前草稿，请以最新的确认卡片为准。</p>`);
    focusComposer();
    return;
  }
  const draft = currentDraft;
  currentDraft = null;
  if (button) {
    button.disabled = true;
    button.textContent = "发布中...";
  }
  const progress = appendAssistantHtml(renderStageProgress({
    label: "生成讲义中",
    detail: "正在根据知识库整理学习内容",
    progress: 24,
  }));
  const timers = [
    setTimeout(() => setArticleBubble(progress, renderStageProgress({
      label: "创建培训任务中",
      detail: "讲义生成后会写入任务记录",
      progress: 52,
    })), 2200),
    setTimeout(() => setArticleBubble(progress, renderStageProgress({
      label: "生成学习链接中",
      detail: "正在为学习对象准备专属入口",
      progress: 78,
    })), 7000),
  ];
  try {
    const result = await api("/api/tasks/publish", {
      method: "POST",
      body: JSON.stringify({ draft: { ...draft, ...options } }),
    });
    timers.forEach(clearTimeout);
    setArticleBubble(progress, renderStageProgress({
      label: "发布完成",
      detail: "学习链接已生成",
      progress: 100,
      active: false,
    }));
    removeMessage(progress);
    appendAssistantHtml(renderPublishResult(result));
  } catch (error) {
    currentDraft = draft;
    timers.forEach(clearTimeout);
    removeMessage(progress);
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

function appendDraftResult(result) {
  currentDraft = result.draft;
  const decision = result.decision
    ? `<p class="muted">已由智能助手判定意图：${escapeHtml(result.decision.intent || result.decision.skill)} ｜ ${escapeHtml(result.decision.source || "local")}${result.decision.thinking ? ` ｜ ${escapeHtml(result.decision.thinking)}` : ""}${result.decision.model ? ` ｜ ${escapeHtml(result.decision.model)}` : ""}</p>`
    : "";
  appendAssistantHtml(`${decision}${renderDraftCard(currentDraft)}`, draftActionButtons(currentDraft));
}

async function dispatchUserMessageHttp(message) {
  const typing = appendAssistantHtml(renderStageProgress({
    label: "发送请求中",
    detail: "正在等待服务端处理",
    progress: 30,
  }));
  try {
    const result = await api("/api/agent/dispatch", {
      method: "POST",
      body: agentBody({ message }),
    });
    removeMessage(typing);
    appendAgentResult(result);
  } catch (error) {
    removeMessage(typing);
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

async function dispatchUserMessage(message) {
  if (currentDraft && isDraftConfirmationMessage(message)) {
    if (canPublishDraft(currentDraft)) {
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
  try {
    await dispatchUserMessageStream(message);
  } catch (error) {
    if (error.streamUnavailable) {
      await dispatchUserMessageHttp(message);
      return;
    }
    appendAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

async function handleUserText(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  appendUserText(trimmed);
  await dispatchUserMessage(trimmed);
}

export function setupChatApp() {
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
