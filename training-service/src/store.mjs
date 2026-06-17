import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  isSqliteStorage,
  loadSqliteState,
  saveSqliteState,
  sqlitePathFor,
  sqliteStatus,
} from "./sqlite-store.mjs";
import { dataRootPath } from "./project-paths.mjs";

export const dataDir = process.env.TRAINING_DATA_DIR
  ? path.resolve(process.env.TRAINING_DATA_DIR)
  : dataRootPath("training-index");

export const statePath = path.join(dataDir, "state.json");
export const sqlitePath = sqlitePathFor(dataDir);

const nowIso = () => new Date().toISOString();

export const defaultState = () => ({
  meta: {
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
  knowledgeBases: [],
  documents: [],
  chunks: [],
  chunkParents: [],
  employees: [
    {
      id: "emp-wang-xiaoming",
      name: "王小明",
      aliases: ["小明"],
      department: "销售部",
      role: "销售新人",
      status: "active",
    },
    {
      id: "emp-li-xiaohong",
      name: "李小红",
      aliases: ["小红"],
      department: "销售部",
      role: "销售新人",
      status: "active",
    },
    {
      id: "emp-zhang-san",
      name: "张三",
      aliases: [],
      department: "售后部",
      role: "售后专员",
      status: "active",
    },
    {
      id: "emp-zoey",
      name: "zoey",
      aliases: ["Zoey"],
      department: "未分组",
      role: "员工",
      status: "active",
    },
  ],
  tasks: [],
  invites: [],
  quizzes: [],
  attempts: [],
  contentDrafts: [],
  events: [],
});

export async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

export async function loadState() {
  await ensureDataDir();
  if (isSqliteStorage()) {
    return normalizeState(loadSqliteState(dataDir, { statePath, defaultState }));
  }
  try {
    const raw = await readFile(statePath, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
    const state = defaultState();
    await saveState(state);
    return state;
  }
}

export function normalizeState(state) {
  const value = state && typeof state === "object" ? state : defaultState();
  value.knowledgeBases = Array.isArray(value.knowledgeBases) ? value.knowledgeBases : [];
  value.documents = Array.isArray(value.documents) ? value.documents : [];
  value.chunks = Array.isArray(value.chunks) ? value.chunks : [];
  value.chunkParents = Array.isArray(value.chunkParents) ? value.chunkParents : [];
  value.employees = Array.isArray(value.employees) ? value.employees : [];
  value.tasks = Array.isArray(value.tasks) ? value.tasks : [];
  value.invites = Array.isArray(value.invites) ? value.invites : [];
  value.quizzes = Array.isArray(value.quizzes) ? value.quizzes : [];
  value.attempts = Array.isArray(value.attempts) ? value.attempts : [];
  value.contentDrafts = Array.isArray(value.contentDrafts) ? value.contentDrafts : [];
  value.events = Array.isArray(value.events) ? value.events : [];
  return value;
}

export async function saveState(state) {
  await ensureDataDir();
  state.meta = {
    ...(state.meta || {}),
    version: 1,
    updatedAt: nowIso(),
  };
  if (isSqliteStorage()) {
    saveSqliteState(dataDir, normalizeState(state));
    return;
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function getStorageStatus() {
  if (isSqliteStorage()) return sqliteStatus(dataDir);
  return {
    storage: "json",
    path: statePath,
    exists: existsSync(statePath),
  };
}

export async function mutateState(mutator) {
  const state = await loadState();
  const result = await mutator(state);
  await saveState(state);
  return result;
}

export function appendEvent(state, type, payload = {}) {
  state.events.push({
    id: makeId("evt"),
    type,
    payload,
    createdAt: nowIso(),
  });
}

export function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function isoNow() {
  return nowIso();
}
