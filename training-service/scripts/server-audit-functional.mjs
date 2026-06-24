import {
  classifyFailure,
  defaultAuditOutDir,
  parseArgs,
  runCommand,
  writeJsonArtifact,
} from "./server-audit/common.mjs";

const args = parseArgs();
const outDir = args.out || defaultAuditOutDir;
const profile = String(args.profile || "full");
const timeoutMs = Number(args.timeoutMs || args["timeout-ms"] || 240_000);

const fullCommands = [
  { id: "check", command: "npm", args: ["run", "check"], timeoutMs: 120_000 },
  { id: "smoke", command: "npm", args: ["run", "smoke"], timeoutMs: 180_000 },
  { id: "eval-rag-retrieval", command: "npm", args: ["run", "eval:rag", "--", "--retrieval-only"], timeoutMs: 180_000 },
  { id: "eval-intent", command: "npm", args: ["run", "eval:intent"], timeoutMs },
  { id: "eval-agent-trajectory", command: "npm", args: ["run", "eval:agent-trajectory"], timeoutMs },
  { id: "eval-boss-chat", command: "npm", args: ["run", "eval:boss-chat"], timeoutMs },
  { id: "eval-translation", command: "npm", args: ["run", "eval:translation"], timeoutMs },
  { id: "eval-jobs", command: "npm", args: ["run", "eval:jobs"], timeoutMs },
  { id: "eval-backup", command: "npm", args: ["run", "eval:backup"], timeoutMs },
  { id: "eval-kb-versions", command: "npm", args: ["run", "eval:kb-versions"], timeoutMs },
];

const quickIds = new Set(["check", "eval-rag-retrieval", "eval-backup"]);
const selected = profile === "quick" ? fullCommands.filter((item) => quickIds.has(item.id)) : fullCommands;
const results = [];

for (const item of selected) {
  const result = await runCommand(item.command, item.args, { timeoutMs: item.timeoutMs || timeoutMs });
  results.push({
    id: item.id,
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    failureClass: classifyFailure(result),
    stdoutTail: result.stdout,
    stderrTail: result.stderr,
  });
  console.log(`${item.id}: ${result.ok ? "ok" : "failed"} (${result.durationMs}ms)`);
}

const summary = {
  kind: "juzhou-server-audit-functional",
  createdAt: new Date().toISOString(),
  profile,
  total: results.length,
  ok: results.filter((item) => item.ok).length,
  failed: results.filter((item) => !item.ok).map((item) => ({
    id: item.id,
    failureClass: item.failureClass,
    exitCode: item.exitCode,
  })),
  results,
};

const path = await writeJsonArtifact(outDir, "functional", summary);
console.log(JSON.stringify({ ok: summary.failed.length === 0, path, summary: { total: summary.total, ok: summary.ok, failed: summary.failed } }, null, 2));

if (summary.failed.length) process.exitCode = 1;
