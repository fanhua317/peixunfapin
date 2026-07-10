import { setUnauthorizedHandler } from "./api.js";
import { ensureAuthenticated, renderLoginGate } from "./auth.js";
import { setupChatApp } from "./chat.js";
import { setupImportsApp } from "./imports.js";
import { setupJobsApp } from "./jobs.js";
import { setupTracesApp } from "./traces.js";
import { loadInvite } from "./invite.js";

export async function bootstrapApp() {
  const inviteMatch = window.location.pathname.match(/^\/t\/([^/]+)/);
  if (inviteMatch) {
    setUnauthorizedHandler(null);
    await loadInvite(inviteMatch[1]);
    return;
  }
  setUnauthorizedHandler(renderLoginGate);
  if (!(await ensureAuthenticated())) return;
  if (window.location.pathname === "/imports") {
    await setupImportsApp();
  } else if (window.location.pathname === "/jobs") {
    await setupJobsApp();
  } else if (window.location.pathname === "/traces") {
    await setupTracesApp();
  } else {
    await setupChatApp();
  }
}
