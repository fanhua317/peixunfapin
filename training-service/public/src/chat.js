import { api } from "./api.js";
import { appendAssistantHtml, appendUserText, removeMessage, scrollToBottom } from "./messages.js";
import {
  dismissLegacyChatImport,
  importLegacyChatHistory,
  mountChatHistory,
  persistCurrentChatHistory,
} from "./chat/history.js";
import { createMemoryHandlers } from "./chat/memory-actions.js";
import { agentBody, agentStreamUrl, chatSessionId } from "./chat/session.js";
import {
  canForcePublishUnmatched,
  canPublishDraft,
  intentDisplayName,
  isDraftConfirmationMessage,
  renderChatAnswer,
  renderDeleteRecordsResult,
  renderDraftCard,
  renderIntentConfirmResult,
  renderKnowledgeAnswerResult,
  renderMarketingArticleResult,
  renderMemoryConfirmResult,
  renderMemoryListResult,
  renderMemorySavedResult,
  renderPublishResult,
  renderStreamingAnswer,
  renderTaskStatusResult,
  renderTranslationRequest,
  renderTranslationResult,
} from "./chat/renderers.js";
import { escapeHtml, renderStageProgress } from "./ui.js";

let currentDraft = null;
let pendingTranslation = null;
let saveHistoryTimer = null;
let restoringConversation = false;
let observerStarted = false;

const memoryHandlers = createMemoryHandlers({
  appendAgentResult,
  cancelIntentConfirmation,
  disableActionButtons,
});

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

