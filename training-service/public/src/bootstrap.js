import { setUnauthorizedHandler } from "./api.js";
import { ensureAuthenticated, renderLoginGate } from "./auth.js";
import { setupChatApp } from "./chat.js";
import { loadInvite } from "./invite.js";

export async function bootstrapApp() {
  setUnauthorizedHandler(renderLoginGate);
  if (!(await ensureAuthenticated())) return;
  const inviteMatch = window.location.pathname.match(/^\/t\/([^/]+)/);
  if (inviteMatch) {
    await loadInvite(inviteMatch[1]);
  } else {
    setupChatApp();
  }
}
