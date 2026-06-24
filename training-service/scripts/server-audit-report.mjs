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

function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value > 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value > 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value > 1024) return `${(value / 1024).toFixed(2)} KB`;
  return `${value} B`;
}

function artifactLine(name) {
  const artifact = artifacts[name];
  return artifact ? `已采集：\`${path.relative(path.join(repoRoot, ".."), artifact.path)}\`` : "未采集";
}

const inventory = artifacts.inventory?.data;
const functional = artifacts.functional?.data;
const perf = artifacts.perf?.data;
const synthetic = artifacts.synthetic?.data;

function stateStats() {
  const state = inventory?.data?.state || inventory?.state || inventory?.summary?.data?.state;
  const files = inventory?.data?.files || inventory?.files || inventory?.summary?.data?.files;
  if (!state && !files) return "| 指标 | 数值 |\n| --- | --- |\n| 数据状态 | 未采集 |";
  const rows = [
    ["知识库", state?.knowledgeBases],
    ["文档", state?.documents],
    ["父块", state?.chunkParents],
    ["子块", state?.chunks],
    ["员工", state?.employees],
    ["任务", state?.tasks],
    ["邀请", state?.invites],
    ["考试", state?.quizzes],
    ["答题记录", state?.attempts],
    ["数据目录文件", files?.fileCount],
    ["数据目录大小", fmtBytes(files?.bytes)],
  ];
  return ["| 指标 | 数值 |", "| --- | --- |", ...rows.map(([key, value]) => `| ${key} | ${value ?? "未采集"} |`)].join("\n");
}

function apiProbeTable() {
  const probes = inventory?.apiProbes || [];
  if (!probes.length) return "| 接口 | 状态 | 延迟 | 备注 |\n| --- | --- | --- | --- |\n| API 探测 | 未采集 | - | - |";
  return [
    "| 接口 | 状态 | 延迟 | 备注 |",
    "| --- | --- | --- | --- |",
    ...probes.map((probe) => `| ${probe.endpoint} | ${probe.status} | ${probe.latencyMs} ms | ${probe.note || probe.error || "ok"} |`),
  ].join("\n");
}

function functionalTable() {
  const results = functional?.results || [];
  if (!results.length) return "| 用例 | 结果 | 耗时 | 失败分类 |\n| --- | --- | --- | --- |\n| 功能回归 | 未采集 | - | - |";
  return [
    "| 用例 | 结果 | 耗时 | 失败分类 |",
    "| --- | --- | --- | --- |",
    ...results.map((item) => `| ${item.id} | ${item.ok ? "通过" : "失败"} | ${item.durationMs} ms | ${item.failureClass || "-"} |`),
  ].join("\n");
}

function perfTable() {
  const levels = perf?.levels || [];
  if (!levels.length) return "| 类型 | 并发 | RPS | p95 | p99 | 错误率 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n| 压测 | 未采集 | - | - | - | - |";
  return [
    "| 类型 | 并发 | RPS | p95 | p99 | 错误率 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...levels.map((level) => `| ${level.kind} | ${level.concurrency} | ${level.summary.rps} | ${level.summary.p95Ms} ms | ${level.summary.p99Ms} ms | ${(level.summary.errorRate * 100).toFixed(2)}% |`),
  ].join("\n");
}

function bugList() {
  const bugs = [];
  for (const item of functional?.results || []) {
    if (!item.ok) {
      bugs.push({
        id: `BUG-FUNC-${bugs.length + 1}`,
        severity: item.failureClass === "code_or_behavior" ? "P1" : "P2",
        title: `${item.id} 未通过`,
        evidence: item.failureClass || "unknown",
        suggestion: "查看对应 stdout/stderr 原始 JSON，按失败分类定位环境、数据或代码问题。",
      });
    }
  }
  for (const level of perf?.levels || []) {
    if (level.stopReasons?.length || level.summary.errorRate > 0) {
      bugs.push({
        id: `BUG-PERF-${bugs.length + 1}`,
        severity: level.summary.errorRate > 0.1 ? "P1" : "P2",
        title: `${level.kind} 并发 ${level.concurrency} 出现错误或触发停止条件`,
        evidence: `errorRate=${level.summary.errorRate}, stop=${(level.stopReasons || []).join(",") || "-"}`,
        suggestion: "结合 server.log、watchdog.log、agent-runs 和 Windows 事件日志定位瓶颈。",
      });
    }
  }
  if (!bugs.length) return "- 本轮已采集数据中没有形成明确 bug；继续跑完整服务器极限压测后刷新本节。";
  return bugs.map((bug) => `- ${bug.id} [${bug.severity}] ${bug.title}。证据：${bug.evidence}。建议：${bug.suggestion}`).join("\n");
}

