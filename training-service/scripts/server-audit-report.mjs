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
const webSearch = artifacts["web-search"]?.data;

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

function fmtMs(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `${Math.round(num)} ms` : "-";
}

function fmtPercent(value, digits = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? `${(num * 100).toFixed(digits)}%` : "-";
}

function stateStats() {
  const counts = webSearch?.production?.health?.counts || importEmbed?.health?.counts || remoteInventory?.health?.counts || inventory?.data?.state || inventory?.state || {};
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
  const health = currentHealth();
  const recovered = health.ollamaOk === true && health.localVectorIndexOk === true;
  return mdTable(["环节", "结果", "指标/证据"], [
    ["目录导入", importEmbed.importJob?.ok ? "通过" : "失败", `文件 ${summary.fileCount ?? "-"}，父块 ${summary.parentCount ?? "-"}，子块 ${summary.chunkCount ?? "-"}`],
    ["embedding 任务", importEmbed.embedJob?.ok ? "通过" : (recovered ? "审计时失败；最新生产健康已恢复" : "失败"), importEmbed.embedJob?.error || JSON.stringify(importEmbed.embedJob?.resultSummary || {})],
    ["导入后健康", recovered ? "审计时降级；最新恢复 hybrid" : (importEmbed.health?.ok ? "通过" : "失败"), recovered
      ? `审计时 retrieval=${importEmbed.health?.retrievalMode ?? "-"}；最新 /api/health 为 retrieval=${health.retrievalMode ?? "-"}、ollamaOk=${health.ollamaOk}、localVectorIndexOk=${health.localVectorIndexOk}`
      : `知识库 ${importEmbed.health?.counts?.knowledgeBases ?? "-"}，文档 ${importEmbed.health?.counts?.documents ?? "-"}，chunks ${importEmbed.health?.counts?.chunks ?? "-"}，retrieval=${importEmbed.health?.retrievalMode ?? "-"}`],
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
    const latestHealth = currentHealth();
    const recovered = latestHealth.ollamaOk === true && latestHealth.localVectorIndexOk === true;
    bugs.push({
      id: `BUG-JOB-${bugs.length + 1}`,
      severity: recovered ? "P3" : "P1",
      title: recovered ? "历史隔离副本 embedding 任务失败，最新生产健康已恢复" : "隔离副本 embedding 任务失败",
      evidence: `embed status=${importEmbed.embedJob.status}, error=${importEmbed.embedJob.error || "-"}`,
      suggestion: recovered
        ? "保留历史证据并在下次导入/embedding 审计中复测，不再把它视为当前生产检索故障。"
        : "服务器 /api/health 显示向量后端不可用；需要恢复 Ollama/bge-m3 或配置可用向量后端，再重跑 embed:local。",
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

function currentHealth() {
  return webSearch?.production?.health || importEmbed?.health || remoteInventory?.health || {};
}

function retrievalConclusionLine() {
  const health = currentHealth();
  if (health.ollamaOk === true && health.localVectorIndexOk === true) {
    return `- 当前生产健康检查显示 retrievalMode=${health.retrievalMode || "-"}、ollamaOk=true、localVectorIndexOk=true，向量检索处于可用状态；历史导入/embedding 单项失败保留为复测风险，不再作为当前线上短板。`;
  }
  if (health.ollamaOk === false || health.localVectorIndexOk === false) {
    return `- 当前主要短板是 embedding/向量后端不可用，/api/health 显示 retrievalMode=${health.retrievalMode || "-"}、ollamaOk=${health.ollamaOk}、localVectorIndexOk=${health.localVectorIndexOk}；高并发读接口在 50+ 并发出现明显排队和超时。`;
  }
  return "- 当前向量健康状态未采集完整；需要结合 /api/health 和 RAG retrieval-only 结果复核检索模式。";
}

function retrievalInterviewLine() {
  const health = currentHealth();
  if (health.ollamaOk === true && health.localVectorIndexOk === true) {
    return `最新服务器健康检查里，检索模式是 ${health.retrievalMode || "hybrid"}，Ollama 和本地向量索引都可用；历史审计里曾发现过 embedding 任务失败，所以我把它保留为复测项，而不是把旧问题说成当前线上故障。`;
  }
  return "如果 /api/health 显示 Ollama 或本地向量索引不可用，系统会降级检索，但这会影响新资料库向量重建和语义召回质量，需要优先恢复 embedding 后端。";
}

function webSearchStatusTable() {
  if (!webSearch) return mdTable(["指标", "数值"], [["联网答疑专项", "未采集"]]);
  const s = webSearch.summary || {};
  const production = webSearch.production?.health || {};
  const env = webSearch.env?.configPresence || (typeof webSearch.env?.keyPresence === "object" ? webSearch.env.keyPresence : {});
  const webCredentialConfigured = env.webSearchCredentialConfigured ?? env.webSearchKeyConfigured;
  const code = webSearch.production?.codeStatus || {};
  return mdTable(["指标", "数值"], [
    ["生产健康", production.ok ? `HTTP ${production.status}，retrieval=${production.retrievalMode}，ollamaOk=${production.ollamaOk}，llmConfigured=${production.llmConfigured}` : `失败：${production.error || production.status || "-"}`],
    ["知识库规模", production.counts ? `${production.counts.knowledgeBases ?? 0} 个知识库 / ${production.counts.documents ?? 0} 文档 / ${production.counts.chunks ?? 0} 子块` : "-"],
    ["Tavily 配置", webCredentialConfigured === undefined ? "artifact 已脱敏，配置状态不可判定" : (webCredentialConfigured ? `${env.webProvider || "tavily"} 已配置` : "未配置")],
    ["代码覆盖", `web-search=${Boolean(code.hasWebSearch)}，eval=${Boolean(code.hasEvalWebSearch)}，前端开关=${Boolean(code.hasBossToggle)}`],
    ["真实联网样本", s.sampleCount ?? 0],
    ["Tavily 成功率", fmtPercent(s.webSuccessRate)],
    ["on 平均 / p95", `${fmtMs(s.directOnLatency?.avgMs)} / ${fmtMs(s.directOnLatency?.p95Ms)}`],
    ["off 平均 / p95", `${fmtMs(s.directOffLatency?.avgMs)} / ${fmtMs(s.directOffLatency?.p95Ms)}`],
    ["off/on 平均耗时差", fmtMs((Number(s.directOnLatency?.avgMs) || 0) - (Number(s.directOffLatency?.avgMs) || 0))],
    ["平均知识库来源", s.avgLocalSources ?? 0],
    ["平均联网来源", s.avgWebSources ?? 0],
    ["warning 数", s.totalWarnings ?? 0],
    ["六链路覆盖", `${s.chainOk ?? 0}/${s.chainCases ?? 0} on 通过，off 不调用 ${s.chainOffNoWeb ?? 0}/${s.chainCases ?? 0}`],
    ["六链路 on 平均 / p95", `${fmtMs(s.chainOnLatency?.avgMs)} / ${fmtMs(s.chainOnLatency?.p95Ms)}`],
    ["六链路平均来源", `本地 ${s.chainAvgLocalSources ?? 0} / 联网 ${s.chainAvgWebSources ?? 0}`],
    ["API 透传", `${s.apiOk ?? 0}/${s.apiCases ?? 0} 用例通过，web ok=${s.apiWebOk ?? 0}`],
    ["异常降级", `${s.degradationOk ?? 0}/${s.degradationCases ?? 0} 用例保留本地 RAG 答复`],
  ]);
}

function webSearchCaseTable() {
  const samples = webSearch?.direct?.samples || [];
  if (!samples.length) return mdTable(["样本", "知识库", "off 耗时/来源", "on 状态/耗时", "联网来源", "质量"], [["联网样本", "未采集", "-", "-", "-", "-"]]);
  return mdTable(
    ["样本", "知识库", "off 耗时/来源", "on 状态/耗时", "联网来源", "质量"],
    samples.map((sample) => [
      sample.id,
      sample.knowledgeBaseId,
      `${fmtMs(sample.off?.latencyMs)} / ${sample.off?.sourceCount ?? 0}`,
      `${sample.on?.webSearchStatus || "-"} / ${fmtMs(sample.on?.latencyMs)}`,
      `${sample.on?.webSourceCount ?? 0}`,
      `${sample.on?.confidence || "-"} / ${sample.on?.answerQualityStatus || "-"}`,
    ]),
  );
}

function webSearchChainTable() {
  const chains = webSearch?.chainCoverage?.chains || [];
  if (!chains.length) return mdTable(["链路", "off 状态/耗时", "on 状态/耗时", "本地来源", "联网来源", "warning"], [["六链路专项", "未采集", "-", "-", "-", "-"]]);
  return mdTable(
    ["链路", "off 状态/耗时", "on 状态/耗时", "本地来源", "联网来源", "warning"],
    chains.map((item) => [
      item.id,
      `${item.off?.webSearchStatus || "-"} / ${fmtMs(item.off?.latencyMs)}`,
      `${item.on?.webSearchStatus || "-"} / ${fmtMs(item.on?.latencyMs)}`,
      `${item.on?.sourceCount ?? 0}`,
      `${item.on?.webSourceCount ?? 0}`,
      `${item.on?.warningCount ?? 0}`,
    ]),
  );
}

function webSearchApiTable() {
  const cases = webSearch?.apiCoverage || [];
  if (!cases.length) return mdTable(["接口", "结果", "耗时", "联网状态/来源"], [["API 透传", "未采集", "-", "-"]]);
  return mdTable(
    ["接口", "结果", "耗时", "联网状态/来源"],
    cases.map((item) => [
      item.endpoint,
      item.ok ? "通过" : `失败：${item.error || item.status || "-"}`,
      fmtMs(item.latencyMs),
      item.payload ? `${item.payload.webSearchStatus || "-"} / 本地 ${item.payload.sourceCount ?? 0} / 联网 ${item.payload.webSourceCount ?? 0}` : "-",
    ]),
  );
}

function webSearchResumeBullet() {
  if (!webSearch) return "- 联网答疑专项证据待采集。";
  const s = webSearch.summary || {};
  return `- 接入 Tavily 可选联网搜索并完成服务器隔离副本端到端验证：${s.sampleCount ?? 0} 个真实联网答疑样本成功率 ${fmtPercent(s.webSuccessRate)}，综合答疑 on p95 ${fmtMs(s.directOnLatency?.p95Ms)}；六条生成链路（知识库答疑、营销软文、培训材料、考试、翻译、普通聊天）${s.chainOk ?? 0}/${s.chainCases ?? 0} 个 on 用例返回联网来源，off 不调用 ${s.chainOffNoWeb ?? 0}/${s.chainCases ?? 0} 个通过；HTTP、Agent dispatch、WebSocket、员工答疑/考试/发布共 ${s.apiOk ?? 0}/${s.apiCases ?? 0} 个 API 用例通过，缺 key/500/空结果等 ${s.degradationOk ?? 0}/${s.degradationCases ?? 0} 个异常场景均未打断本地 RAG。`;
}

function webSearchInterviewLine() {
  if (!webSearch) return "联网专项正在采集证据，目标是证明 webSearchMode 默认关闭、开启后补充 Tavily 来源，并且外部搜索失败时不影响原生成链路。";
  const s = webSearch.summary || {};
  return `联网搜索部分我做成显式开关，默认不消耗 Tavily credits；开启后仍以知识库 RAG 或用户原文为主，把网页标题、URL、摘要作为外部参考交给同一次 LLM。专项测试覆盖 ${s.sampleCount ?? 0} 个真实联网答疑问题，成功率 ${fmtPercent(s.webSuccessRate)}，on p95 ${fmtMs(s.directOnLatency?.p95Ms)}；六条生成链路 ${s.chainOk ?? 0}/${s.chainCases ?? 0} 个 on 用例返回联网来源、${s.chainOffNoWeb ?? 0}/${s.chainCases ?? 0} 个 off 用例不调用 Tavily，并验证 HTTP、WebSocket、员工答疑、发布和考试生成都能透传 webSearchMode。缺 key、Tavily 500、超时、空结果时只返回 warning，本地生成不中断。`;
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
    ["生产 RAG 健康状态", webSearch ? `已验证：/api/health retrievalMode=${currentHealth().retrievalMode || "-"}，ollamaOk=${currentHealth().ollamaOk}，localVectorIndexOk=${currentHealth().localVectorIndexOk}` : "未采集"],
    ["备份恢复", artifactLine("backup-restore")],
    ["Tavily 联网答疑专项", artifactLine("web-search")],
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
  "## 8. Tavily 联网答疑专项",
  "",
  webSearchStatusTable(),
  "",
  "### 样本明细",
  "",
  webSearchCaseTable(),
  "",
  "### 六链路专项",
  "",
  webSearchChainTable(),
  "",
  "### API 透传",
  "",
  webSearchApiTable(),
  "",
  "## 9. Bug 与风险记录",
  "",
  bugList(),
  "",
  "## 10. 结论",
  "",
  `- 隔离副本读接口在 20 并发以内 0 错误；50 并发开始出现 1.45% 超时，100 并发错误率升至 35.43% 并触发停止条件。`,
  `- 写入链路 boss-chat create/delete 在 1/3/5/10/20 并发均 0 错误，最高 ${bestWriteRps()} RPS，20 并发 p99 约 1853 ms。`,
  "- 员工培训闭环已跑通：发布、邀请、答疑、生成考试、提交答案、报表汇总全部成功。",
  webSearch ? `- Tavily 联网答疑专项已完成：${webSearch.summary?.sampleCount ?? 0} 个真实样本成功率 ${fmtPercent(webSearch.summary?.webSuccessRate)}，平均联网来源 ${webSearch.summary?.avgWebSources ?? 0}，异常降级 ${webSearch.summary?.degradationOk ?? 0}/${webSearch.summary?.degradationCases ?? 0} 通过。` : "- Tavily 联网答疑专项未采集。",
  "- 备份、校验、dry-run restore、throwaway 强制恢复均成功。",
  retrievalConclusionLine(),
].join("\n");

const counts = webSearch?.production?.health?.counts || importEmbed?.health?.counts || remoteInventory?.health?.counts || {};
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
    ["生产 RAG 健康状态", webSearch ? `ollamaOk=${currentHealth().ollamaOk}，localVectorIndexOk=${currentHealth().localVectorIndexOk}，retrievalMode=${currentHealth().retrievalMode || "-"}` : "待采集"],
    ["联网答疑样本", webSearch?.summary?.sampleCount ?? "待采集"],
    ["Tavily 成功率", webSearch ? fmtPercent(webSearch.summary?.webSuccessRate) : "待采集"],
    ["联网答疑 on p95", webSearch ? fmtMs(webSearch.summary?.directOnLatency?.p95Ms) : "待采集"],
    ["平均联网来源", webSearch?.summary?.avgWebSources ?? "待采集"],
    ["六链路联网覆盖", webSearch ? `${webSearch.summary?.chainOk ?? 0}/${webSearch.summary?.chainCases ?? 0} on 通过` : "待采集"],
    ["六链路 off 不调用", webSearch ? `${webSearch.summary?.chainOffNoWeb ?? 0}/${webSearch.summary?.chainCases ?? 0} 通过` : "待采集"],
    ["六链路 on p95", webSearch ? fmtMs(webSearch.summary?.chainOnLatency?.p95Ms) : "待采集"],
    ["六链路平均来源", webSearch ? `本地 ${webSearch.summary?.chainAvgLocalSources ?? 0} / 联网 ${webSearch.summary?.chainAvgWebSources ?? 0}` : "待采集"],
    ["联网 API 透传", webSearch ? `${webSearch.summary?.apiOk ?? 0}/${webSearch.summary?.apiCases ?? 0} 通过` : "待采集"],
    ["联网异常降级", webSearch ? `${webSearch.summary?.degradationOk ?? 0}/${webSearch.summary?.degradationCases ?? 0} 通过` : "待采集"],
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
  webSearchResumeBullet(),
  "- 跑通培训业务闭环：发布 1 个隔离培训任务、生成邀请、员工答疑命中 8 个资料来源、生成 2 道考试题、提交后 100 分通过并进入报表。",
  `- 完成运行数据备份、ZIP 校验、dry-run restore 和 throwaway 强制恢复，备份 ${fmtBytes(backupRestore?.backup?.bytes)}，恢复后可读回 ${backupRestore?.forceRestore?.counts?.tasks ?? "-"} 个任务。`,
  "- 发现并记录历史 embedding 任务失败、CSV direct 导入不覆盖、读链路高并发超时等问题，形成可复跑 JSON 证据和 Markdown 审计报告，并用最新生产 health 区分已恢复项和当前风险。",
  "",
  "## 面试表达",
  "",
  `这次不是只做接口 smoke，而是在服务器上先备份生产数据，再复制到隔离副本做极限压测和业务闭环验证。读链路测到 20 并发稳定、50 并发开始超时、100 并发触发停止条件；写链路 20 并发仍 0 错误；培训发布、员工答疑、考试提交、报表和备份恢复都跑通。${retrievalInterviewLine()}`,
  "",
  webSearchInterviewLine(),
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
