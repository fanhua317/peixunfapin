import { escapeHtml } from "./ui.js";

export function renderLoginGate(errorMessage = "") {
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

export async function ensureAuthenticated() {
  const response = await fetch("/api/auth/status", { headers: { "content-type": "application/json" } });
  const status = await response.json();
  if (status.enabled && !status.authenticated) {
    renderLoginGate();
    return false;
  }
  return true;
}
