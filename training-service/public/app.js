import { bootstrapApp } from "./src/bootstrap.js";
import { escapeHtml } from "./src/ui.js";

bootstrapApp().catch((error) => {
  document.body.innerHTML = `<main class="shell"><section class="card"><h1>链接不可用</h1><p class="muted">${escapeHtml(error.message)}</p></section></main>`;
});
