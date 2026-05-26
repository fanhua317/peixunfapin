import { createHash } from "node:crypto";

const DEFAULT_MAX_CHARS = 900;
const DEFAULT_MIN_CHARS = 120;
const DEFAULT_OVERLAP_CHARS = 80;
const COMPANY_BOILERPLATE_RE = /(?:福建新银嘉泵业有限公司|FUJIAN\s+NEW\s+YINJIA\s+PUMP\s+CO\.?,?\s*LTD\.?|A\s+TRUSTED\s+BRAND|YOUR\s+RELIABLE\s+PARTNER|YINJIA)/gi;
const OCR_PLACEHOLDER_RE = /(未能从.*(?:PDF|文件).*抽取|OCR|扫描件|复制文本|未抽取到|无法抽取)/i;
const TRAINING_SIGNAL_RE = /(电机|三相|异步|定子|转子|绕组|铁芯|铸铝|导条|端环|铁损|断条|功率|电压|电流|转速|频率|效率|能效|机座|级数|型号|YE\d|IE\d|客户|销售|话术|售后|工艺|质量|品质|检测|参数|范围|标准|负载|附加损耗|专利|ZL\d+)/i;

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanChunkLine(value) {
  const raw = String(value || "").trim();
  const hadCompany = COMPANY_BOILERPLATE_RE.test(raw);
  COMPANY_BOILERPLATE_RE.lastIndex = 0;
  let line = raw
    .replace(COMPANY_BOILERPLATE_RE, " ")
    .replace(/[●○•▪▫□■◆◇►▶]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (hadCompany) {
    line = line.replace(/^\d{1,3}\s+(?=\d+(?:\.\d+)+\s*[\u3400-\u9fffA-Za-z])/, "");
    line = line.replace(/^\d{1,3}\s+(?=[\u3400-\u9fffA-Za-z]{3,})/, "");
  }
  if (/^(?:\d{1,3}|目录|contents|封面|YINJIA)$/i.test(line)) return "";
  return line;
}

function cleanChunkContent(value) {
  return normalizeText(value)
    .split("\n")
    .map(cleanChunkLine)
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function informativeText(value) {
  return cleanChunkContent(value)
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[#*_`>]/g, "")
    .replace(/来源文件[:：]\s*[^\s。；;\n]+/g, "")
    .replace(/页数[:：]\s*\d+/g, "")
    .replace(/页码[:：]\s*\d+/g, "")
    .replace(/第\s*\d+\s*页/g, "")
    .replace(/^[\s\d]+(?=\d+(?:\.\d+)+\s*[\u3400-\u9fffA-Za-z])/g, "")
    .replace(/^[\s\d]+(?=[\u3400-\u9fffA-Za-z]{3,})/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isOcrPlaceholderText(value) {
  return OCR_PLACEHOLDER_RE.test(String(value || ""));
}

function isLowValueStandalone(value) {
  if (isOcrPlaceholderText(value)) return false;
  const text = informativeText(value);
  if (!text) return true;
  if (/^(?:目录|contents|封面|结束|谢谢|感谢|期待下次再见)[！!。.\s]*$/i.test(text)) return true;
  if (!TRAINING_SIGNAL_RE.test(text) && text.length < 36 && !/[。！？；;,.，：:]/.test(text)) return true;
  return false;
}

function sha256Short(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 16);
}

function combineSourceRefs(left, right) {
  const refs = [...new Set([
    ...(left?.sourceRefs || [left?.sourceRef]),
    ...(right?.sourceRefs || [right?.sourceRef]),
  ].map((ref) => String(ref || "").trim()).filter(Boolean))];
  if (!refs.length) return "";
  if (refs.length === 1) return compactSourceRef(refs[0]);
  const first = compactSourceRef(refs[0]);
  const last = compactSourceRef(refs[refs.length - 1]);
  return refs.length === 2 ? `${first} → ${last}` : `${first} → ${last}（共 ${refs.length} 段）`;
}

function compactSourceRef(ref) {
  const value = String(ref || "").trim();
  if (value.length <= 90) return value;
  const [file, trail = ""] = value.split(" :: ");
  const page = trail.match(/第\s*\d+\s*页/)?.[0] || "";
  const heading = trail.split("/").map((part) => part.trim()).filter(Boolean).at(-1) || "";
  return `${file}${page ? ` / ${page}` : heading ? ` / ${heading}` : ""}`.slice(0, 90);
}

function combinePieces(left, right) {
  const sourceRefs = [...new Set([...(left.sourceRefs || [left.sourceRef]), ...(right.sourceRefs || [right.sourceRef])].filter(Boolean))];
  return {
    ...right,
    content: `${left.content}\n\n${right.content}`.trim(),
    sourceRef: combineSourceRefs(left, right),
    sourceRefs,
    sectionPath: right.sectionPath?.length ? right.sectionPath : left.sectionPath,
    heading: right.heading || left.heading || "",
    page: right.page || left.page || null,
  };
}

function mergeSmallPieces(pieces, { minChars, maxChars }) {
  const merged = [];
  let pending = null;
  const shouldMerge = (piece) => {
    if (!piece || isOcrPlaceholderText(piece.content)) return false;
    const text = informativeText(piece.content);
    return isLowValueStandalone(piece.content) || (text.length > 0 && text.length < minChars);
  };
  for (const piece of pieces) {
    if (shouldMerge(piece)) {
      pending = pending ? combinePieces(pending, piece) : piece;
      continue;
    }
    if (pending) {
      const combined = combinePieces(pending, piece);
      if (combined.content.length <= maxChars + minChars) {
        merged.push(combined);
        pending = null;
        continue;
      }
      if (!isLowValueStandalone(pending.content)) merged.push(pending);
      pending = null;
    }
    merged.push(piece);
  }
  if (pending) {
    const last = merged[merged.length - 1];
    if (last && `${last.content}\n\n${pending.content}`.length <= maxChars + minChars) {
      merged[merged.length - 1] = combinePieces(last, pending);
    } else if (!isLowValueStandalone(pending.content)) {
      merged.push(pending);
    }
  }
  return merged;
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
  const pieces = [];
  const makePiece = (section, content) => {
    const trimmed = cleanChunkContent(content);
    if (!trimmed) return;
    const sectionPath = section.sectionPath || [];
    const headingPath = sectionPath.length ? sectionPath.join(" / ") : "";
    const sourceRef = headingPath ? `${baseRef} :: ${headingPath}` : `${baseRef} #${pieces.length + 1}`;
    pieces.push({
      content: trimmed,
      sourceRef,
      sectionPath,
      heading: section.title || "",
      page: section.page || null,
      sourcePath,
    });
  };
  for (const section of sections) {
    if (!section.content) {
      continue;
    }
    if (section.content.length <= maxChars) {
      makePiece(section, section.content);
      continue;
    }
    const blocks = sectionToBlocks(section.content);
    const packed = packBlocks(blocks, { maxChars, minChars, overlapChars });
    if (!packed.length) {
      makePiece(section, section.content.slice(0, maxChars));
      continue;
    }
    for (const piece of packed) {
      makePiece(section, piece);
    }
  }
  return mergeSmallPieces(pieces, { minChars, maxChars }).map((piece, index) => ({
    ...piece,
    contentHash: sha256Short(`${sourcePath}|${piece.sourceRef}|${piece.content}`),
    tokenLength: piece.content.length,
    keywords: deriveKeywords(piece.content),
    order: index,
  }));
}

export function chunkPlainText(text, context = {}, options = {}) {
  const maxChars = Number(options.maxChars) || DEFAULT_MAX_CHARS;
  const minChars = Number(options.minChars) || DEFAULT_MIN_CHARS;
  const overlapChars = Number.isFinite(options.overlapChars) ? Number(options.overlapChars) : DEFAULT_OVERLAP_CHARS;
  const sourcePath = context.sourcePath || context.relativePath || context.title || "";
  const baseRef = sourcePath || context.title || "资料";
  const paragraphs = splitParagraphs(text);
  const blocks = paragraphs.length ? paragraphs : [normalizeText(text)];
  const packed = packBlocks(blocks, { maxChars, minChars, overlapChars })
    .map((content, index) => ({
      content: cleanChunkContent(content),
      sourceRef: `${baseRef} #${index + 1}`,
      sectionPath: [],
      heading: "",
      page: null,
      sourcePath,
    }))
    .filter((piece) => piece.content);
  return mergeSmallPieces(packed, { minChars, maxChars }).map((piece, index) => ({
    ...piece,
    sourceRef: `${baseRef} #${index + 1}`,
    contentHash: sha256Short(`${sourcePath}||${piece.content}`),
    tokenLength: piece.content.length,
    keywords: deriveKeywords(piece.content),
    order: index,
  }));
}

export { sha256Short as chunkHash };
