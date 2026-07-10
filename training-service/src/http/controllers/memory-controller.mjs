import { verifyIntentConfirmationToken } from "../../intent-confirmation.mjs";
import { clearMemories, deleteMemory, listMemoryItems, updateMemory } from "../../memory/index.mjs";
import { memoryClearConfirmPayload, publicMemories } from "../../memory/flow.mjs";
import { decodePathSegment } from "../errors.mjs";
import { readBody } from "../request.mjs";
import { sendJson } from "../response.mjs";

function memoryIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/memory\/([^/]+)$/);
  return match ? decodePathSegment(match[1]) : "";
}

function verifyConfirmMemory(id, token) {
  return verifyIntentConfirmationToken(token, { message: id, skill: "confirm_memory" });
}

function verifyClearMemory(token) {
  return verifyIntentConfirmationToken(token, { message: "clear_memory", skill: "clear_memory" });
}

export async function handleMemory(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/memory") {
    const status = url.searchParams.get("status") || "";
    sendJson(res, 200, {
      action: "memory_list",
      memories: publicMemories(await listMemoryItems(status)),
    });
    return true;
  }

  const id = memoryIdFromPath(url.pathname);
  if (id && req.method === "PATCH") {
    const body = await readBody(req);
    const status = String(body.status || body.action || "").trim();
    if (status === "active" || status === "confirm") {
      const verification = verifyConfirmMemory(id, String(body.confirmationToken || ""));
      if (!verification.ok) {
        sendJson(res, 409, { error: "invalid memory confirmation", reason: verification.reason });
        return true;
      }
      const memory = await updateMemory(id, { status: "active", value: body.value, text: body.text });
      if (!memory) {
        sendJson(res, 404, { error: "memory not found" });
        return true;
      }
      sendJson(res, 200, { action: "memory_saved", memory: { saved: publicMemories([memory]) } });
      return true;
    }
    if (status === "archived" || status === "archive" || status === "ignore") {
      const memory = await updateMemory(id, { status: "archived" });
      if (!memory) {
        sendJson(res, 404, { error: "memory not found" });
        return true;
      }
      sendJson(res, 200, { action: "memory_archived", memory: publicMemories([memory])[0] });
      return true;
    }
    const memory = await updateMemory(id, { value: body.value, text: body.text });
    if (!memory) {
      sendJson(res, 404, { error: "memory not found" });
      return true;
    }
    sendJson(res, 200, { action: "memory_updated", memory: publicMemories([memory])[0] });
    return true;
  }

  if (id && req.method === "DELETE") {
    const deleted = await deleteMemory(id);
    sendJson(res, deleted ? 200 : 404, deleted
      ? { action: "memory_deleted", id }
      : { error: "memory not found" });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/memory") {
    const body = await readBody(req);
    const verification = verifyClearMemory(String(body.confirmationToken || ""));
    if (!verification.ok) {
      sendJson(res, 409, {
        error: "invalid memory confirmation",
        reason: verification.reason,
        ...memoryClearConfirmPayload(),
      });
      return true;
    }
    const result = await clearMemories();
    sendJson(res, 200, { action: "memory_cleared", ...result });
    return true;
  }

  return false;
}
