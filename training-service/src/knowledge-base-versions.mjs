import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getKnowledgeBaseQuality } from "./quality.mjs";
import { dataDir, isoNow, loadState, makeId, mutateState } from "./store.mjs";
import { isSqliteStorage, openTrainingDatabase } from "./sqlite-store.mjs";

export const knowledgeBaseVersionsPath = path.join(dataDir, "knowledge-base-versions.json");

let jsonWriteLock = Promise.resolve();

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function jsonHash(value) {
  return sha256(JSON.stringify(value ?? null));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function nowIso() {
  return isoNow();
}

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .trim()
    .toLowerCase();
}

function summarizeQuality(state, knowledgeBaseId) {
  const quality = getKnowledgeBaseQuality(state, knowledgeBaseId, { status: "unknown" });
  return {
    qualityScore: quality.qualityScore,
    warnings: quality.warnings || [],
    usableChunks: quality.usableChunks || 0,
    orphanChildChunks: quality.orphanChildChunks || 0,
    ocrPlaceholderChunks: quality.ocrPlaceholderChunks || 0,
    shortTextChunks: quality.shortTextChunks || 0,
    lowValueChunks: quality.lowValueChunks || 0,
  };
}

function snapshotSummary(snapshot, stateForQuality = null) {
  const parents = snapshot.chunkParents || [];
  const chunks = snapshot.chunks || [];
  const documents = snapshot.documents || [];
  const tableRowParentCount = parents.filter((parent) => parent.parentType === "table_row").length;
  const maxChildChars = chunks.reduce((max, chunk) => Math.max(max, String(chunk.content || "").length), 0);
  const summary = {
    kbId: snapshot.knowledgeBase?.id || "",
    kbName: snapshot.knowledgeBase?.name || "",
    documents: documents.length,
    chunkParents: parents.length,
    chunks: chunks.length,
    tableRowParentCount,
    maxChildChars,
    contentHash: jsonHash({
      knowledgeBase: snapshot.knowledgeBase,
      documents,
      chunkParents: parents,
      chunks,
    }),
  };
  if (stateForQuality && summary.kbId) {
    summary.quality = summarizeQuality(stateForQuality, summary.kbId);
  }
  return summary;
}

export function createKnowledgeBaseSnapshot(state, knowledgeBaseId) {
  const kbId = String(knowledgeBaseId || "");
  const knowledgeBase = (state.knowledgeBases || []).find((kb) => kb.id === kbId);
  if (!knowledgeBase) return null;
  const documents = (state.documents || []).filter((item) => item.knowledgeBaseId === kbId);
  const documentIds = new Set(documents.map((item) => String(item.id)));
  return {
    knowledgeBase: clone(knowledgeBase),
    documents: clone(documents),
    chunkParents: clone((state.chunkParents || []).filter((item) => item.knowledgeBaseId === kbId && documentIds.has(String(item.documentId)))),
    chunks: clone((state.chunks || []).filter((item) => item.knowledgeBaseId === kbId && documentIds.has(String(item.documentId)))),
  };
}