function createMessageId() {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function createMessageRecord(role, payload = {}) {
  return {
    id: payload.id || createMessageId(),
    role,
    createdAt: payload.createdAt || new Date().toISOString(),
    ...payload,
  };
}

function setArticleMessage(article, message) {
  if (!article || !message) return null;
  article.dataset.chatMessage = JSON.stringify(message);
  return message;
}

function bubbleHtmlWithoutActions(bubble) {
  const clone = bubble?.cloneNode(true);
  clone?.querySelectorAll(".message-actions").forEach((item) => item.remove());
  return clone?.innerHTML?.trim() || "";
}

function htmlToText(html) {
  const template = document.createElement("template");
  template.innerHTML = html || "";
  return (template.content.textContent || "").replace(/\s+/g, " ").trim();
}

function isWelcomeMessage(message) {
  return message?.role === "assistant"
    && typeof message.html === "string"
    && message.html.includes("class=\"suggestions\"")
    && message.html.includes("data-command");
}

function normalizeStoredMessage(message) {
  if (!message || typeof message !== "object") return null;
  const role = message.role === "user" ? "user" : "assistant";
  if (role === "user") {
    return createMessageRecord("user", {
      ...message,
      role: "user",
      text: String(message.text ?? message.content ?? ""),
    });
  }
  if (message.payload && typeof message.payload === "object") {
    return createMessageRecord("assistant", {
      ...message,
      role: "assistant",
      result: message.payload,
      draftStatus: message.draftStatus || message.payload.draftStatus || "",
    });
  }
  if (message.result && typeof message.result === "object") {
    return createMessageRecord("assistant", {
      ...message,
      role: "assistant",
      result: message.result,
      draftStatus: message.draftStatus || message.result.draftStatus || "",
    });
  }
  return createMessageRecord("assistant", {
    ...message,
    role: "assistant",
    html: String(message.html ?? message.content ?? ""),
  });
}

function readArticleMessage(article) {
  if (article.dataset.chatMessage) {
    try {
      return normalizeStoredMessage(JSON.parse(article.dataset.chatMessage));
    } catch {
      // Fall through to DOM-based recovery.
    }
  }
  const bubble = article.querySelector(".bubble");
  if (!bubble) return null;
  if (article.classList.contains("user-message")) {
    return createMessageRecord("user", {
      text: (bubble.textContent || "").trim(),
    });
  }
  if (bubble.querySelector(".stage-progress.active")) return null;
  return createMessageRecord("assistant", {
    html: bubbleHtmlWithoutActions(bubble),
  });
}

function readConversationMessages() {
  const messages = document.querySelector("#messages");
  const records = [...(messages?.querySelectorAll(":scope > .message") || [])]
    .map(readArticleMessage)
    .filter(Boolean);
  return records.filter((message) => !isWelcomeMessage(message));
}

function messagePreview(message) {
  if (!message) return "";
  if (message.role === "user") return message.text || "";
  const result = message.result || {};
  if (result.action === "draft") return `培训草稿：${result.draft?.title || ""}`;
  if (result.action === "publish_result" || result.action === "publish") return "培训已发布";
  if (result.action === "status") return "培训进度";
  if (result.action === "delete_records") return "培训记录删除结果";
  if (result.action === "marketing_article") return result.article?.title || "营销软文";
  if (result.action === "translation") return result.translatedText || result.error || "翻译结果";
  if (result.action === "translation_request") return result.message || "需要补充翻译原文";
  if (result.action === "knowledge_answer") return result.answer || "知识库答疑";
  if (result.answer) return result.answer;
  if (message.html) return htmlToText(message.html);
  return "";
}

function compact(value, limit = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function deriveConversationMeta() {
  const messages = readConversationMessages();
  const firstUser = messages.find((message) => message.role === "user" && message.text);
  const preview = [...messages].reverse().map(messagePreview).find(Boolean);
  return {
    messages,
    title: compact(firstUser?.text || "新聊天", 32),
    preview: compact(preview || firstUser?.text || "还没有消息", 72),
  };
}

function persistConversation() {
  clearTimeout(saveHistoryTimer);
  if (restoringConversation) return Promise.resolve();
  return persistCurrentChatHistory(deriveConversationMeta());
}

function scheduleHistorySave() {
  if (restoringConversation) return;
  clearTimeout(saveHistoryTimer);
  saveHistoryTimer = setTimeout(() => persistConversation(), 250);
}

function appendRecordedUserText(text) {
  const article = appendUserText(text);
  setArticleMessage(article, createMessageRecord("user", { text }));
  scheduleHistorySave();
  return article;
}

function appendRecordedAssistantHtml(html, actions = []) {
  const article = appendAssistantHtml(html, actions);
  setArticleMessage(article, createMessageRecord("assistant", { html }));
  scheduleHistorySave();
  return article;
}

function recordAssistantResult(article, result, extra = {}) {
  setArticleMessage(article, createMessageRecord("assistant", {
    result: cloneJson(result),
    ...extra,
  }));
  scheduleHistorySave();
  return article;
}

function appendAgentResultMessage(result, html, actions = [], options = {}) {
  const article = appendAssistantHtml(html, actions);
  if (options.record !== false) {
    recordAssistantResult(article, result, result.action === "draft"
      ? { draftStatus: options.draftStatus || "pending" }
      : {});
  }
  return article;
}

function markDraftMessages(draftId, status) {
  if (!draftId) return;
  document.querySelectorAll("#messages > .assistant-message").forEach((article) => {
    const message = readArticleMessage(article);
    if (message?.result?.action !== "draft") return;
    if (message.result.draft?.id !== draftId) return;
    const updated = {
      ...message,
      draftStatus: status,
    };
    setArticleMessage(article, updated);
    const bubble = article.querySelector(".bubble");
    if (bubble) bubble.innerHTML = renderDraftCard(message.result.draft, { status });
  });
  scheduleHistorySave();
}

function wireSuggestionButtons() {
  const input = document.querySelector("#chatInput");
  document.querySelectorAll("[data-command]").forEach((button) => {
    if (button.dataset.wired === "1") return;
    button.dataset.wired = "1";
    button.addEventListener("click", () => {
      input.value = button.dataset.command || "";
      input.focus();
    });
  });
}

function isCurrentDraft(draft) {
  return Boolean(currentDraft && draft && currentDraft.id === draft.id);
}

function cancelDraft(draft, button) {
  if (isCurrentDraft(draft)) {
    currentDraft = null;
  }
  markDraftMessages(draft?.id, "canceled");
  disableActionButtons(button);
  if (button) button.textContent = "已取消";
  appendRecordedAssistantHtml(`<p class="muted">已取消上一版草稿，请重新输入新的培训安排。</p>`);
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

function appendAgentResult(result, options = {}) {
  if (result.action === "memory_confirm") {
    return appendAgentResultMessage(result, renderMemoryConfirmResult(result), memoryHandlers.memoryConfirmActionButtons(result), options);
  }
  if (result.action === "memory_saved") {
    return appendAgentResultMessage(result, renderMemorySavedResult(result), [], options);
  }
  if (result.action === "memory_list") {
    const article = appendAgentResultMessage(result, renderMemoryListResult(result), [
      { label: "刷新记忆", variant: "secondary", onClick: () => memoryHandlers.refreshMemoryList() },
      { label: "清空记忆", variant: "secondary", onClick: () => memoryHandlers.requestClearMemory() },
    ], options);
    memoryHandlers.wireMemoryListButtons(article);
    return article;
  }
  if (result.action === "memory_deleted" || result.action === "memory_archived" || result.action === "memory_cleared") {
    return appendAgentResultMessage(result, `<h2>记忆已更新</h2><p class="muted">${escapeHtml(result.action)}</p>`, [], options);
  }
  if (result.action === "intent_confirm") {
    return appendAgentResultMessage(result, renderIntentConfirmResult(result), intentConfirmActionButtons(result), options);
  }
  if (result.action === "draft") {
    const article = appendDraftResult(result, options);
    if (options.record !== false) memoryHandlers.appendMemoryFeedback(result);
    return article;
  }
  if (result.action === "status") {
    const article = appendAgentResultMessage(result, renderTaskStatusResult(result.tasks), [], options);
    if (options.record !== false) memoryHandlers.appendMemoryFeedback(result);
    return article;
  }
  if (result.action === "delete_records") {
    const article = appendAgentResultMessage(result, renderDeleteRecordsResult(result), [], options);
    if (options.record !== false) memoryHandlers.appendMemoryFeedback(result);
    return article;
  }
  if (result.action === "marketing_article") {
    const article = appendAgentResultMessage(result, renderMarketingArticleResult(result), [], options);
    if (options.record !== false) memoryHandlers.appendMemoryFeedback(result);
    return article;
  }
  if (result.action === "translation_request") {
    pendingTranslation = {
      targetLanguage: result.targetLanguage || "",
      sourceText: result.sourceText || "",
    };
    return appendAgentResultMessage(result, renderTranslationRequest(result), [], options);
  }
  if (result.action === "translation") {
    pendingTranslation = null;
    return appendAgentResultMessage(result, renderTranslationResult(result), [], options);
  }
  if (result.action === "knowledge_answer") {
    const article = appendAgentResultMessage(result, renderKnowledgeAnswerResult(result), [], options);
    if (options.record !== false) memoryHandlers.appendMemoryFeedback(result);
    return article;
  }
  if (result.action === "publish_result" || result.action === "publish") {
    currentDraft = null;
    markDraftMessages(result.draftId, "published");
    return appendAgentResultMessage(result, renderPublishResult(result), [], options);
  }
  if (result.action === "local_transcript") {
    return appendAgentResultMessage(result, renderChatAnswer(result.transcript || result.answer || "已导入旧聊天记录。"), [], options);
  }
  return appendAgentResultMessage(result, renderChatAnswer(result.answer || result.transcript || "已处理。"), [], options);
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
  appendRecordedAssistantHtml(`<p class="muted">已取消这次操作判断，请重新输入你的需求。</p>`);
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
    appendRecordedAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
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
      body: agentBody({ message: result.message || "", forceGeneralChat: true }),
    });
    removeMessage(progress);
    appendAgentResult(response);
  } catch (error) {
    removeMessage(progress);
    appendRecordedAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
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
        const knowledge = data.action === "knowledge_answer";
        setArticleBubble(article, renderStageProgress({
          label: marketing ? "生成软文中" : knowledge ? "检索资料中" : "模型思考中",
          detail: marketing ? "正在检索本地资料并组织营销文章" : knowledge ? "正在匹配知识库并准备来源片段" : "等待第一段输出",
          progress: marketing || knowledge ? 48 : 38,
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
        recordAssistantResult(article, { action: "chat_answer", answer });
        finish();
        ws.close();
        return;
      }
      if (data.type === "error") {
        setArticleBubble(article, `<p class="error-text">${escapeHtml(data.error || "stream failed")}</p>`);
        recordAssistantResult(article, { action: "chat_error", answer: data.error || "stream failed" });
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

async function publishCurrentDraft(button, options = {}, expectedDraft = null, userMessage = "") {
  if (!currentDraft) return;
  if (expectedDraft && !isCurrentDraft(expectedDraft)) {
    disableActionButtons(button);
    appendRecordedAssistantHtml(`<p class="muted">这版草稿已经不是当前草稿，请以最新的确认卡片为准。</p>`);
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
      body: JSON.stringify({
        sessionId: chatSessionId,
        userMessage,
        draft: { ...draft, ...options },
      }),
    });
    timers.forEach(clearTimeout);
    setArticleBubble(progress, renderStageProgress({
      label: "发布完成",
      detail: "学习链接已生成",
      progress: 100,
      active: false,
    }));
    removeMessage(progress);
    markDraftMessages(draft.id, "published");
    appendAgentResult({ ...result, action: result.action || "publish" });
  } catch (error) {
    currentDraft = draft;
    timers.forEach(clearTimeout);
    removeMessage(progress);
    appendRecordedAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

function appendDraftResult(result, options = {}) {
  const draftStatus = options.draftStatus || result.draftStatus || "pending";
  if (draftStatus === "pending") {
    if (currentDraft?.id && currentDraft.id !== result.draft?.id) {
      markDraftMessages(currentDraft.id, "superseded");
    }
    currentDraft = result.draft;
  } else if (isCurrentDraft(result.draft)) {
    currentDraft = null;
  }
  const decision = result.decision
    ? `<p class="muted">已由智能助手判定意图：${escapeHtml(result.decision.intent || result.decision.skill)} ｜ ${escapeHtml(result.decision.source || "local")}${result.decision.thinking ? ` ｜ ${escapeHtml(result.decision.thinking)}` : ""}${result.decision.model ? ` ｜ ${escapeHtml(result.decision.model)}` : ""}</p>`
    : "";
  const actions = draftStatus === "pending" ? draftActionButtons(result.draft) : [];
  return appendAgentResultMessage(
    result,
    `${decision}${renderDraftCard(result.draft, { status: draftStatus })}`,
    actions,
    { ...options, draftStatus },
  );
}

async function dispatchUserMessageHttp(message, options = {}) {
  const typing = appendAssistantHtml(renderStageProgress({
    label: "发送请求中",
    detail: "正在等待服务端处理",
    progress: 30,
  }));
  try {
    const result = await api("/api/agent/dispatch", {
      method: "POST",
      body: agentBody({ message, displayMessage: options.displayMessage || "" }),
    });
    removeMessage(typing);
    appendAgentResult(result);
  } catch (error) {
    removeMessage(typing);
    appendRecordedAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

async function dispatchUserMessage(message) {
  if (currentDraft && isDraftConfirmationMessage(message)) {
    if (canPublishDraft(currentDraft)) {
      await publishCurrentDraft(null, {}, null, message);
      return;
    }
    if (canForcePublishUnmatched(currentDraft)) {
      await publishCurrentDraft(null, { allowUnmatchedEmployees: true }, null, message);
      return;
    }
    appendRecordedAssistantHtml(`<p class="error-text">当前草稿还不能发布，请先补充知识库或培训对象。</p>`);
    return;
  }
  try {
    await dispatchUserMessageStream(message);
  } catch (error) {
    if (error.streamUnavailable) {
      await dispatchUserMessageHttp(message);
      return;
    }
    appendRecordedAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
  }
}

function isTranslationCommand(text) {
  return /(翻译|译成|译为|translate\s+(?:to|into)|translation)/i.test(String(text || ""));
}

async function handleUserText(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  appendRecordedUserText(trimmed);
  if (pendingTranslation && !isTranslationCommand(trimmed)) {
    const targetLanguage = pendingTranslation.targetLanguage || (/[一-龥]/.test(trimmed) ? "英文" : "中文");
    const synthetic = `翻译成${targetLanguage}：${trimmed}`;
    pendingTranslation = null;
    await dispatchUserMessageHttp(synthetic, { displayMessage: trimmed });
    return;
  }
  await dispatchUserMessage(trimmed);
}

function renderStoredMessage(message) {
  const normalized = normalizeStoredMessage(message);
  if (!normalized) return;
  if (normalized.role === "user") {
    const article = appendUserText(normalized.text || "");
    setArticleMessage(article, normalized);
    return;
  }
  if (normalized.result) {
    const article = appendAgentResult(normalized.result, {
      record: false,
      draftStatus: normalized.draftStatus || normalized.result.draftStatus || "pending",
    });
    setArticleMessage(article, normalized);
    return;
  }
  const article = appendAssistantHtml(normalized.html || "");
  setArticleMessage(article, normalized);
}

function restoreSessionMessages(session, initialMessagesHtml) {
  const messages = document.querySelector("#messages");
  if (!messages) return;
  restoringConversation = true;
  currentDraft = null;
  pendingTranslation = null;
  messages.innerHTML = "";
  const records = Array.isArray(session?.messages) ? session.messages : [];
  if (records.length) {
    records.forEach(renderStoredMessage);
  } else {
    messages.innerHTML = initialMessagesHtml;
  }
  wireSuggestionButtons();
  scrollToBottom();
  focusComposer();
  setTimeout(() => {
    restoringConversation = false;
  }, 0);
}

function startHistoryObserver(messages) {
  if (!messages || observerStarted) return;
  observerStarted = true;
  const observer = new MutationObserver(scheduleHistorySave);
  observer.observe(messages, { childList: true, subtree: true, characterData: true });
}

function appendLegacyImportNotice() {
  appendRecordedAssistantHtml(`
    <h2>发现本机旧聊天记录</h2>
    <p class="muted">这些记录目前只保存在当前浏览器。确认导入后，会以安全文本形式保存到后台，其他电脑登录同一后台也能查看。</p>
  `, [
    {
      label: "导入旧记录",
      onClick: async (button) => {
        disableActionButtons(button);
        if (button) button.textContent = "导入中...";
        try {
          const result = await importLegacyChatHistory();
          appendRecordedAssistantHtml(`<p class="muted">已导入 ${escapeHtml(result.imported || 0)} 条旧聊天记录。</p>`);
        } catch (error) {
          appendRecordedAssistantHtml(`<p class="error-text">${escapeHtml(error.message)}</p>`);
        }
      },
    },
    {
      label: "不导入",
      variant: "secondary",
      onClick: (button) => {
        disableActionButtons(button);
        dismissLegacyChatImport();
        appendRecordedAssistantHtml(`<p class="muted">已忽略本机旧记录，后续新聊天会自动保存到后台。</p>`);
      },
    },
  ]);
}

export async function setupChatApp() {
  document.querySelector(".chat-shell")?.classList.add("chat-history-mode");
  const form = document.querySelector("#chatForm");
  const input = document.querySelector("#chatInput");
  const sendBtn = document.querySelector("#sendBtn");
  const messages = document.querySelector("#messages");
  const initialMessagesHtml = messages?.innerHTML || "";

  const applySession = (session) => {
    restoreSessionMessages(session, initialMessagesHtml);
  };

  const activeSession = await mountChatHistory({
    beforeSelect: persistConversation,
    onSelect: applySession,
    onLegacyImport: appendLegacyImportNotice,
  });
  if (activeSession) applySession(activeSession);
  startHistoryObserver(messages);

  wireSuggestionButtons();

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
