import { openInvite } from "../../domain/index.mjs";
import { mutateState } from "../../store.mjs";
import { sendJson } from "../response.mjs";

export async function handleInvites(req, res, url) {
  const inviteMatch = url.pathname.match(/^\/api\/invites\/([^/]+)$/);
  if (req.method !== "GET" || !inviteMatch) return false;

  const result = await mutateState((state) => openInvite(state, inviteMatch[1]));
  if (!result) {
    sendJson(res, 404, { error: "invite not found" });
    return true;
  }
  sendJson(res, 200, result);
  return true;
}
