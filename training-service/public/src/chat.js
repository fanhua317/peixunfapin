import { api } from "./api.js";
import { appendAssistantHtml, appendTyping, appendUserText, removeMessage, scrollToBottom } from "./messages.js";
import { mountChatHistory, persistCurrentChatHistory } from "./chat/history.js";
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
  renderMarketingArticleResult,
  renderMemoryConfirmResult,
  renderMemoryListResult,
  renderMemorySavedResult,
  renderPublishResult,
  renderStreamingAnswer,
  renderTaskStatusResult,
} from "./chat/renderers.js";
import { escapeHtml, renderStageProgress } from "./ui.js";

let currentDraft = null;
const memoryHandlers = createMemoryHandlers({
  appendAgentResult,
  cancelIntentConfirmation,
  disableActionButtons,
});
let saveHistoryTimer = null;

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

function deriveConversationMeta() {
  const messages = document.querySelector("#messages");
  const userTexts = [...(messages?.querySelectorAll(".user-message .bubble") || [])]
    .map((item) => item.textContent || "")
    .filter(Boolean);
  const allTexts = [...(messages?.querySelectorAll(".message .bubble") || [])]
    .map((item) => item.textContent || "")
    .filter(Boolean);
  return {
    html: messages?.innerHTML || "",
    title: userTexts[0] || "新聊天",
    preview: allTexts.at(-1) || userTexts[0] || "还没有消息",
  };
}

function persistConversation() {
  persistCurrentChatHistory(deriveConversationMeta());
}

function scheduleHistorySave() {
  clearTimeout(saveHistoryTimer);
  saveHistoryTimer = setTimeout(() => persistConversation(), 250);
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

function appendAgentResult(result) {
  if (result.action === "memory_confirm") {
    appendAssistantHtml(renderMemoryConfirmResult(result), memoryHandlers.memoryConfirmActionButtons(result));
    return;
  }
  if (result.action === "memory_saved") {
    appendAssistantHtml(renderMemorySavedResult(result));
    return;
  }
  if (result.action === "memory_list") {
    const article = appendAssistantHtml(renderMemoryListResult(result), [
      { label: "刷新记忆", variant: "secondary", onClick: () => memoryHandlers.refreshMemoryList() },
      { label: "清空记忆", variant: "secondary", onClick: () => memoryHandlers.requestClearMemory() },
    ]);
    memoryHandlers.wireMemoryListButtons(article);
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
    memoryHandlers.appendMemoryFeedback(result);
    return;
  }
  if (result.action === "status") {
    appendAssistantHtml(renderTaskStatusResult(result.tasks));
    memoryHandlers.appendMemoryFeedback(result);
    return;
  }
  if (result.action === "delete_records") {
    appendAssistantHtml(renderDeleteRecordsResult(result));
    memoryHandlers.appendMemoryFeedback(result);
    return;
  }
  if (result.action === "marketing_article") {
    appendAssistantHtml(renderMarketingArticleResult(result));
    memoryHandlers.appendMemoryFeedback(result);
    return;
  }
  appendAssistantHtml(renderChatAnswer(result.answer || "已处理。"));
  memoryHandlers.appendMemoryFeedback(result);
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
  document.querySelector(".chat-shell")?.classList.add("chat-history-mode");
  const form = document.querySelector("#chatForm");
  const input = document.querySelector("#chatInput");
  const sendBtn = document.querySelector("#sendBtn");
  const messages = document.querySelector("#messages");
  const initialMessagesHtml = messages?.innerHTML || "";

  const activeSession = mountChatHistory({
    initialHtml: initialMessagesHtml,
    beforeSelect: persistConversation,
    onSelect: (session) => {
      currentDraft = null;
      if (messages) messages.innerHTML = session.html || initialMessagesHtml;
      wireSuggestionButtons();
      scrollToBottom();
      focusComposer();
    },
  });
  if (activeSession?.html && messages) messages.innerHTML = activeSession.html;
  wireSuggestionButtons();

  if (messages) {
    const observer = new MutationObserver(scheduleHistorySave);
    observer.observe(messages, { childList: true, subtree: true, characterData: true });
    persistConversation();
  }

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
