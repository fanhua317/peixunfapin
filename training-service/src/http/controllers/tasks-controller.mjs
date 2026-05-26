import { deleteTrainingRecords, getReportsOverview, getTaskStatus, publishTask } from "../../domain/index.mjs";
import { loadState, mutateState } from "../../store.mjs";
import { publicBaseUrl } from "../public-url.mjs";
import { readBody } from "../request.mjs";
import { sendJson } from "../response.mjs";

function inviteLinks(invites, base) {
  return invites.map((invite) => ({
    employeeName: invite.employeeName,
    temporary: invite.temporary === true,
    token: invite.token,
    url: `${base}/t/${invite.token}`,
  }));
}

export async function handleReports(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/api/reports/overview") return false;
  const state = await loadState();
  sendJson(res, 200, { report: getReportsOverview(state) });
  return true;
}

export async function handleTasks(req, res, url, context) {
  if (req.method === "POST" && url.pathname === "/api/tasks/publish") {
    const body = await readBody(req);
    const result = await mutateState((state) => publishTask(state, body.draft));
    const base = publicBaseUrl(req, context);
    sendJson(res, 200, {
      ...result,
      inviteLinks: inviteLinks(result.invites, base),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    const state = await loadState();
    sendJson(res, 200, {
      tasks: state.tasks.map((task) => getTaskStatus(state, task.id)),
    });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/tasks") {
    const result = await mutateState((state) => deleteTrainingRecords(state, { instruction: "删除全部培训记录" }));
    sendJson(res, 200, result);
    return true;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === "DELETE" && taskMatch) {
    const result = await mutateState((state) => deleteTrainingRecords(state, { query: taskMatch[1] }));
    if (!result.deleted.tasks) {
      sendJson(res, 404, { error: "task not found" });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "GET" && taskMatch) {
    const state = await loadState();
    const status = getTaskStatus(state, taskMatch[1]);
    if (!status) {
      sendJson(res, 404, { error: "task not found" });
      return true;
    }
    const base = publicBaseUrl(req, context);
    sendJson(res, 200, {
      ...status,
      inviteLinks: inviteLinks(status.invites, base),
    });
    return true;
  }

  return false;
}
