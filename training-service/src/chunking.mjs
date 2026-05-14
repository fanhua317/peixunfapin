import { createHash } from "node:crypto";

const DEFAULT_MAX_CHARS = 900;
const DEFAULT_MIN_CHARS = 120;
const DEFAULT_OVERLAP_CHARS = 80;

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sha256Short(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 16);
}

function clampLast(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function isHeading(line) {
  return /^#{1,6}\s+\S/.test(line);
}

function headingLevel(line) {
  const match = line.match(/^(#{1,6})\s+/);
  return match ? match[1].length : 0;
}

function headingTitle(line) {
  return line.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim();
}

function isTableLine(line) {
  return /^\|.*\|\s*$/.test(line) || /^\s*\|?[:\- ]+\|/.test(line);
}

function isFenceStart(line) {
  return /^\s*```/.test(line);
}

function pagePattern(line) {
  const match = line.match(/^##\s*第\s*(\d+)\s*页\s*$/);
  return match ? Number(match[1]) : null;
}

function splitParagraphs(text) {
  return normalizeText(text)
    .split(/\n\s*\n/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

function sectionToBlocks(text) {
  const lines = normalizeText(text).split("\n");
  const blocks = [];
  let current = [];
  let inFence = false;
  let inTable = false;
  const flush = () => {
    if (!current.length) return;
    const joined = current.join("\n").trim();
    if (joined) blocks.push(joined);
    current = [];
  };
  for (const rawLine of lines) {
    const line = rawLine;
    if (isFenceStart(line)) {
      if (!inFence) flush();
      current.push(line);
      inFence = !inFence;
      if (!inFence) flush();
      continue;
    }
    if (inFence) {
      current.push(line);
      continue;
    }
    if (isTableLine(line)) {
      if (!inTable) flush();
      inTable = true;
      current.push(line);
      continue;
    }
    if (inTable && !isTableLine(line)) {
      flush();
      inTable = false;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function packBlocks(blocks, options) {
  const { maxChars, minChars, overlapChars } = options;
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
    if (buffer) {
      flush();
    }
    if (block.length <= maxChars) {
      buffer = carry ? `${carry}\n\n${block}` : block;
      continue;
    }
    const paragraphs = splitParagraphs(block);
    if (paragraphs.length > 1) {
      for (const paragraph of paragraphs) {
        const subCandidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
        if (subCandidate.length <= maxChars) {
          buffer = subCandidate;
        } else {
          if (buffer) flush();
          buffer = paragraph;
          if (buffer.length > maxChars) {
            for (let index = 0; index < buffer.length; index += maxChars) {
              chunks.push(buffer.slice(index, index + maxChars));
            }
            buffer = "";
            carry = "";
          }
        }
      }
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

function parseSections(text) {
  const lines = normalizeText(text).split("\n");
  const stack = [];
  const sections = [];
  let current = null;
  let currentPage = null;
  const startSection = (line) => {
    const level = headingLevel(line);
    const title = headingTitle(line);
    while (stack.length && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    const sectionPath = [...stack.map((entry) => entry.title), title];
    const node = {
      level,
      title,
      sectionPath,
      page: currentPage,
      lines: [],
    };
    stack.push(node);
    sections.push(node);
    current = node;
  };
  for (const line of lines) {
    if (isHeading(line)) {
      const page = pagePattern(line);
      if (page) {
        currentPage = page;
      }
      startSection(line);
      continue;
    }
    if (!current) {
      current = { level: 0, title: "", sectionPath: [], page: currentPage, lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
  }
  for (const section of sections) {
    section.content = normalizeText(section.lines.join("\n"));
    delete section.lines;
  }
  return sections.filter((section) => section.content || section.title);
}

function deriveKeywords(text) {
  const cjk = String(text || "").match(/[\u3400-\u9fff]{2,}/g) || [];
  const latin = String(text || "").match(/[A-Za-z]{3,}\b/g) || [];
  const counts = new Map();
  for (const term of [...cjk, ...latin]) {
    const key = term.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([term]) => term);
}

export function chunkMarkdown(text, context = {}, options = {}) {
  const maxChars = Number(options.maxChars) || DEFAULT_MAX_CHARS;
  const minChars = Number(options.minChars) || DEFAULT_MIN_CHARS;
  const overlapChars = Number.isFinite(options.overlapChars) ? Number(options.overlapChars) : DEFAULT_OVERLAP_CHARS;
  const sourcePath = context.sourcePath || context.relativePath || context.title || "";
  const baseRef = sourcePath || context.title || "资料";
  const sections = parseSections(text);
  const chunks = [];
  let chunkIndex = 0;
  const pushChunk = (section, content) => {
    const trimmed = String(content || "").trim();
    if (!trimmed) return;
    const sectionPath = section.sectionPath || [];
    const headingPath = sectionPath.length ? sectionPath.join(" / ") : "";
    const sourceRef = headingPath ? `${baseRef} :: ${headingPath}` : `${baseRef} #${chunkIndex + 1}`;
    const contentHash = sha256Short(`${sourcePath}|${headingPath}|${trimmed}`);
    chunks.push({
      content: trimmed,
      sourceRef,
      sectionPath,
      heading: section.title || "",
      page: section.page || null,
      sourcePath,
      contentHash,
      tokenLength: trimmed.length,
      keywords: deriveKeywords(trimmed),
      order: chunkIndex,
    });
    chunkIndex += 1;
  };
  for (const section of sections) {
    if (!section.content) {
      continue;
    }
    if (section.content.length <= maxChars) {
      pushChunk(section, section.content);
      continue;
    }
    const blocks = sectionToBlocks(section.content);
    const packed = packBlocks(blocks, { maxChars, minChars, overlapChars });
    if (!packed.length) {
      pushChunk(section, section.content.slice(0, maxChars));
      continue;
    }
    for (const piece of packed) {
      pushChunk(section, piece);
    }
  }
  return chunks;
}

export function chunkPlainText(text, context = {}, options = {}) {
  const maxChars = Number(options.maxChars) || DEFAULT_MAX_CHARS;
  const minChars = Number(options.minChars) || DEFAULT_MIN_CHARS;
  const overlapChars = Number.isFinite(options.overlapChars) ? Number(options.overlapChars) : DEFAULT_OVERLAP_CHARS;
  const sourcePath = context.sourcePath || context.relativePath || context.title || "";
  const baseRef = sourcePath || context.title || "资料";
  const paragraphs = splitParagraphs(text);
  const blocks = paragraphs.length ? paragraphs : [normalizeText(text)];
  const packed = packBlocks(blocks, { maxChars, minChars, overlapChars });
  return packed.map((content, index) => ({
    content,
    sourceRef: `${baseRef} #${index + 1}`,
    sectionPath: [],
    heading: "",
    page: null,
    sourcePath,
    contentHash: sha256Short(`${sourcePath}||${content}`),
    tokenLength: content.length,
    keywords: deriveKeywords(content),
    order: index,
  }));
}

export { sha256Short as chunkHash };
