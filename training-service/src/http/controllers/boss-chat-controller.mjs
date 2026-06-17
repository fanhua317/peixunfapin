import {
  BOSS_ACCOUNT_ID,
  createBossChatSession,
  deleteBossChatSession,
  getBossChatSession,
  importLocalBossChatSessions,
  listBossChatSessions,
  updateBossChatSession,
} from "../../boss-chat/store.mjs";
import { readBody } from "../request.mjs";
import { sendJson } from "../response.mjs";

function notFound(res) {
  sendJson(res, 404, { error: "chat session not found" });
}

export async function handleBossChat(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/boss-chat/sessions") {
    const sessions = await listBossChatSessions({
      accountId: BOSS_ACCOUNT_ID,
      limit: Number(url.searchParams.get("limit")) || 80,
    });
    sendJson(res, 200, { accountId: BOSS_ACCOUNT_ID, sessions });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/boss-chat/sessions") {
    const body = await readBody(req);
    const session = await createBossChatSession({
      id: body.id,
      title: body.title,
      preview: body.preview,
      accountId: BOSS_ACCOUNT_ID,
    });
    sendJson(res, 200, { session, messages: [] });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/boss-chat/import-local") {
    const body = await readBody(req);
    const result = await importLocalBossChatSessions(body.sessions || [], { accountId: BOSS_ACCOUNT_ID });
    sendJson(res, 200, result);
    return true;
  }

  const match = url.pathname.match(/^\/api\/boss-chat\/sessions\/([^/]+)$/);
  if (!match) return false;

  const sessionId = decodeURIComponent(match[1]);

  if (req.method === "GET") {
    const result = await getBossChatSession(sessionId, { accountId: BOSS_ACCOUNT_ID });
    if (!result) return notFound(res), true;
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "PATCH") {
    const body = await readBody(req);
    const session = await updateBossChatSession(sessionId, {
      title: body.title,
      preview: body.preview,
      status: body.status,
    }, { accountId: BOSS_ACCOUNT_ID });
    if (!session) return notFound(res), true;
    sendJson(res, 200, { session });
    return true;
  }

  if (req.method === "DELETE") {
    const session = await deleteBossChatSession(sessionId, { accountId: BOSS_ACCOUNT_ID });
    if (!session) return notFound(res), true;
    sendJson(res, 200, { ok: true, session });
    return true;
  }

  return false;
}