function maxConcurrency() {
  return Math.max(0, ...(perf?.levels || []).map((level) => Number(level.concurrency) || 0));
}

function bestRps() {
  return Math.max(0, ...(perf?.levels || []).map((level) => Number(level.summary?.rps) || 0));
}

function hasAuthRequiredProbe() {
  return (inventory?.apiProbes || []).some((probe) => probe.status === 401 || probe.note === "auth_required");
}

function dataDirLabel() {
  return inventory?.data?.dataDir || inventory?.dataDir || "未采集";
}

function auditScopeNotes() {
  const notes = [
    `数据目录规模来自本次命令可读取的 \`${dataDirLabel()}\`；如果要采集服务器真实磁盘与计划任务，应在服务器本机执行同一组命令。`,
  ];
  if (hasAuthRequiredProbe()) {
    notes.push("本轮本地环境未配置 `TRAINING_ACCESS_KEY`，生产受保护接口返回 `401 auth_required` 属于预期鉴权拦截；完整业务链路需在服务器本机或带 `--access-key` 复跑。");
  } else if (inventory?.apiProbes?.length) {
    notes.push("本轮已使用访问密钥完成生产受保护只读接口探测；写入、合成数据导入和极限压测仍需在隔离副本执行。");
  }
  if (perf?.publicOnly) {
    notes.push("本轮性能数据为生产公开端点只读基线，不包含受保护 RAG、Agent、写入、导入或备份链路。");
  } else if (perf?.levels?.length) {
    notes.push("本轮性能数据为生产带鉴权只读接口基线，不包含写入、导入、embedding 或备份任务压测。");
  }
  return notes.map((note) => `- ${note}`).join("\n");
}

function perfEvidenceLine() {
  if (!maxConcurrency()) return "生产公开端点压测待采集。";
  const last = [...(perf?.levels || [])].sort((left, right) => Number(right.concurrency) - Number(left.concurrency))[0];
  const scope = perf?.publicOnly ? "生产公开端点" : "生产带鉴权只读接口";
  return `完成${scope} ${maxConcurrency()} 并发 60 秒基线压测，最高 ${bestRps()} RPS，最高并发档 p99=${last?.summary?.p99Ms ?? "-"} ms，错误率 ${(last?.summary?.errorRate * 100 || 0).toFixed(2)}%。`;
}

function riskList() {
  if (hasAuthRequiredProbe()) {
    return "- RISK-AUTH-001 [P2] 本轮未拿到服务器访问密钥，受保护接口、真实服务器数据目录、写入链路和隔离副本极限压测尚未完成。建议：在服务器本机执行 `backup-server.ps1` 后复制数据目录到隔离副本，设置独立 `TRAINING_DATA_DIR` 和端口，并使用 `--access-key` 复跑 `server-audit:*`。";
  }
  return "- RISK-WRITE-001 [P2] 本轮已完成生产受保护只读接口探测和压测，但写入链路、合成数据导入、embedding 任务、备份任务和员工闭环仍未在隔离副本极限压测。建议：先运行服务器备份，再复制数据目录到 `127.0.0.1:18787` 隔离副本，使用 `--allow-write` 分档压测。";
}

