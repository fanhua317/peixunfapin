import { api } from "../api.js";
import { appendAssistantHtml } from "../messages.js";
import { escapeHtml } from "../ui.js";
import { agentBody } from "./session.js";
import {
  renderMemoryConfirmResult,
  renderMemoryListResult,
  renderMemorySavedResult,
} from "./renderers.js";

export function createMemoryHandlers({
  appendAgentResult,
  cancelIntentConfirmation,
  disableActionButtons,
}) {
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

  function appendMemoryFeedback(result) {
    if (result.memory?.saved?.length) {
      appendAssistantHtml(renderMemorySavedResult({ memory: { saved: result.memory.saved } }));
    }
    if (result.memory?.candidates?.length) {
      appendAssistantHtml(
        renderMemoryConfirmResult({ memory: { candidates: result.memory.candidates } }),
        memoryConfirmActionButtons({ memory: { candidates: result.memory.candidates } }),
      );
    }
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

  return {
    appendMemoryFeedback,
    memoryConfirmActionButtons,
    refreshMemoryList,
    requestClearMemory,
    wireMemoryListButtons,
  };
}