function documentHash(snapshot, document) {
  const documentId = String(document.id || "");
  const parents = (snapshot.chunkParents || [])
    .filter((item) => String(item.documentId || "") === documentId)
    .map((item) => ({
      sourceRef: item.sourceRef || "",
      sectionPath: item.sectionPath || [],
      heading: item.heading || "",
      parentType: item.parentType || "",
      contentHash: item.contentHash || sha256(item.content || ""),
      content: item.content || "",
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const chunks = (snapshot.chunks || [])
    .filter((item) => String(item.documentId || "") === documentId)
    .map((item) => ({
      sourceRef: item.sourceRef || "",
      heading: item.heading || "",
      childType: item.childType || "",
      contentHash: item.contentHash || sha256(item.content || item.searchText || ""),
      content: item.content || "",
      searchText: item.searchText || "",
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return jsonHash({
    sourcePath: normalizePath(document.sourcePath || document.title || document.id),
    title: document.title || "",
    sourceType: document.sourceType || "",
    size: document.size || 0,
    parents,
    chunks,
  });
}

function documentEntries(snapshot) {
  const entries = new Map();
  for (const document of snapshot?.documents || []) {
    const key = normalizePath(document.sourcePath || document.title || document.id);
    if (!key) continue;
    entries.set(key, {
      path: document.sourcePath || document.title || document.id,
      title: document.title || "",
      sourceType: document.sourceType || "",
      size: document.size || 0,
      hash: documentHash(snapshot, document),
    });
  }
  return entries;
}

export function diffKnowledgeBaseSnapshots(previousSnapshot, currentSnapshot) {
  const previousDocs = documentEntries(previousSnapshot);
  const currentDocs = documentEntries(currentSnapshot);
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  for (const [key, current] of currentDocs.entries()) {
    const previous = previousDocs.get(key);
    if (!previous) {
      added.push(current);
    } else if (previous.hash !== current.hash) {
      changed.push({ ...current, previousHash: previous.hash });
    } else {
      unchanged.push(current);
    }
  }
  for (const [key, previous] of previousDocs.entries()) {
    if (!currentDocs.has(key)) removed.push(previous);
  }
  const previousSummary = previousSnapshot ? snapshotSummary(previousSnapshot) : null;
  const currentSummary = currentSnapshot ? snapshotSummary(currentSnapshot) : null;
  return {
    added,
    removed,
    changed,
    unchangedCount: unchanged.length,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
    },
    totals: {
      previousDocuments: previousSummary?.documents || 0,
      currentDocuments: currentSummary?.documents || 0,
      previousParents: previousSummary?.chunkParents || 0,
      currentParents: currentSummary?.chunkParents || 0,
      previousChunks: previousSummary?.chunks || 0,
      currentChunks: currentSummary?.chunks || 0,
    },
  };
}

function normalizeVersion(version = {}) {
  return {
    id: String(version.id || makeId("kbv")),
    knowledgeBaseId: String(version.knowledgeBaseId || version.snapshot?.knowledgeBase?.id || ""),
    slot: version.slot === "previous" ? "previous" : "current",
    versionNo: Number(version.versionNo || 1),
    source: String(version.source || "import"),
    label: String(version.label || ""),
    createdAt: version.createdAt || nowIso(),
    parentVersionId: version.parentVersionId || "",
    restoredFromVersionId: version.restoredFromVersionId || "",
    jobId: version.jobId || "",
    summary: version.summary && typeof version.summary === "object" ? version.summary : {},
    diffFromPrevious: version.diffFromPrevious && typeof version.diffFromPrevious === "object" ? version.diffFromPrevious : null,
    snapshot: version.snapshot && typeof version.snapshot === "object" ? version.snapshot : null,
  };
}

function publicVersion(version, includeSnapshot = false) {
  if (!version) return null;
  const value = normalizeVersion(version);
  if (!includeSnapshot) delete value.snapshot;
  return value;
}

function sqliteVersionFields(version) {
  const value = normalizeVersion(version);
  return {
    id: value.id,
    knowledgeBaseId: value.knowledgeBaseId,
    documentId: "",
    taskId: value.jobId || "",
    employeeId: "",
    inviteId: "",
    token: "",
    parentId: value.parentVersionId || "",
    status: value.slot,
    type: value.source,
    key: String(value.versionNo),
    scope: "knowledge_base_versions",
    createdAt: value.createdAt || "",
    updatedAt: value.createdAt || "",
    rowOrder: value.slot === "previous" ? 0 : 1,
    json: JSON.stringify(value),
  };
}

function readSqliteVersions(knowledgeBaseId = "") {
  const db = openTrainingDatabase(dataDir);
  const rows = knowledgeBaseId
    ? db.prepare("SELECT json FROM knowledge_base_versions WHERE knowledgeBaseId = ? ORDER BY rowOrder ASC, createdAt ASC").all(knowledgeBaseId)
    : db.prepare("SELECT json FROM knowledge_base_versions ORDER BY knowledgeBaseId ASC, rowOrder ASC, createdAt ASC").all();
  return rows.map((row) => normalizeVersion(JSON.parse(row.json)));
}

function saveSqliteVersionsForKnowledgeBase(knowledgeBaseId, versions) {
  const db = openTrainingDatabase(dataDir);
  const insert = db.prepare(`
    INSERT INTO knowledge_base_versions (
      id, knowledgeBaseId, documentId, taskId, employeeId, inviteId, token, parentId,
      status, type, key, scope, createdAt, updatedAt, rowOrder, json
    ) VALUES (
      @id, @knowledgeBaseId, @documentId, @taskId, @employeeId, @inviteId, @token, @parentId,
      @status, @type, @key, @scope, @createdAt, @updatedAt, @rowOrder, @json
    )
  `);
  db.transaction(() => {
    db.prepare("DELETE FROM knowledge_base_versions WHERE knowledgeBaseId = ?").run(knowledgeBaseId);
    for (const version of versions.map(normalizeVersion).filter((item) => item.snapshot)) {
      insert.run(sqliteVersionFields(version));
    }
  })();
}

async function readJsonVersionStore() {
  try {
    const raw = await readFile(knowledgeBaseVersionsPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      meta: parsed.meta || { version: 1 },
      versions: Array.isArray(parsed.versions) ? parsed.versions.map(normalizeVersion) : [],
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { meta: { version: 1, createdAt: nowIso(), updatedAt: nowIso() }, versions: [] };
  }
}

async function writeJsonVersionStore(store) {
  await mkdir(path.dirname(knowledgeBaseVersionsPath), { recursive: true });
  const value = {
    meta: {
      ...(store.meta || {}),
      version: 1,
      updatedAt: nowIso(),
    },
    versions: Array.isArray(store.versions) ? store.versions.map(normalizeVersion) : [],
  };
  const tempPath = `${knowledgeBaseVersionsPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, knowledgeBaseVersionsPath);
}

async function withJsonVersionStore(mutator) {
  const run = async () => {
    const store = await readJsonVersionStore();
    const result = await mutator(store);
    await writeJsonVersionStore(store);
    return result;
  };
  jsonWriteLock = jsonWriteLock.then(run, run);
  return await jsonWriteLock;
}

async function saveVersionsForKnowledgeBase(knowledgeBaseId, versions) {
  const kbId = String(knowledgeBaseId || "");
  const kept = versions
    .map(normalizeVersion)
    .filter((version) => version.knowledgeBaseId === kbId && version.snapshot)
    .sort((left, right) => (left.slot === "previous" ? 0 : 1) - (right.slot === "previous" ? 0 : 1));
  if (isSqliteStorage()) {
    saveSqliteVersionsForKnowledgeBase(kbId, kept);
    return kept;
  }
  return await withJsonVersionStore((store) => {
    store.versions = store.versions.filter((version) => version.knowledgeBaseId !== kbId);
    store.versions.push(...kept);
    return kept;
  });
}

async function readVersionsForKnowledgeBase(knowledgeBaseId) {
  const kbId = String(knowledgeBaseId || "");
  if (isSqliteStorage()) return readSqliteVersions(kbId);
  const store = await readJsonVersionStore();
  return store.versions.filter((version) => version.knowledgeBaseId === kbId);
}

function slotVersions(versions) {
  const normalized = versions.map(normalizeVersion);
  const current = normalized
    .filter((version) => version.slot === "current")
    .sort((left, right) => right.versionNo - left.versionNo)[0] || null;
  const previous = normalized
    .filter((version) => version.slot === "previous")
    .sort((left, right) => right.versionNo - left.versionNo)[0] || null;
  return { current, previous };
}

function createVersionRecord({ knowledgeBaseId, slot, versionNo, source, label, snapshot, parentVersionId = "", restoredFromVersionId = "", jobId = "", previousSnapshot = null, stateForQuality = null }) {
  const summary = snapshotSummary(snapshot, stateForQuality);
  return normalizeVersion({
    id: makeId("kbv"),
    knowledgeBaseId,
    slot,
    versionNo,
    source,
    label,
    createdAt: nowIso(),
    parentVersionId,
    restoredFromVersionId,
    jobId,
    summary,
    diffFromPrevious: diffKnowledgeBaseSnapshots(previousSnapshot, snapshot),
    snapshot,
  });
}

function previousFromUnversionedSnapshot({ knowledgeBaseId, snapshot }) {
  return createVersionRecord({
    knowledgeBaseId,
    slot: "previous",
    versionNo: 1,
    source: "pre_version_snapshot",
    label: "Snapshot before version tracking",
    snapshot,
    previousSnapshot: null,
  });
}

export async function recordKnowledgeBaseImportVersion({ knowledgeBaseId, previousSnapshot = null, importSummary = {}, jobId = "" } = {}) {
  const kbId = String(knowledgeBaseId || importSummary.kbId || "");
  if (!kbId) throw new Error("Missing knowledgeBaseId for version snapshot.");
  const state = await loadState();
  const currentSnapshot = createKnowledgeBaseSnapshot(state, kbId);
  if (!currentSnapshot) throw new Error(`Knowledge base not found for version snapshot: ${kbId}`);
  const existing = slotVersions(await readVersionsForKnowledgeBase(kbId));
  let previousVersion = existing.current ? normalizeVersion({ ...existing.current, slot: "previous" }) : null;
  if (!previousVersion && previousSnapshot) {
    previousVersion = previousFromUnversionedSnapshot({ knowledgeBaseId: kbId, snapshot: previousSnapshot });
  }
  const versionNo = previousVersion ? Number(previousVersion.versionNo || 1) + 1 : 1;
  const current = createVersionRecord({
    knowledgeBaseId: kbId,
    slot: "current",
    versionNo,
    source: "import",
    label: importSummary.kbName || currentSnapshot.knowledgeBase?.name || "Imported knowledge base",
    snapshot: currentSnapshot,
    parentVersionId: previousVersion?.id || "",
    jobId,
    previousSnapshot: previousVersion?.snapshot || null,
    stateForQuality: state,
  });
  const saved = await saveVersionsForKnowledgeBase(kbId, [previousVersion, current].filter(Boolean));
  return summarizeKnowledgeBaseVersionSet(saved);
}

export async function listKnowledgeBaseVersions(knowledgeBaseId, options = {}) {
  const versions = slotVersions(await readVersionsForKnowledgeBase(knowledgeBaseId));
  return {
    knowledgeBaseId: String(knowledgeBaseId || ""),
    current: publicVersion(versions.current, options.includeSnapshots === true),
    previous: publicVersion(versions.previous, options.includeSnapshots === true),
  };
}

export async function getKnowledgeBaseVersion(knowledgeBaseId, versionId, options = {}) {
  const versions = await readVersionsForKnowledgeBase(knowledgeBaseId);
  const version = versions.find((item) => item.id === String(versionId || ""));
  return publicVersion(version || null, options.includeSnapshots === true);
}

export async function restoreKnowledgeBaseVersion({ knowledgeBaseId, versionId, jobId = "" } = {}) {
  const kbId = String(knowledgeBaseId || "");
  const targetId = String(versionId || "");
  if (!kbId || !targetId) throw new Error("Missing knowledgeBaseId or versionId for rollback.");
  const versions = slotVersions(await readVersionsForKnowledgeBase(kbId));
  const target = [versions.current, versions.previous].filter(Boolean).find((version) => version.id === targetId);
  if (!target?.snapshot) throw new Error("Knowledge base version not found.");
  const currentBefore = versions.current || null;
  const restoredAt = nowIso();
  await mutateState((state) => {
    const restoredKnowledgeBase = {
      ...clone(target.snapshot.knowledgeBase),
      version: restoredAt,
      updatedAt: restoredAt,
      status: "ready",
    };
    const kbIndex = state.knowledgeBases.findIndex((kb) => kb.id === kbId);
    if (kbIndex >= 0) state.knowledgeBases[kbIndex] = restoredKnowledgeBase;
    else state.knowledgeBases.push(restoredKnowledgeBase);
    state.documents = (state.documents || []).filter((item) => item.knowledgeBaseId !== kbId);
    state.chunkParents = (state.chunkParents || []).filter((item) => item.knowledgeBaseId !== kbId);
    state.chunks = (state.chunks || []).filter((item) => item.knowledgeBaseId !== kbId);
    state.documents.push(...clone(target.snapshot.documents || []));
    state.chunkParents.push(...clone(target.snapshot.chunkParents || []));
    state.chunks.push(...clone(target.snapshot.chunks || []));
  });
  const state = await loadState();
  const restoredSnapshot = createKnowledgeBaseSnapshot(state, kbId);
  const nextVersionNo = Math.max(Number(currentBefore?.versionNo || 0), Number(versions.previous?.versionNo || 0)) + 1;
  const previous = currentBefore ? normalizeVersion({ ...currentBefore, slot: "previous" }) : null;
  const current = createVersionRecord({
    knowledgeBaseId: kbId,
    slot: "current",
    versionNo: nextVersionNo,
    source: "rollback",
    label: `Rollback to version ${target.versionNo}`,
    snapshot: restoredSnapshot,
    parentVersionId: currentBefore?.id || "",
    restoredFromVersionId: target.id,
    jobId,
    previousSnapshot: currentBefore?.snapshot || null,
    stateForQuality: state,
  });
  const saved = await saveVersionsForKnowledgeBase(kbId, [previous, current].filter(Boolean));
  return {
    restoredFrom: publicVersion(target, false),
    ...summarizeKnowledgeBaseVersionSet(saved),
  };
}

export function summarizeKnowledgeBaseVersionSet(versions) {
  const slots = slotVersions(versions);
  return {
    current: publicVersion(slots.current, false),
    previous: publicVersion(slots.previous, false),
    diffSummary: slots.current?.diffFromPrevious || null,
  };
}

export function knowledgeBaseVersionsFileExists() {
  return existsSync(knowledgeBaseVersionsPath);
}
