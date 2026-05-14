import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const serviceRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(serviceRoot, "..", "..");
const pdfJsRoot = path.resolve(
  process.env.PDFJS_DIST_DIR || path.join(workspaceRoot, "openclaw", "node_modules", "pdfjs-dist"),
);
const canvasModulePath = path.resolve(
  process.env.CANVAS_MODULE_PATH ||
    path.join(workspaceRoot, "openclaw", "node_modules", "@napi-rs", "canvas", "index.js"),
);
const inputPath = path.resolve(process.argv[2] || process.env.TRAINING_RENDER_INPUT || "D:\\OpenClawData\\training-raw");
const inputRoot = /\.pdf$/i.test(inputPath) ? path.dirname(inputPath) : inputPath;
const outputRoot = path.resolve(process.argv[3] || process.env.TRAINING_RENDER_OUTPUT || "D:\\OpenClawData\\training-vision");
const maxPages = Number(process.argv[4] || process.env.TRAINING_RENDER_MAX_PAGES || 0);
const scale = Number(process.argv[5] || process.env.TRAINING_RENDER_SCALE || 1.6);

let pdfJsModulePromise;
let canvasModulePromise;

async function loadPdfJsModule() {
  if (!pdfJsModulePromise) {
    const modulePath = path.join(pdfJsRoot, "legacy", "build", "pdf.mjs");
    pdfJsModulePromise = import(pathToFileURL(modulePath).href);
  }
  return await pdfJsModulePromise;
}

async function loadCanvasModule() {
  if (!canvasModulePromise) {
    canvasModulePromise = import(pathToFileURL(canvasModulePath).href);
  }
  return await canvasModulePromise;
}

function standardFontDataUrl() {
  return `${path.join(pdfJsRoot, "standard_fonts")}/`;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (/\.pdf$/i.test(entry.name)) files.push(full);
  }
  return files;
}

async function resolveInputFiles(target) {
  if (/\.pdf$/i.test(target)) return [target];
  return await walk(target);
}

function outputDirFor(file) {
  const relative = path.relative(inputRoot, file);
  const parsed = path.parse(relative);
  return path.join(outputRoot, parsed.dir, parsed.name);
}

async function renderPdf(file) {
  const pdfJs = await loadPdfJsModule();
  const canvasModule = await loadCanvasModule();
  const buffer = await readFile(file);
  const pdf = await pdfJs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    standardFontDataUrl: standardFontDataUrl(),
  }).promise;
  const outDir = outputDirFor(file);
  await mkdir(outDir, { recursive: true });
  const pageCount = maxPages > 0 ? Math.min(pdf.numPages, maxPages) : pdf.numPages;
  const rendered = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas, viewport }).promise;
    const outFile = path.join(outDir, `page-${String(pageNumber).padStart(3, "0")}.png`);
    await writeFile(outFile, canvas.toBuffer("image/png"));
    rendered.push(outFile);
  }
  return { file, outDir, pageCount: pdf.numPages, rendered: rendered.length };
}

const stats = [];
const files = (await resolveInputFiles(inputPath)).sort((left, right) => left.localeCompare(right, "zh-Hans-CN", { numeric: true }));
for (const file of files) {
  const result = await renderPdf(file);
  stats.push(result);
  console.log(`RENDER ${path.relative(inputRoot, file)} -> ${path.relative(outputRoot, result.outDir)} (${result.rendered}/${result.pageCount})`);
}
console.log(JSON.stringify({ inputPath, outputRoot, pdfCount: stats.length, pages: stats.reduce((sum, item) => sum + item.rendered, 0) }, null, 2));
