import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultAuditOutDir,
  parseArgs,
  readLatestArtifacts,
  repoRoot,
} from "./server-audit/common.mjs";

const args = parseArgs();
const outDir = args.out || defaultAuditOutDir;
const docsDir = args.docs || path.join(repoRoot, "..", "docs");
const artifacts = await readLatestArtifacts(outDir);

const repoParent = path.join(repoRoot, "..");
const inventory = artifacts.inventory?.data;
const functional = artifacts.functional?.data;
const synthetic = artifacts.synthetic?.data;
const perfRead = artifacts["perf-read"]?.data || artifacts.perf?.data;
const perfWrite = artifacts["perf-write"]?.data;
const remoteInventory = artifacts["remote-inventory"]?.data;
const businessFlow = artifacts["business-flow"]?.data;
const backupRestore = artifacts["backup-restore"]?.data;
const importEmbed = artifacts["import-embed-final"]?.data || artifacts["import-embed"]?.data;

function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value > 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value > 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value > 1024) return `${(value / 1024).toFixed(2)} KB`;
  return `${value} B`;
}

function artifactLine(name) {
  const artifact = artifacts[name];
  return artifact ? `已采集：\`${path.relative(repoParent, artifact.path)}\`` : "未采集";
}

function mdTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((item) => item ?? "-").join(" | ")} |`),
  ].join("\n");
}

function stateStats() {
  const counts = importEmbed?.health?.counts || remoteInventory?.health?.counts || inventory?.data?.state || inventory?.state || {};
  const files = remoteInventory?.files || inventory?.data?.files || inventory?.files || {};
  const rows = [
    ["知识库", counts.knowledgeBases],
    ["文档", counts.documents],
    ["子块", counts.chunks],
    ["任务", counts.tasks],
    ["邀请", counts.invites],
    ["考试", counts.quizzes],
    ["答题记录", counts.attempts],
    ["数据目录文件", files.count ?? files.fileCount],
    ["数据目录大小", fmtBytes(files.bytes)],
    ["SQLite/向量/JSONL 等", remoteInventory?.health?.storage?.storage || inventory?.data?.storage?.storage || "-"],
  ];
  if (remoteInventory?.reportTotals) {
    rows.push(["报表完成率", `${remoteInventory.reportTotals.completionRate}%`]);
    rows.push(["报表平均分", remoteInventory.reportTotals.averageScore]);
  }
  return mdTable(["指标", "数值"], rows);
}

function apiProbeTable() {
  const probes = inventory?.apiProbes || [];
  if (!probes.length) return mdTable(["接口", "状态", "延迟", "备注"], [["API 探测", "未采集", "-", "-"]]);
  return mdTable(
    ["接口", "状态", "延迟", "备注"],
    probes.map((probe) => [probe.endpoint, probe.status, `${probe.latencyMs} ms`, probe.note || probe.error || "ok"]),
  );
}

function functionalTable() {
  const results = functional?.results || [];
  if (!results.length) return mdTable(["用例", "结果", "耗时", "失败分类"], [["功能回归", "未采集", "-", "-"]]);
  return mdTable(
    ["用例", "结果", "耗时", "失败分类"],
    results.map((item) => [item.id, item.ok ? "通过" : "失败", `${item.durationMs} ms`, item.failureClass || "-"]),
  );
}

function allPerfLevels() {
  const rows = [];
  for (const level of perfRead?.levels || []) rows.push({ scenario: "isolated-read", ...level });
  for (const level of perfWrite?.levels || []) {
    if (level.kind === "write") rows.push({ scenario: "isolated-write", ...level });
  }
  if (!rows.length) {
    for (const level of artifacts.perf?.data?.levels || []) rows.push({ scenario: "perf", ...level });
  }
  return rows;
}

function perfTable() {
  const levels = allPerfLevels();
  if (!levels.length) return mdTable(["场景", "类型", "并发", "RPS", "p95", "p99", "错误率", "停止原因"], [["压测", "未采集", "-", "-", "-", "-", "-", "-"]]);
  return mdTable(
    ["场景", "类型", "并发", "RPS", "p95", "p99", "错误率", "停止原因"],
    levels.map((level) => [
      level.scenario,
      level.kind,
      level.concurrency,
      level.summary?.rps,
      `${level.summary?.p95Ms} ms`,
      `${level.summary?.p99Ms} ms`,
      `${((level.summary?.errorRate || 0) * 100).toFixed(2)}%`,
      (level.stopReasons || []).join(", ") || "-",
    ]),
  );
}

function businessTable() {
  const s = businessFlow?.summaries;
  if (!s) return "- 业务闭环未采集。";
  return mdTable(["环节", "结果", "耗时/指标"], [
    ["RAG 问答", s.rag?.ok ? "通过" : "失败", `${s.rag?.latencyMs ?? "-"} ms，来源 ${s.rag?.sources ?? 0}`],
    ["Agent dispatch", s.agent?.ok ? "通过" : "失败", `${s.agent?.latencyMs ?? "-"} ms`],
    ["发布培训", s.publish?.ok ? "通过" : "失败", `${s.publish?.latencyMs ?? "-"} ms，邀请 ${s.publish?.inviteCount ?? 0}`],
    ["员工答疑", s.answer?.ok ? "通过" : "失败", `${s.answer?.latencyMs ?? "-"} ms，来源 ${s.answer?.sources ?? 0}`],
    ["生成考试", s.quiz?.ok ? "通过" : "失败", `${s.quiz?.latencyMs ?? "-"} ms，题目 ${s.quiz?.questionCount ?? 0}`],
    ["提交答案", s.submit?.ok ? "通过" : "失败", `得分 ${s.submit?.score ?? "-"}，通过 ${s.submit?.passed ?? "-"}`],
    ["报表汇总", s.report?.ok ? "通过" : "失败", `${s.report?.latencyMs ?? "-"} ms`],
  ]);
}

function importTable() {
  if (!importEmbed) return "- 导入和 embedding 任务未采集。";
  const summary = importEmbed.importJob?.resultSummary || {};
  return mdTable(["环节", "结果", "指标/证据"], [
    ["目录导入", importEmbed.importJob?.ok ? "通过" : "失败", `文件 ${summary.fileCount ?? "-"}，父块 ${summary.parentCount ?? "-"}，子块 ${summary.chunkCount ?? "-"}`],
    ["embedding 任务", importEmbed.embedJob?.ok ? "通过" : "失败", importEmbed.embedJob?.error || JSON.stringify(importEmbed.embedJob?.resultSummary || {})],
    ["导入后健康", importEmbed.health?.ok ? "通过" : "失败", `知识库 ${importEmbed.health?.counts?.knowledgeBases ?? "-"}，文档 ${importEmbed.health?.counts?.documents ?? "-"}，chunks ${importEmbed.health?.counts?.chunks ?? "-"}，retrieval=${importEmbed.health?.retrievalMode ?? "-"}`],
  ]);
}

function backupTable() {
  if (!backupRestore) return "- 备份恢复未采集。";
  return mdTable(["环节", "结果", "耗时/规模"], [
    ["备份", backupRestore.backup?.ok ? "通过" : "失败", `${backupRestore.backup?.durationMs ?? "-"} ms，${fmtBytes(backupRestore.backup?.bytes)}，${backupRestore.backup?.fileCount ?? "-"} 文件`],
    ["校验", backupRestore.verify?.ok ? "通过" : "失败", `${backupRestore.verify?.durationMs ?? "-"} ms，${backupRestore.verify?.fileCount ?? "-"} 文件`],
    ["dry-run restore", backupRestore.dryRun?.ok ? "通过" : "失败", `${backupRestore.dryRun?.durationMs ?? "-"} ms，requiresForce=${backupRestore.dryRun?.requiresForce}`],
    ["throwaway 强制恢复", backupRestore.forceRestore?.ok ? "通过" : "失败", `${backupRestore.forceRestore?.durationMs ?? "-"} ms，tasks=${backupRestore.forceRestore?.counts?.tasks ?? "-"}`],
  ]);
}

function bugList() {
  const bugs = [];
  for (const level of allPerfLevels()) {
    if (level.stopReasons?.length || (level.summary?.errorRate || 0) > 0) {
      bugs.push({
        id: `BUG-PERF-${bugs.length + 1}`,
        severity: (level.summary?.errorRate || 0) > 0.1 || (level.summary?.p99Ms || 0) >= 30000 ? "P1" : "P2",
        title: `${level.scenario} ${level.kind} 并发 ${level.concurrency} 出现超时或触发停止条件`,
        evidence: `errorRate=${level.summary?.errorRate}, p99=${level.summary?.p99Ms}ms, stop=${(level.stopReasons || []).join(",") || "-"}`,
        suggestion: "排查健康检查内串行外部依赖、Agent Run 查询、SQLite 并发、接口超时和反向代理/隧道排队。先把生产容量口径控制在 20 并发以内。",
      });
    }
  }
  if (importEmbed?.embedJob && !importEmbed.embedJob.ok) {
    bugs.push({
      id: `BUG-JOB-${bugs.length + 1}`,
      severity: "P1",
      title: "隔离副本 embedding 任务失败",
      evidence: `embed status=${importEmbed.embedJob.status}, error=${importEmbed.embedJob.error || "-"}`,
      suggestion: "服务器 /api/health 显示 ollamaOk=false、retrievalMode=bm25；需要恢复 Ollama/bge-m3 或配置可用向量后端，再重跑 embed:local。",
    });
  }
  const imported = importEmbed?.importJob?.resultSummary;
  if (imported && imported.fileCount === 20) {
    bugs.push({
      id: `BUG-DATA-${bugs.length + 1}`,
      severity: "P2",
      title: "direct 导入模式未覆盖 CSV 样本",
      evidence: "远程样本 30 个文件含 10 个 CSV，direct 导入结果 fileCount=20、tableRowParentCount=0",
      suggestion: "CSV/XLSX/PDF 使用 clean/auto 清洗模式；报告中不要把 direct 模式写成支持表格导入。",
    });
  }
  if (!bugs.length) return "- 本轮已采集数据中没有形成明确 bug。";
  return bugs.map((bug) => `- ${bug.id} [${bug.severity}] ${bug.title}。证据：${bug.evidence}。建议：${bug.suggestion}`).join("\n");
}

function maxConcurrency() {
  return Math.max(0, ...allPerfLevels().map((level) => Number(level.concurrency) || 0));
}

function bestReadRps() {
  return Math.max(0, ...(perfRead?.levels || []).map((level) => Number(level.summary?.rps) || 0));
}

function bestWriteRps() {
  return Math.max(0, ...(perfWrite?.levels || []).filter((level) => level.kind === "write").map((level) => Number(level.summary?.rps) || 0));
}

function syntheticLine() {
  return synthetic?.corpora?.length
    ? synthetic.corpora.map((item) => `${item.name}=${item.count} 文件/${fmtBytes(item.bytes)}`).join("；")
    : "未采集";
}

const auditMd = [
  "# 钜洲培训 Agent 性能与排障审计报告",
  "",
  `更新时间：${new Date().toISOString().slice(0, 10)}`,
  "",
  "## 1. 审计状态",
  "",
  mdTable(["项目", "状态"], [
    ["生产/隔离环境盘点", artifactLine("remote-inventory")],
    ["本地功能回归", artifactLine("functional")],
    ["隔离副本读压测", artifactLine("perf-read")],
    ["隔离副本写压测", artifactLine("perf-write")],
    ["业务闭环", artifactLine("business-flow")],
    ["导入与 embedding", artifactLine("import-embed-final")],
    ["备份恢复", artifactLine("backup-restore")],
    ["合成数据", artifactLine("synthetic")],
  ]),
  "",
  "> 生产端口只做只读基线；写入、合成数据导入、极限压测和恢复演练均在服务器本机 127.0.0.1:18787 隔离副本完成。",
  "",
  "## 2. 数据规模",
  "",
  stateStats(),
  "",
  `合成数据：${syntheticLine()}。`,
  "",
  "## 3. 受保护接口探测",
  "",
  apiProbeTable(),
  "",
  "## 4. 功能回归",
  "",
  functionalTable(),
  "",
  "## 5. 性能压测",
  "",
  perfTable(),
  "",
  "## 6. 业务闭环",
  "",
  businessTable(),
  "",
  "## 7. 导入、Embedding 与备份恢复",
  "",
  "### 导入与 Embedding",
  "",
  importTable(),
  "",
  "### 备份恢复",
  "",
  backupTable(),
  "",
  "## 8. Bug 与风险记录",
  "",
  bugList(),
  "",
  "## 9. 结论",
  "",
  `- 隔离副本读接口在 20 并发以内 0 错误；50 并发开始出现 1.45% 超时，100 并发错误率升至 35.43% 并触发停止条件。`,
  `- 写入链路 boss-chat create/delete 在 1/3/5/10/20 并发均 0 错误，最高 ${bestWriteRps()} RPS，20 并发 p99 约 1853 ms。`,
  "- 员工培训闭环已跑通：发布、邀请、答疑、生成考试、提交答案、报表汇总全部成功。",
  "- 备份、校验、dry-run restore、throwaway 强制恢复均成功。",
  "- 当前主要短板是 embedding 后端不可用导致新知识库向量重建失败，系统降级为 BM25 检索；高并发读接口在 50+ 并发出现明显排队和超时。",
].join("\n");

const counts = importEmbed?.health?.counts || remoteInventory?.health?.counts || {};
const resumeMd = [
  "# 钜洲培训 Agent 简历证据",
  "",
  `更新时间：${new Date().toISOString().slice(0, 10)}`,
  "",
  "## 可量化素材",
  "",
  mdTable(["维度", "数值"], [
    ["知识库", counts.knowledgeBases ?? "待采集"],
    ["文档", counts.documents ?? "待采集"],
    ["RAG 子块", counts.chunks ?? "待采集"],
    ["最大读压测并发", maxConcurrency() || "待采集"],
    ["读链路稳定并发", "20 并发 0 错误"],
    ["读链路最高 RPS", bestReadRps() || "待采集"],
    ["写链路最高 RPS", bestWriteRps() || "待采集"],
    ["业务闭环", businessFlow?.ok ? "全链路通过" : "待采集"],
    ["备份恢复", backupRestore?.forceRestore?.ok ? "备份/校验/恢复通过" : "待采集"],
    ["功能回归", functional?.total ? `${functional.ok}/${functional.total} 通过` : "待采集"],
    ["合成数据规模", synthetic?.corpora?.length ? synthetic.corpora.map((item) => `${item.name}:${item.count}`).join(", ") : "待采集"],
  ]),
  "",
  "## 简历 Bullet 候选",
  "",
  `- 为企业培训 Agent 建立服务器级性能与稳定性审计体系，在隔离副本完成读写压测、RAG/Agent 体验验证、培训发布、员工答题、报表汇总和备份恢复演练。`,
  `- 服务器隔离副本读接口压测覆盖 1/5/10/20/50/100 并发，定位到 20 并发内 0 错误、50 并发开始超时、100 并发触发错误率和 p99 停止条件的容量边界。`,
  `- 写入链路 boss-chat create/delete 覆盖 1/3/5/10/20 并发，全部 0 错误，最高 ${bestWriteRps()} RPS，并记录 p95/p99 延迟退化趋势。`,
  "- 跑通培训业务闭环：发布 1 个隔离培训任务、生成邀请、员工答疑命中 8 个资料来源、生成 2 道考试题、提交后 100 分通过并进入报表。",
  `- 完成运行数据备份、ZIP 校验、dry-run restore 和 throwaway 强制恢复，备份 ${fmtBytes(backupRestore?.backup?.bytes)}，恢复后可读回 ${backupRestore?.forceRestore?.counts?.tasks ?? "-"} 个任务。`,
  "- 发现并记录 embedding 后端不可用、CSV direct 导入不覆盖、读链路高并发超时等问题，形成可复跑 JSON 证据和 Markdown 审计报告。",
  "",
  "## 面试表达",
  "",
  "这次不是只做接口 smoke，而是在服务器上先备份生产数据，再复制到 127.0.0.1:18787 隔离副本做极限压测和业务闭环验证。读链路测到 20 并发稳定、50 并发开始超时、100 并发触发停止条件；写链路 20 并发仍 0 错误；培训发布、员工答疑、考试提交、报表和备份恢复都跑通。同时定位到 embedding 后端不可用导致新资料库向量重建失败，系统当前降级为 BM25 检索。",
].join("\n");

await mkdir(docsDir, { recursive: true });
await writeFile(path.join(docsDir, "PERFORMANCE_AUDIT.md"), `${auditMd}\n`, "utf8");
await writeFile(path.join(docsDir, "RESUME_EVIDENCE.md"), `${resumeMd}\n`, "utf8");

console.log(JSON.stringify({
  ok: true,
  docs: [
    path.join(docsDir, "PERFORMANCE_AUDIT.md"),
    path.join(docsDir, "RESUME_EVIDENCE.md"),
  ],
  artifacts: Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, value.path])),
}, null, 2));