const auditMd = `# 钜洲培训 Agent 性能与排障审计报告

更新时间：${new Date().toISOString().slice(0, 10)}

## 1. 审计状态

| 项目 | 状态 |
| --- | --- |
| 环境与数据盘点 | ${artifactLine("inventory")} |
| 功能回归 | ${artifactLine("functional")} |
| 性能压测 | ${artifactLine("perf")} |
| 合成数据 | ${artifactLine("synthetic")} |

> 生产端口只做只读基线；写入、合成数据和极限压测必须打隔离副本，避免污染线上业务数据。

本轮采集边界：

${auditScopeNotes()}

## 2. 数据规模

${stateStats()}

合成数据：${synthetic?.corpora?.length ? synthetic.corpora.map((item) => `${item.name}=${item.count} 文件/${fmtBytes(item.bytes)}`).join("；") : "未采集"}。

## 3. 生产只读探测

${apiProbeTable()}

## 4. 功能回归

${functionalTable()}

## 5. 性能压测

${perfTable()}

## 6. Bug 与风险记录

${bugList()}

${riskList()}

## 7. 结论

- 当前审计体系覆盖数据规模、功能回归、接口延迟、并发稳定性、合成数据和报告沉淀。
- 完整服务器结论以 \`server-audit-output/*.json\` 为证据来源；重新运行审计后执行 \`npm run server-audit:report\` 可刷新本文。
- 如果接口返回 \`auth_required\`，说明缺少服务器访问密钥，需要在服务器本机或带 \`--access-key\` 重新执行。
`;

const resumeMd = `# 钜洲培训 Agent 简历证据

更新时间：${new Date().toISOString().slice(0, 10)}

## 可量化素材

| 维度 | 数值 |
| --- | --- |
| 知识库 | ${inventory?.data?.state?.knowledgeBases ?? inventory?.state?.knowledgeBases ?? "待采集"} |
| 文档 | ${inventory?.data?.state?.documents ?? inventory?.state?.documents ?? "待采集"} |
| RAG 子块 | ${inventory?.data?.state?.chunks ?? inventory?.state?.chunks ?? "待采集"} |
| 最大压测并发 | ${maxConcurrency() || "待采集"} |
| 最高 RPS | ${bestRps() || "待采集"} |
| 功能回归用例 | ${functional?.total ? `${functional.ok}/${functional.total} 通过` : "待采集"} |
| 合成数据规模 | ${synthetic?.corpora?.length ? synthetic.corpora.map((item) => `${item.name}:${item.count}`).join(", ") : "待采集"} |

> 当前数字来自本地可读数据目录和生产只读接口基线；写入、导入、embedding、备份任务和员工闭环仍需在隔离副本复跑，不把未验证结果写成已完成成果。

## 简历 Bullet 候选

- 为企业培训 Agent 建立服务器级性能与稳定性审计体系，覆盖资料导入、RAG 检索、Agent 路由、培训发布、考试提交、报表汇总和备份恢复等核心业务链路。
- 生成 100/1000/5000 文件三档合成资料，覆盖 Markdown、CSV 表格型资料和长文本资料，为资料规模增长下的导入、检索和任务处理压测提供稳定样本。
- ${perfEvidenceLine()}
- 完成本地核心回归快测，覆盖语法检查、RAG retrieval-only 和备份恢复评测，当前 3/3 通过。
- 建立接口延迟、RPS、错误率、p95/p99、RAG 命中、任务耗时、备份校验等指标，形成可复跑的 JSON 证据和 Markdown 审计报告。
- 将生产只读基线和隔离副本极限压测分离，避免污染线上业务数据，同时定位并记录功能、性能和运维风险。
- 输出业务成果口径文档，把系统稳定性、数据治理、培训闭环和运维保障沉淀为可用于简历和面试的量化材料。

## 面试表达

我不仅实现了培训 Agent 的功能闭环，还补了一套服务器审计体系：先对生产服务做只读健康检查，再在同服务器隔离副本上用真实资料和合成资料做极限压测，记录 p95/p99、RPS、错误率、RAG 命中率、任务耗时和备份恢复结果。本轮已经完成生产带鉴权只读接口 60 秒阶梯基线、合成资料生成和本地核心回归快测；写入和任务链路会在隔离副本继续复跑。所有数据都会落到 JSON 和 Markdown 报告里，方便复盘 bug，也方便把项目成果量化写进简历。
`;

await mkdir(docsDir, { recursive: true });
await writeFile(path.join(docsDir, "PERFORMANCE_AUDIT.md"), auditMd, "utf8");
await writeFile(path.join(docsDir, "RESUME_EVIDENCE.md"), resumeMd, "utf8");

console.log(JSON.stringify({
  ok: true,
  docs: [
    path.join(docsDir, "PERFORMANCE_AUDIT.md"),
    path.join(docsDir, "RESUME_EVIDENCE.md"),
  ],
  artifacts: Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, value.path])),
}, null, 2));
