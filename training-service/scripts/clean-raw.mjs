import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const serviceRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(serviceRoot, "..", "..");
const defaultRawDir = "D:\\OpenClawData\\training-raw";
const defaultCleanDir = "D:\\OpenClawData\\training-clean";
const rawDir = path.resolve(process.argv[2] || process.env.TRAINING_RAW_DIR || defaultRawDir);
const cleanDir = path.resolve(process.argv[3] || process.env.TRAINING_CLEAN_DIR || defaultCleanDir);
const pdfJsRoot = path.resolve(
  process.env.PDFJS_DIST_DIR || path.join(workspaceRoot, "openclaw", "node_modules", "pdfjs-dist"),
);

let pdfJsModulePromise;

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeMarkdown(value) {
  return String(value || "").replace(/\|/g, "\\|").trim();
}

function titleFromFile(file) {
  return path.basename(file, path.extname(file)).trim() || "未命名资料";
}

function outputPathFor(file, suffix = ".md") {
  const relative = path.relative(rawDir, file);
  const parsed = path.parse(relative);
  return path.join(cleanDir, parsed.dir, `${parsed.name}${suffix}`);
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function loadPdfJsModule() {
  if (!pdfJsModulePromise) {
    const modulePath = path.join(pdfJsRoot, "legacy", "build", "pdf.mjs");
    pdfJsModulePromise = import(pathToFileURL(modulePath).href);
  }
  return await pdfJsModulePromise;
}

function standardFontDataUrl() {
  return `${path.join(pdfJsRoot, "standard_fonts")}/`;
}

function textItemsToLines(items) {
  const parts = [];
  for (const item of items) {
    if (!item || typeof item.str !== "string") continue;
    const text = item.str.trim();
    if (text) parts.push(text);
    if (item.hasEOL) parts.push("\n");
    else if (text) parts.push(" ");
  }
  return normalizeText(parts.join(""));
}

async function cleanPdf(file) {
  const pdfJs = await loadPdfJsModule();
  const buffer = await readFile(file);
  const pdf = await pdfJs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    standardFontDataUrl: standardFontDataUrl(),
  }).promise;
  const relative = path.relative(rawDir, file);
  const parts = [`# ${titleFromFile(file)}`, "", `来源文件：${relative}`, "", `页数：${pdf.numPages}`, ""];
  let textChars = 0;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textItemsToLines(textContent.items || []);
    if (!pageText) continue;
    parts.push(`## 第 ${pageNumber} 页`, "", pageText, "");
    textChars += pageText.length;
  }
  if (!textChars) {
    parts.push("未能从该 PDF 中抽取到可复制文本；如果这是扫描件，需要 OCR 后再导入。", "");
  }
  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function findEocd(buffer) {
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  throw new Error("invalid xlsx zip: end of central directory not found");
}

function readZipEntries(buffer) {
  const eocd = findEocd(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("invalid xlsx zip: central directory entry not found");
    }
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`invalid xlsx zip: local header not found for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    if (compression === 0) {
      data = compressed;
    } else if (compression === 8) {
      data = inflateRawSync(compressed);
    } else {
      throw new Error(`unsupported xlsx zip compression ${compression} for ${name}`);
    }
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readXml(entries, name) {
  const data = entries.get(name);
  return data ? data.toString("utf8") : "";
}

function parseAttrs(value) {
  const attrs = {};
  const attrRe = /([\w:.-]+)="([^"]*)"/g;
  for (const match of value.matchAll(attrRe)) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const text = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((entry) => decodeXml(entry[1]))
      .join("");
    strings.push(normalizeText(text));
  }
  return strings;
}

function normalizeZipPath(base, target) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(base), target)).replace(/^\//, "");
}

function parseWorkbookSheets(entries) {
  const workbookXml = readXml(entries, "xl/workbook.xml");
  const relsXml = readXml(entries, "xl/_rels/workbook.xml.rels");
  const rels = new Map();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attrs = parseAttrs(match[1]);
    if (attrs.Id && attrs.Target) {
      rels.set(attrs.Id, normalizeZipPath("xl/workbook.xml", attrs.Target));
    }
  }
  const sheets = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = parseAttrs(match[1]);
    const relId = attrs["r:id"];
    const file = relId ? rels.get(relId) : undefined;
    if (file) sheets.push({ name: attrs.name || file, file });
  }
  if (sheets.length) return sheets;
  return [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN", { numeric: true }))
    .map((file, index) => ({ name: `Sheet${index + 1}`, file }));
}

function columnIndex(ref) {
  const letters = String(ref || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "";
  let value = 0;
  for (const letter of letters) {
    value = value * 26 + letter.charCodeAt(0) - 64;
  }
  return Math.max(0, value - 1);
}

function cellValue(cellXml, attrs, sharedStrings) {
  if (attrs.t === "inlineStr") {
    return normalizeText([...cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1])).join(""));
  }
  const raw = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
  if (raw === undefined) return "";
  const value = decodeXml(raw);
  if (attrs.t === "s") return sharedStrings[Number(value)] || "";
  if (attrs.t === "b") return value === "1" ? "TRUE" : "FALSE";
  return normalizeText(value);
}

function trimRow(row) {
  let last = row.length - 1;
  while (last >= 0 && !row[last]) last -= 1;
  return row.slice(0, last + 1);
}

function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowXml = rowMatch[1];
    const row = [];
    for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = parseAttrs(cellMatch[1]);
      const index = columnIndex(attrs.r || "");
      row[index] = cellValue(cellMatch[2], attrs, sharedStrings);
    }
    const trimmed = trimRow(row.map((value) => value || ""));
    if (trimmed.some(Boolean)) rows.push(trimmed);
  }
  return rows;
}

function uniqueHeaders(row) {
  const seen = new Map();
  return row.map((value, index) => {
    const base = normalizeText(value) || `列 ${index + 1}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count ? `${base} ${count + 1}` : base;
  });
}

