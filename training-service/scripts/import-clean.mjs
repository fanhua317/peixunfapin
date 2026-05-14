import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { mutateState, makeId, isoNow } from "../src/store.mjs";
import { chunkMarkdown, chunkPlainText } from "../src/chunking.mjs";

const inputDir = path.resolve(process.argv[2] || process.env.TRAINING_CLEAN_DIR || "D:\\OpenClawData\\training-clean");
const kbName = process.argv[3] || process.env.TRAINING_KB_NAME || path.basename(inputDir) || "自定义培训资料库";
const extraAliases = (process.argv[4] || process.env.TRAINING_KB_ALIASES || "")
  .split(/[，,]/)
  .map((value) => value.trim())
  .filter(Boolean);

function slug(value) {
  return String(value || "kb")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "") || "kb";
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(full));
    } else if (/\.(md|txt)$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const files = await walk(inputDir);
if (!files.length) {
  console.log(`No .md/.txt files found in ${inputDir}`);
  process.exit(0);
}

const kbId = `kb-${slug(kbName)}`;
const imported = await mutateState(async (state) => {
  const existing = state.knowledgeBases.find((kb) => kb.id === kbId);
  const aliases = [...new Set([kbName, path.basename(inputDir), ...extraAliases].filter(Boolean))];
  if (existing) {
    existing.name = kbName;
    existing.aliases = aliases;
    existing.status = "ready";
    existing.updatedAt = isoNow();
  } else {
    state.knowledgeBases.push({
      id: kbId,
      name: kbName,
      aliases,
      description: `Imported from ${inputDir}`,
      version: isoNow(),
      status: "ready",
      createdAt: isoNow(),
      updatedAt: isoNow(),
    });
  }

  state.documents = state.documents.filter((doc) => doc.knowledgeBaseId !== kbId);
  state.chunks = state.chunks.filter((chunk) => chunk.knowledgeBaseId !== kbId);

  let chunkCount = 0;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const relative = path.relative(inputDir, file);
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
    const chunker = ext === "md" ? chunkMarkdown : chunkPlainText;
    const chunks = chunker(content, { sourcePath: relative, title: path.basename(file) });
    if (!chunks.length) {
      chunks.push({
        content: content.slice(0, 900),
        sourceRef: relative,
        sectionPath: [],
        heading: "",
        page: null,
        sourcePath: relative,
        contentHash: "fallback-empty",
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
        content: chunk.content,
        sourceRef: chunk.sourceRef,
        contentHash: chunk.contentHash,
        sectionPath: chunk.sectionPath,
        heading: chunk.heading,
        page: chunk.page,
        sourcePath: chunk.sourcePath,
        keywords: chunk.keywords,
        tokenLength: chunk.tokenLength,
        metadata: {
          importedFrom: inputDir,
          index,
          sectionPath: chunk.sectionPath,
          page: chunk.page,
        },
      });
      chunkCount += 1;
    });
  }

  return { kbId, kbName, fileCount: files.length, chunkCount };
});

console.log(JSON.stringify(imported, null, 2));
