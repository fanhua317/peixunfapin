import { chunkHash, chunkMarkdown, chunkPlainText } from "./chunking.mjs";

const DEFAULT_CHILD_MAX_CHARS = 720;
const DEFAULT_CHILD_MIN_CHARS = 80;
const DEFAULT_PARENT_MAX_CHARS = 2600;
const DEFAULT_OVERLAP_CHARS = 60;

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function headingLevel(line) {
  const match = String(line || "").match(/^(#{1,6})\s+/);
  return match ? match[1].length : 0;
}

function headingTitle(line) {
  return String(line || "").replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim();
}

function isHeading(line) {
  return headingLevel(line) > 0;
}

function splitBlocks(text) {
  const lines = normalizeText(text).split("\n");
  const blocks = [];
  let current = [];
  let inTable = false;
  const flush = () => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };
  for (const line of lines) {
    const tableLine = /^\s*\|.*\|\s*$/.test(line) || /^\s*\|?[:\- ]+\|/.test(line);
    if (!line.trim()) {
      flush();
      inTable = false;
      continue;
    }
    if (tableLine) {
      if (!inTable) flush();
      inTable = true;
      current.push(line);
      continue;
    }
    if (inTable) {
      flush();
      inTable = false;
    }
    current.push(line);
  }
  flush();
  return blocks.length ? blocks : [normalizeText(text)].filter(Boolean);
}

function clampLast(text, maxChars) {
  const value = String(text || "");
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function packBlocks(blocks, { maxChars = DEFAULT_CHILD_MAX_CHARS, minChars = DEFAULT_CHILD_MIN_CHARS, overlapChars = DEFAULT_OVERLAP_CHARS } = {}) {
  const chunks = [];
  let buffer = "";
  let carry = "";
  const flush = () => {
    const candidate = buffer.trim();
    if (!candidate) return;
    if (chunks.length && candidate.length < minChars) {
      const last = chunks.pop();
      chunks.push(`${last}\n\n${candidate}`.trim());
    } else {
      chunks.push(candidate);
    }
    carry = overlapChars > 0 ? clampLast(candidate, overlapChars) : "";
    buffer = "";
  };
  for (const block of blocks) {
    const prefix = carry && !buffer ? `${carry}\n\n` : "";
    const candidate = buffer ? `${buffer}\n\n${block}` : `${prefix}${block}`;
    if (candidate.length <= maxChars) {
      buffer = candidate;
      continue;
    }
    if (buffer) flush();
    if (block.length <= maxChars) {
      buffer = carry ? `${carry}\n\n${block}` : block;
      continue;
    }
    for (let index = 0; index < block.length; index += maxChars) {
      chunks.push(block.slice(index, index + maxChars));
    }
    carry = "";
  }
  flush();
  return chunks;
}

function parseMarkdownSections(text) {
  const lines = normalizeText(text).split("\n");
  const stack = [];
  const sections = [];
  let current = null;
  const start = (line) => {
    const level = headingLevel(line);
    const title = headingTitle(line);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const sectionPath = [...stack.map((item) => item.title), title];
    const section = { level, title, sectionPath, lines: [] };
    stack.push({ level, title });
    sections.push(section);
    current = section;
  };
  for (const line of lines) {
    if (isHeading(line)) {
      start(line);
      continue;
    }
    if (!current) {
      current = { level: 0, title: "", sectionPath: [], lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
  }
  return sections
    .map((section) => ({ ...section, content: normalizeText(section.lines.join("\n")) }))
    .filter((section) => section.title || section.content);
}

function sourceRefFor(baseRef, sectionPath, fallbackIndex) {
  const path = (sectionPath || []).map((part) => compactSpaces(part)).filter(Boolean).join(" / ");
  return path ? `${baseRef} :: ${path}` : `${baseRef} #${fallbackIndex + 1}`;
}

function extractLineValue(text, labelPattern) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${labelPattern}\\s*[:：]\\s*([^\\n]+)`, "i");
  return compactSpaces(String(text || "").match(re)?.[1] || "");
}

function extractBusinessKeys({ title, sectionPath, content, sourcePath }) {
  const all = `${title || ""}\n${(sectionPath || []).join("\n")}\n${content || ""}`;
  const model = extractLineValue(all, "(?:列\\s*2|型号|系列|model|motor\\s*model)");
  const casing = extractLineValue(all, "(?:机壳|shell|casing)");
  const efficiency = extractLineValue(all, "(?:能效|efficiency|eff\\.?|standard\\s*eff)") || (all.match(/\bIE\s*\d\b/i)?.[0] || "");
  const poles = extractLineValue(all, "(?:级数|poles?|pole)");
  const frameRange = extractLineValue(all, "(?:机座范围|frame\\s*range|frame)");
  const powerRange = extractLineValue(all, "(?:功率范围|output\\s*power|power\\s*range)");
  const rowNumber = compactSpaces(String(title || "").match(/(?:第\s*)?(\d+)\s*(?:条|row)?/i)?.[1] || "");
  return {
    model,
    casing,
    efficiency: compactSpaces(efficiency),
    poles,
    frameRange,
    powerRange,
    rowNumber,
    sectionPath: (sectionPath || []).filter(Boolean),
    sourcePath: sourcePath || "",
  };
}

function nonEmptyObject(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => {
    if (Array.isArray(item)) return item.length > 0;
    return String(item || "").trim().length > 0;
  }));
}

function businessKeyText(keys) {
  const entries = Object.entries(keys || {})
    .filter(([, value]) => !Array.isArray(value) && String(value || "").trim())
    .map(([key, value]) => `${key}: ${value}`);
  return entries.join("\n");
}

function tableFieldCount(content) {
  return String(content || "")
    .split("\n")
    .filter((line) => /^\s*[-*]\s*[^:\n：]{1,48}\s*[:：]\s*\S/.test(line))
    .length;
}

function detectParentType(section, keys) {
  const path = `${section.title || ""} ${(section.sectionPath || []).join(" ")}`;
  if (/(sheet|row|工作表|第\s*\d+\s*条)/i.test(path) && tableFieldCount(section.content) >= 3) return "table_row";
  if ((keys.model || keys.efficiency || keys.poles) && tableFieldCount(section.content) >= 3) return "model_spec";
  if (/faq|问答|问题|故障|售后/i.test(path)) return "qa_case";
  return "knowledge_point";
}

function buildSearchText({ sourceRef, heading, businessKeys, content }) {
  return [
    sourceRef,
    heading,
    businessKeyText(businessKeys),
    content,
  ].map((part) => String(part || "").trim()).filter(Boolean).join("\n\n");
}

function makeParent({ localKey, sourcePath, sourceRef, sectionPath, heading, content, parentType, businessKeys, order }) {
  const cleaned = normalizeText(content);
  return {
    localKey,
    sourcePath,
    sourceRef,
    sectionPath,
    heading,
    content: cleaned,
    parentType,
    businessKeys: nonEmptyObject(businessKeys),
    contentHash: chunkHash(`${sourcePath}|${sourceRef}|parent|${cleaned}`),
    tokenLength: cleaned.length,
    order,
  };
}

function makeChild({ parent, content, childType, childIndex }) {
  const cleaned = normalizeText(content);
  const searchText = buildSearchText({
    sourceRef: parent.sourceRef,
    heading: parent.heading,
    businessKeys: parent.businessKeys,
    content: cleaned,
  });
  return {
    parentKey: parent.localKey,
    childType,
    content: cleaned,
    searchText,
    sourceRef: parent.sourceRef,
    sectionPath: parent.sectionPath,
    heading: parent.heading,
    page: null,
    sourcePath: parent.sourcePath,
    businessKeys: parent.businessKeys,
    contentHash: chunkHash(`${parent.sourcePath}|${parent.sourceRef}|child|${childIndex}|${searchText}`),
    tokenLength: cleaned.length,
    keywords: deriveKeywords(searchText),
    order: childIndex,
  };
}

function deriveKeywords(text) {
  const cjk = String(text || "").match(/[\u3400-\u9fff]{2,}/g) || [];
  const latin = String(text || "").match(/[A-Za-z0-9][A-Za-z0-9()/-]{1,}\b/g) || [];
  const counts = new Map();
  for (const term of [...cjk, ...latin]) {
    const key = term.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([term]) => term);
}

function splitParentContent(parent, options) {
  if (parent.parentType === "table_row" || parent.parentType === "model_spec") {
    return [makeChild({ parent, content: parent.content, childType: parent.parentType, childIndex: 0 })];
  }
  const blocks = splitBlocks(parent.content);
  return packBlocks(blocks, options).map((content, index) => makeChild({
    parent,
    content,
    childType: "knowledge_snippet",
    childIndex: index,
  }));
}

function fallbackSemanticChunks(text, context, ext) {
  const chunker = ext === "md" ? chunkMarkdown : chunkPlainText;
  const chunks = chunker(text, context);
  const parents = [];
  const children = [];
  chunks.forEach((chunk, index) => {
    const parent = makeParent({
      localKey: `fallback:${index}`,
      sourcePath: chunk.sourcePath || context.sourcePath || "",
      sourceRef: chunk.sourceRef || context.sourcePath || context.title || `document #${index + 1}`,
      sectionPath: chunk.sectionPath || [],
      heading: chunk.heading || "",
      content: chunk.content,
      parentType: "fallback_chunk",
      businessKeys: extractBusinessKeys({
        title: chunk.heading || "",
        sectionPath: chunk.sectionPath || [],
        content: chunk.content,
        sourcePath: chunk.sourcePath || context.sourcePath || "",
      }),
      order: index,
    });
    parents.push(parent);
    children.push(makeChild({ parent, content: chunk.content, childType: "fallback_snippet", childIndex: 0 }));
  });
  return { parents, chunks: children };
}

