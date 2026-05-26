import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const scanDirs = ["src", "public", "scripts"];
const allowedExts = new Set([".js", ".mjs"]);
const skipDirs = new Set(["node_modules", ".tmp-smoke-data"]);

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      files.push(...await collectFiles(path.join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && allowedExts.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

const files = [];
for (const dir of scanDirs) {
  files.push(...await collectFiles(path.join(root, dir)));
}

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log(`syntax ok: ${files.length} files`);
