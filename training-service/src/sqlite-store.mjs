import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SQLITE_SCHEMA_VERSION = 4;

const STATE_COLLECTIONS = [
  { key: "knowledgeBases", table: "knowledge_bases" },
  { key: "documents", table: "documents" },
  { key: "chunkParents", table: "chunk_parents" },
  { key: "chunks", table: "chunks" },
  { key: "employees", table: "employees" },
  { key: "tasks", table: "tasks" },
  { key: "invites", table: "invites" },
  { key: "quizzes", table: "quizzes" },
  { key: "attempts", table: "attempts" },
  { key: "contentDrafts", table: "content_drafts" },
  { key: "events", table: "events" },
];

let cachedDb = null;
let cachedPath = "";

function boolOff(value) {
  return ["json", "0", "false", "off", "no"].includes(String(value || "").trim().toLowerCase());
}

export function storageMode() {
  return boolOff(process.env.TRAINING_STORAGE) ? "json" : "sqlite";
}

export function isSqliteStorage() {
  return storageMode() === "sqlite";
}

export function sqlitePathFor(dataDir) {
  return path.resolve(process.env.TRAINING_SQLITE_PATH || path.join(dataDir, "training.db"));
}

function safeIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe SQLite identifier: ${value}`);
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readJsonIfExists(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function backupJsonIfExists(filePath) {
  if (!existsSync(filePath)) return "";
  const parsed = path.parse(filePath);
  const backupPath = path.join(parsed.dir, `${parsed.name}.backup-${backupStamp()}${parsed.ext || ".json"}`);
  copyFileSync(filePath, backupPath);
  return backupPath;
}

function getItemId(collectionKey, item, index) {
  return String(item?.id || `${collectionKey}-${index + 1}`);
}

function itemIndexFields(item = {}) {
  return {
    knowledgeBaseId: item.knowledgeBaseId || item.knowledgeBase?.id || "",
    documentId: item.documentId || item.document?.id || "",
    taskId: item.taskId || item.task?.id || "",
    employeeId: item.employeeId || item.employee?.id || "",
    inviteId: item.inviteId || item.invite?.id || "",
    token: item.token || "",
    parentId: item.parentId || "",
    status: item.status || "",
    type: item.type || item.parentType || item.childType || "",
    key: item.key || "",
    scope: item.scope || "",
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || item.createdAt || "",
  };
}

function ensureRowTable(db, tableName) {
  const table = safeIdentifier(tableName);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      knowledgeBaseId TEXT,
      documentId TEXT,
      taskId TEXT,
      employeeId TEXT,
      inviteId TEXT,
      token TEXT,
      parentId TEXT,
      status TEXT,
      type TEXT,
      key TEXT,
      scope TEXT,
      createdAt TEXT,
      updatedAt TEXT,
      rowOrder INTEGER NOT NULL DEFAULT 0,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${table}_knowledge_base ON ${table}(knowledgeBaseId);
    CREATE INDEX IF NOT EXISTS idx_${table}_task ON ${table}(taskId);
    CREATE INDEX IF NOT EXISTS idx_${table}_employee ON ${table}(employeeId);
    CREATE INDEX IF NOT EXISTS idx_${table}_invite ON ${table}(inviteId);
    CREATE INDEX IF NOT EXISTS idx_${table}_token ON ${table}(token);
    CREATE INDEX IF NOT EXISTS idx_${table}_parent ON ${table}(parentId);
    CREATE INDEX IF NOT EXISTS idx_${table}_status ON ${table}(status);
    CREATE INDEX IF NOT EXISTS idx_${table}_updated_at ON ${table}(updatedAt);
  `);
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  for (const collection of STATE_COLLECTIONS) ensureRowTable(db, collection.table);
  ensureRowTable(db, "memories");
  ensureRowTable(db, "jobs");
  ensureRowTable(db, "knowledge_base_versions");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_sessions (
      id TEXT PRIMARY KEY,
      rowOrder INTEGER NOT NULL DEFAULT 0,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      sessionId TEXT,
      transport TEXT,
      route TEXT,
      messageHash TEXT,
      messagePreview TEXT,
      status TEXT,
      intent TEXT,
      skill TEXT,
      action TEXT,
      confirmedSkill TEXT,
      hasError INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT,
      finishedAt TEXT,
      latencyMs INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at ON agent_runs(createdAt);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_skill ON agent_runs(skill);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_action ON agent_runs(action);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_transport ON agent_runs(transport);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_has_error ON agent_runs(hasError);
    CREATE TABLE IF NOT EXISTS agent_steps (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      stepOrder INTEGER NOT NULL DEFAULT 0,
      type TEXT,
      name TEXT,
      status TEXT,
      startedAt TEXT,
      finishedAt TEXT,
      latencyMs INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(runId, stepOrder);
    CREATE INDEX IF NOT EXISTS idx_agent_steps_type ON agent_steps(type);
    CREATE INDEX IF NOT EXISTS idx_agent_steps_status ON agent_steps(status);
  `);
  setMeta(db, "schemaVersion", String(SQLITE_SCHEMA_VERSION));
}

function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function getMeta(db, key) {
  return db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key)?.value || "";
}

export function openTrainingDatabase(dataDir) {
  const dbPath = sqlitePathFor(dataDir);
  if (cachedDb && cachedPath === dbPath) return cachedDb;
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
    cachedPath = "";
  }
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  const busyTimeout = Number(process.env.TRAINING_SQLITE_BUSY_TIMEOUT_MS || 5000);
  db.pragma(`busy_timeout = ${Number.isFinite(busyTimeout) && busyTimeout >= 0 ? busyTimeout : 5000}`);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  ensureSchema(db);
  cachedDb = db;
  cachedPath = dbPath;
  return db;
}

export function closeTrainingDatabase() {
  if (!cachedDb) return;
  cachedDb.close();
  cachedDb = null;
  cachedPath = "";
}

export function sqliteStatus(dataDir) {
  const dbPath = sqlitePathFor(dataDir);
  return {
    storage: storageMode(),
    path: dbPath,
    exists: existsSync(dbPath),
  };
}

function replaceCollection(db, tableName, collectionKey, rows = []) {
  const table = safeIdentifier(tableName);
  db.prepare(`DELETE FROM ${table}`).run();
  const insert = db.prepare(`
    INSERT INTO ${table} (
      id, knowledgeBaseId, documentId, taskId, employeeId, inviteId, token, parentId,
      status, type, key, scope, createdAt, updatedAt, rowOrder, json
    ) VALUES (
      @id, @knowledgeBaseId, @documentId, @taskId, @employeeId, @inviteId, @token, @parentId,
      @status, @type, @key, @scope, @createdAt, @updatedAt, @rowOrder, @json
    )
  `);
  rows.forEach((item, index) => {
    const fields = itemIndexFields(item);
    insert.run({
      id: getItemId(collectionKey, item, index),
      ...fields,
      rowOrder: index,
      json: JSON.stringify({ ...item, id: item?.id || getItemId(collectionKey, item, index) }),
    });
  });
}

function readCollection(db, tableName) {
  const table = safeIdentifier(tableName);
  return db.prepare(`SELECT json FROM ${table} ORDER BY rowOrder ASC, id ASC`)
    .all()
    .map((row) => JSON.parse(row.json));
}

export function saveSqliteState(dataDir, state) {
  const db = openTrainingDatabase(dataDir);
  const value = {
    ...state,
    meta: {
      ...(state.meta || {}),
      version: 1,
      updatedAt: nowIso(),
    },
  };
  db.transaction(() => {
    setMeta(db, "state.meta", JSON.stringify(value.meta));
    for (const collection of STATE_COLLECTIONS) {
      replaceCollection(db, collection.table, collection.key, Array.isArray(value[collection.key]) ? value[collection.key] : []);
    }
    setMeta(db, "state.initialized", "1");
    setMeta(db, "state.updatedAt", value.meta.updatedAt);
  })();
  return value;
}

export function loadSqliteState(dataDir, { statePath, defaultState }) {
  const db = openTrainingDatabase(dataDir);
  if (getMeta(db, "state.initialized") !== "1") {
    const source = readJsonIfExists(statePath, defaultState());
    backupJsonIfExists(statePath);
    saveSqliteState(dataDir, source);
  }
  const meta = JSON.parse(getMeta(db, "state.meta") || "{}");
  const state = { meta };
  for (const collection of STATE_COLLECTIONS) {
    state[collection.key] = readCollection(db, collection.table);
  }
  return state;
}

function saveSqliteMemorySessions(db, sessions = {}) {
  db.prepare("DELETE FROM memory_sessions").run();
  const insert = db.prepare("INSERT INTO memory_sessions (id, rowOrder, json) VALUES (?, ?, ?)");
  Object.entries(sessions || {}).forEach(([id, value], index) => {
    insert.run(String(id), index, JSON.stringify(value));
  });
}

function readSqliteMemorySessions(db) {
  return Object.fromEntries(
    db.prepare("SELECT id, json FROM memory_sessions ORDER BY rowOrder ASC, id ASC")
      .all()
      .map((row) => [row.id, JSON.parse(row.json)]),
  );
}

export function saveSqliteMemoryStore(dataDir, store) {
  const db = openTrainingDatabase(dataDir);
  const value = {
    ...store,
    meta: {
      ...(store.meta || {}),
      version: 1,
      updatedAt: nowIso(),
    },
    memories: Array.isArray(store.memories) ? store.memories : [],
    sessions: store.sessions && typeof store.sessions === "object" ? store.sessions : {},
  };
  db.transaction(() => {
    setMeta(db, "memory.meta", JSON.stringify(value.meta));
    replaceCollection(db, "memories", "memories", value.memories);
    saveSqliteMemorySessions(db, value.sessions);
    setMeta(db, "memory.initialized", "1");
    setMeta(db, "memory.updatedAt", value.meta.updatedAt);
  })();
  return value;
}

export function loadSqliteMemoryStore(dataDir, { memoryPath, defaultMemoryStore }) {
  const db = openTrainingDatabase(dataDir);
  if (getMeta(db, "memory.initialized") !== "1") {
    const source = readJsonIfExists(memoryPath, defaultMemoryStore());
    backupJsonIfExists(memoryPath);
    saveSqliteMemoryStore(dataDir, source);
  }
  return {
    meta: JSON.parse(getMeta(db, "memory.meta") || "{}"),
    memories: readCollection(db, "memories"),
    sessions: readSqliteMemorySessions(db),
  };
}

export function migrateJsonToSqlite({ dataDir, statePath, memoryPath, defaultState, defaultMemoryStore, dryRun = false, force = false }) {
  const dbPath = sqlitePathFor(dataDir);
  const dbExists = existsSync(dbPath);
  let stateInitialized = false;
  let memoryInitialized = false;
  if (dbExists || !dryRun) {
    const db = openTrainingDatabase(dataDir);
    stateInitialized = getMeta(db, "state.initialized") === "1";
    memoryInitialized = getMeta(db, "memory.initialized") === "1";
  }
  const shouldImportState = force || !stateInitialized;
  const shouldImportMemory = force || !memoryInitialized;
  const state = readJsonIfExists(statePath, defaultState());
  const memory = readJsonIfExists(memoryPath, defaultMemoryStore());
  const summary = {
    dryRun,
    force,
    sqlitePath: dbPath,
    dbExists,
    stateJsonExists: existsSync(statePath),
    memoryJsonExists: existsSync(memoryPath),
    stateInitialized,
    memoryInitialized,
    counts: {
      knowledgeBases: state.knowledgeBases?.length || 0,
      documents: state.documents?.length || 0,
      chunkParents: state.chunkParents?.length || 0,
      chunks: state.chunks?.length || 0,
      employees: state.employees?.length || 0,
      tasks: state.tasks?.length || 0,
      invites: state.invites?.length || 0,
      quizzes: state.quizzes?.length || 0,
      attempts: state.attempts?.length || 0,
      memories: memory.memories?.length || 0,
      memorySessions: Object.keys(memory.sessions || {}).length,
    },
    skipped: !shouldImportState && !shouldImportMemory,
    imported: {
      state: false,
      memory: false,
    },
    backups: [],
  };
  if (dryRun || summary.skipped) return summary;
  if (shouldImportState) {
    const stateBackup = backupJsonIfExists(statePath);
    if (stateBackup) summary.backups.push(stateBackup);
    saveSqliteState(dataDir, state);
    summary.imported.state = true;
    summary.stateInitialized = true;
  }
  if (shouldImportMemory) {
    const memoryBackup = backupJsonIfExists(memoryPath);
    if (memoryBackup) summary.backups.push(memoryBackup);
    saveSqliteMemoryStore(dataDir, memory);
    summary.imported.memory = true;
    summary.memoryInitialized = true;
  }
  summary.skipped = false;
  return summary;
}

export function exportSqliteToJson({ dataDir, statePath, memoryPath }) {
  const state = loadSqliteState(dataDir, { statePath, defaultState: () => ({}) });
  const memory = loadSqliteMemoryStore(dataDir, { memoryPath, defaultMemoryStore: () => ({ memories: [], sessions: {} }) });
  const backups = [backupJsonIfExists(statePath), backupJsonIfExists(memoryPath)].filter(Boolean);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  writeFileSync(memoryPath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
  return {
    statePath,
    memoryPath,
    backups,
    counts: {
      knowledgeBases: state.knowledgeBases?.length || 0,
      chunks: state.chunks?.length || 0,
      tasks: state.tasks?.length || 0,
      memories: memory.memories?.length || 0,
    },
  };
}
