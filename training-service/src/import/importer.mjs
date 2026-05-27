import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { chunkSemanticDocument } from "../semantic-chunking.mjs";
import { isoNow, makeId, mutateState } from "../store.mjs";

export function slugKnowledgeBase(value) {
  return String(value || "kb")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "") || "kb";
}

async function walkCleanFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkCleanFiles(full));
    } else if (/\.(md|txt)$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function parseAliases(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function importCleanDirectory({ inputDir, kbName, aliases = [] }) {
  const cleanDir = path.resolve(inputDir);
  const name = String(kbName || path.basename(cleanDir) || "自定义培训资料库").trim();
  const extraAliases = parseAliases(aliases);
  const files = await walkCleanFiles(cleanDir);
  if (!files.length) {
    throw new Error(`No .md/.txt files found in ${cleanDir}`);
  }

  const kbId = `kb-${slugKnowledgeBase(name)}`;
  return await mutateState(async (state) => {
    state.chunkParents = Array.isArray(state.chunkParents) ? state.chunkParents : [];
    const existing = state.knowledgeBases.find((kb) => kb.id === kbId);
    const now = isoNow();
    const nextAliases = [...new Set([name, path.basename(cleanDir), ...extraAliases].filter(Boolean))];
    if (existing) {
      existing.name = name;
      existing.aliases = nextAliases;
      existing.description = `Imported from ${cleanDir}`;
      existing.status = "ready";
      existing.version = now;
      existing.updatedAt = now;
    } else {
      state.knowledgeBases.push({
        id: kbId,
        name,
        aliases: nextAliases,
        description: `Imported from ${cleanDir}`,
        version: now,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      });
    }

    state.documents = state.documents.filter((doc) => doc.knowledgeBaseId !== kbId);
    state.chunks = state.chunks.filter((chunk) => chunk.knowledgeBaseId !== kbId);
    state.chunkParents = state.chunkParents.filter((parent) => parent.knowledgeBaseId !== kbId);

    let chunkCount = 0;
    let parentCount = 0;
    let tableRowParentCount = 0;
    let maxChildChars = 0;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const relative = path.relative(cleanDir, file);
      const ext = path.extname(file).slice(1).toLowerCase();
      const docId = makeId("doc");
      const info = await stat(file);
      state.documents.push({
        id: docId,
        knowledgeBaseId: kbId,
        title: path.basename(file),
        sourcePath: relative,
        sourceType: ext,
        status: "ready",
        size: info.size,
      });
      const semantic = chunkSemanticDocument(content, { sourcePath: relative, title: path.basename(file), ext });
      const parentIdByKey = new Map();
      for (const parent of semantic.parents) {
        const parentId = makeId("parent");
        parentIdByKey.set(parent.localKey, parentId);
        state.chunkParents.push({
          id: parentId,
          knowledgeBaseId: kbId,
          documentId: docId,
          content: parent.content,
          sourceRef: parent.sourceRef,
          contentHash: parent.contentHash,
          sectionPath: parent.sectionPath,
          heading: parent.heading,
          page: parent.page || null,
          sourcePath: parent.sourcePath,
          parentType: parent.parentType,
          businessKeys: parent.businessKeys || {},
          tokenLength: parent.tokenLength,
          metadata: {
            importedFrom: cleanDir,
            order: parent.order,
          },
        });
        parentCount += 1;
        if (parent.parentType === "table_row") tableRowParentCount += 1;
      }
      const chunks = semantic.chunks;
      if (!chunks.length) {
        chunks.push({
          content: content.slice(0, 900),
          searchText: content.slice(0, 900),
          sourceRef: relative,
          sectionPath: [],
          heading: "",
          page: null,
          sourcePath: relative,
          parentKey: "",
          parentId: null,
          childType: "empty_fallback",
          businessKeys: {},
          contentHash: "empty-content",
          tokenLength: Math.min(content.length, 900),
          keywords: [],
          order: 0,
        });
      }
      chunks.forEach((chunk, index) => {
        state.chunks.push({
          id: makeId("chunk"),
          knowledgeBaseId: kbId,
          documentId: docId,
          parentId: chunk.parentKey ? parentIdByKey.get(chunk.parentKey) || null : chunk.parentId || null,
          content: chunk.content,
          searchText: chunk.searchText || chunk.content,
          sourceRef: chunk.sourceRef,
          contentHash: chunk.contentHash,
          sectionPath: chunk.sectionPath,
          heading: chunk.heading,
          page: chunk.page,
          sourcePath: chunk.sourcePath,
          childType: chunk.childType || "snippet",
          businessKeys: chunk.businessKeys || {},
          keywords: chunk.keywords,
          tokenLength: chunk.tokenLength,
          metadata: {
            importedFrom: cleanDir,
            index,
            sectionPath: chunk.sectionPath,
            page: chunk.page,
            parentKey: chunk.parentKey || "",
          },
        });
        maxChildChars = Math.max(maxChildChars, String(chunk.content || "").length);
        chunkCount += 1;
      });
    }

    return {
      kbId,
      kbName: name,
      inputDir: cleanDir,
      fileCount: files.length,
      parentCount,
      chunkCount,
      tableRowParentCount,
      maxChildChars,
    };
  });
}
