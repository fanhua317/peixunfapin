import { escapeHtml } from "./ui.js";

export function scrollToBottom() {
  const messages = document.querySelector("#messages");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

export function appendMessage(role, html, actions = []) {
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

export function appendUserText(text) {
  return appendMessage("user", `<p>${escapeHtml(text)}</p>`);
}

export function appendAssistantHtml(html, actions = []) {
  return appendMessage("assistant", html, actions);
}

export function appendTyping() {
  return appendAssistantHtml(`<p class="typing">正在处理...</p>`);
}

export function removeMessage(article) {
  if (article) article.remove();
}
