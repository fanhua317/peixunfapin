import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const pluginDir = path.resolve(import.meta.dirname, "../../training-plugin");
const sourceDir = path.join(pluginDir, "src");
const expectedTools = [
  "training_list_knowledge_bases",
  "training_search_employees",
  "training_create_task_draft",
  "training_publish_task",
  "training_get_task_status",
  "training_answer_question",
  "training_generate_quiz",
  "training_grade_answer",
];
const expectedEndpoints = [
  "/api/knowledge-bases",
  "/api/employees",
  "/api/agent/draft",
  "/api/tasks/publish",
  "/api/tasks/",
  "/api/answer",
  "/api/quiz/generate",
  "/api/quiz/submit",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = JSON.parse(await readFile(path.join(pluginDir, "openclaw.plugin.json"), "utf8"));
const toolsSource = await readFile(path.join(sourceDir, "tools.ts"), "utf8");
const clientSource = await readFile(path.join(sourceDir, "client.ts"), "utf8");
const sourceTools = [...toolsSource.matchAll(/\bname:\s*"([^"]+)"/g)].map((match) => match[1]);
assert(manifest.id === "training-rag", "plugin id changed");
assert(JSON.stringify(manifest.contracts?.tools) === JSON.stringify(expectedTools), "manifest tool contract changed");
assert(JSON.stringify(sourceTools) === JSON.stringify(expectedTools), "registered tool contract changed");
for (const endpoint of expectedEndpoints) {
  assert(toolsSource.includes(endpoint), `missing plugin endpoint: ${endpoint}`);
}
assert(clientSource.includes("request timed out"), "plugin timeout error contract missing");
assert(clientSource.includes("returned non-JSON response"), "plugin non-JSON error contract missing");
assert(clientSource.includes("training-service HTTP"), "plugin HTTP error contract missing");

const typeScriptFiles = (await readdir(sourceDir)).filter((name) => name.endsWith(".ts"));
for (const name of typeScriptFiles) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--check", path.join(sourceDir, name)], {
    cwd: pluginDir,
    stdio: "inherit",
  });
  assert(result.status === 0, `TypeScript syntax check failed: ${name}`);
}

console.log(`plugin contract ok: ${expectedTools.length} tools, ${expectedEndpoints.length} endpoints, ${typeScriptFiles.length} TypeScript files`);