function splitOversizedParent(parent, options) {
  if (parent.content.length <= (options.parentMaxChars || DEFAULT_PARENT_MAX_CHARS)) return [parent];
  return packBlocks(splitBlocks(parent.content), {
    maxChars: options.parentMaxChars || DEFAULT_PARENT_MAX_CHARS,
    minChars: DEFAULT_CHILD_MIN_CHARS,
    overlapChars: 0,
  }).map((content, index) => ({
    ...parent,
    localKey: `${parent.localKey}:part:${index}`,
    sourceRef: `${parent.sourceRef} / part ${index + 1}`,
    content,
    contentHash: chunkHash(`${parent.sourcePath}|${parent.sourceRef}|parent-part|${index}|${content}`),
    tokenLength: content.length,
    order: parent.order + index / 100,
  }));
}

export function chunkSemanticDocument(text, context = {}, options = {}) {
  const sourcePath = context.sourcePath || context.relativePath || context.title || "";
  const ext = String(context.ext || context.sourceType || "").toLowerCase();
  const baseRef = sourcePath || context.title || "document";
  const normalized = normalizeText(text);
  if (!normalized) return { parents: [], chunks: [], stats: { parentCount: 0, childCount: 0 } };
  if (ext !== "md" && ext !== "markdown" && !/^#\s+/m.test(normalized)) {
    const fallback = fallbackSemanticChunks(normalized, { ...context, sourcePath }, ext);
    return { ...fallback, stats: summarizeSemanticResult(fallback) };
  }

  const sections = parseMarkdownSections(normalized)
    .filter((section) => section.content && compactSpaces(section.content).length > 0);
  if (!sections.length) {
    const fallback = fallbackSemanticChunks(normalized, { ...context, sourcePath }, ext || "txt");
    return { ...fallback, stats: summarizeSemanticResult(fallback) };
  }

  const parents = [];
  for (const section of sections) {
    const businessKeys = extractBusinessKeys({
      title: section.title,
      sectionPath: section.sectionPath,
      content: section.content,
      sourcePath,
    });
    const parentType = detectParentType(section, businessKeys);
    const sourceRef = sourceRefFor(baseRef, section.sectionPath, parents.length);
    const baseParent = makeParent({
      localKey: `section:${parents.length}:${chunkHash(`${sourcePath}|${sourceRef}`)}`,
      sourcePath,
      sourceRef,
      sectionPath: section.sectionPath || [],
      heading: section.title || "",
      content: section.content,
      parentType,
      businessKeys,
      order: parents.length,
    });
    parents.push(...splitOversizedParent(baseParent, options));
  }

  const chunks = [];
  for (const parent of parents) {
    chunks.push(...splitParentContent(parent, {
      maxChars: Number(options.childMaxChars) || DEFAULT_CHILD_MAX_CHARS,
      minChars: Number(options.childMinChars) || DEFAULT_CHILD_MIN_CHARS,
      overlapChars: Number.isFinite(options.overlapChars) ? options.overlapChars : DEFAULT_OVERLAP_CHARS,
    }));
  }

  return {
    parents,
    chunks,
    stats: summarizeSemanticResult({ parents, chunks }),
  };
}

function summarizeSemanticResult({ parents, chunks }) {
  const lengths = chunks.map((chunk) => chunk.content.length);
  return {
    parentCount: parents.length,
    childCount: chunks.length,
    tableRowParents: parents.filter((parent) => parent.parentType === "table_row").length,
    maxChildChars: lengths.length ? Math.max(...lengths) : 0,
  };
}