function rowsToMarkdown(sheetName, rows) {
  if (!rows.length) return `## 工作表：${sheetName}\n\n无可用数据。\n`;
  const header = uniqueHeaders(rows[0]);
  const body = rows.slice(1);
  const parts = [`## 工作表：${sheetName}`, ""];
  if (!body.length) {
    parts.push(rows[0].map((value, index) => `- 列 ${index + 1}: ${safeMarkdown(value)}`).join("\n"), "");
    return parts.join("\n");
  }
  body.forEach((row, rowIndex) => {
    const values = row.map((value) => normalizeText(value));
    if (!values.some(Boolean)) return;
    parts.push(`### ${sheetName} - 第 ${rowIndex + 1} 条`, "");
    const max = Math.max(header.length, values.length);
    for (let index = 0; index < max; index += 1) {
      const value = values[index];
      if (!value) continue;
      parts.push(`- ${safeMarkdown(header[index] || `列 ${index + 1}`)}: ${safeMarkdown(value)}`);
    }
    parts.push("");
  });
  return parts.join("\n");
}

async function cleanXlsx(file) {
  const buffer = await readFile(file);
  const entries = readZipEntries(buffer);
  const sharedStrings = parseSharedStrings(readXml(entries, "xl/sharedStrings.xml"));
  const sheets = parseWorkbookSheets(entries);
  const relative = path.relative(rawDir, file);
  const parts = [`# ${titleFromFile(file)}`, "", `来源文件：${relative}`, ""];
  for (const sheet of sheets) {
    const xml = readXml(entries, sheet.file);
    if (!xml) continue;
    const rows = parseWorksheet(xml, sharedStrings);
    parts.push(rowsToMarkdown(sheet.name, rows));
  }
  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  row.push(value);
  rows.push(row);
  return rows.map((entry) => entry.map(normalizeText)).filter((entry) => entry.some(Boolean));
}

async function cleanCsv(file) {
  const text = await readFile(file, "utf8");
  const rows = parseCsv(text);
  const relative = path.relative(rawDir, file);
  return `# ${titleFromFile(file)}\n\n来源文件：${relative}\n\n${rowsToMarkdown(titleFromFile(file), rows)}`;
}

async function cleanText(file) {
  const text = await readFile(file, "utf8");
  const relative = path.relative(rawDir, file);
  return `# ${titleFromFile(file)}\n\n来源文件：${relative}\n\n${normalizeText(text)}\n`;
}

async function writeCleanFile(file, content) {
  const output = outputPathFor(file);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, content, "utf8");
  return output;
}

async function cleanFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") return await writeCleanFile(file, await cleanPdf(file));
  if (ext === ".xlsx") return await writeCleanFile(file, await cleanXlsx(file));
  if (ext === ".csv") return await writeCleanFile(file, await cleanCsv(file));
  if (ext === ".md" || ext === ".txt") return await writeCleanFile(file, await cleanText(file));
  return null;
}

const files = await walk(rawDir);
let cleaned = 0;
let skipped = 0;
let failed = 0;
for (const file of files) {
  const relative = path.relative(rawDir, file);
  try {
    const output = await cleanFile(file);
    if (!output) {
      skipped += 1;
      console.log(`SKIP ${relative}`);
      continue;
    }
    cleaned += 1;
    console.log(`CLEAN ${relative} -> ${path.relative(cleanDir, output)}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${relative}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(JSON.stringify({ rawDir, cleanDir, cleaned, skipped, failed }, null, 2));
if (failed) process.exitCode = 1;
