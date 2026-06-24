# 钜洲培训 Agent 性能与排障审计报告

更新时间：2026-06-24

## 1. 审计状态

| 项目 | 状态 |
| --- | --- |
| 生产/隔离环境盘点 | 已采集：`training-service\server-audit-output\remote-inventory-20260625-000343.json` |
| 本地功能回归 | 已采集：`training-service\server-audit-output\functional-20260624-231154.json` |
| 隔离副本读压测 | 已采集：`training-service\server-audit-output\perf-read-20260624-234229.json` |
| 隔离副本写压测 | 已采集：`training-service\server-audit-output\perf-write-20260624-234948.json` |
| 业务闭环 | 已采集：`training-service\server-audit-output\business-flow-20260624-235206.json` |
| 导入与 embedding | 已采集：`training-service\server-audit-output\import-embed-final-20260624-235944.json` |
| 备份恢复 | 已采集：`training-service\server-audit-output\backup-restore-20260624-235259.json` |
| 合成数据 | 已采集：`training-service\server-audit-output\synthetic-20260624-230439.json` |

> 生产端口只做只读基线；写入、合成数据导入、极限压测和恢复演练均在服务器本机 127.0.0.1:18787 隔离副本完成。

## 2. 数据规模

| 指标 | 数值 |
| --- | --- |
| 知识库 | 3 |
| 文档 | 40 |
| 子块 | 634 |
| 任务 | 10 |
| 邀请 | 16 |
| 考试 | 6 |
| 答题记录 | 3 |
| 数据目录文件 | 23 |
| 数据目录大小 | 30.74 MB |
| SQLite/向量/JSONL 等 | sqlite |
| 报表完成率 | 19% |
| 报表平均分 | 42 |

合成数据：small=100 文件/503.93 KB；medium=1000 文件/4.97 MB；large=5000 文件/24.96 MB。

## 3. 受保护接口探测

| 接口 | 状态 | 延迟 | 备注 |
| --- | --- | --- | --- |
| /api/auth/status | 200 | 94 ms | ok |
| /api/health | 200 | 241 ms | ok |
| /api/knowledge-bases | 200 | 107 ms | ok |
| /api/jobs | 200 | 32 ms | ok |
| /api/agent-runs?limit=50 | 200 | 92 ms | ok |

## 4. 功能回归

| 用例 | 结果 | 耗时 | 失败分类 |
| --- | --- | --- | --- |
| check | 通过 | 6107 ms | - |
| eval-rag-retrieval | 通过 | 9352 ms | - |
| eval-backup | 通过 | 770 ms | - |

## 5. 性能压测

| 场景 | 类型 | 并发 | RPS | p95 | p99 | 错误率 | 停止原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| isolated-read | read | 1 | 10.35 | 234 ms | 301 ms | 0.00% | - |
| isolated-read | read | 5 | 16.01 | 762 ms | 802 ms | 0.00% | - |
| isolated-read | read | 10 | 15.31 | 1659 ms | 2320 ms | 0.00% | - |
| isolated-read | read | 20 | 15.41 | 3257 ms | 6231 ms | 0.00% | - |
| isolated-read | read | 50 | 11.49 | 12867 ms | 22570 ms | 1.45% | - |
| isolated-read | read | 100 | 5.19 | 30013 ms | 30015 ms | 35.43% | error_rate>0.1, p99>30000ms |
| isolated-write | write | 1 | 11.01 | 53 ms | 71 ms | 0.00% | - |
| isolated-write | write | 3 | 12.47 | 173 ms | 298 ms | 0.00% | - |
| isolated-write | write | 5 | 8.64 | 335 ms | 368 ms | 0.00% | - |
| isolated-write | write | 10 | 6.78 | 810 ms | 1261 ms | 0.00% | - |
| isolated-write | write | 20 | 5.9 | 1843 ms | 1853 ms | 0.00% | - |

## 6. 业务闭环

| 环节 | 结果 | 耗时/指标 |
| --- | --- | --- |
| RAG 问答 | 通过 | 1518 ms，来源 0 |
| Agent dispatch | 通过 | 1110 ms |
| 发布培训 | 通过 | 17762 ms，邀请 1 |
| 员工答疑 | 通过 | 4379 ms，来源 8 |
| 生成考试 | 通过 | 5037 ms，题目 2 |
| 提交答案 | 通过 | 得分 100，通过 true |
| 报表汇总 | 通过 | 49 ms |

## 7. 导入、Embedding 与备份恢复

### 导入与 Embedding

| 环节 | 结果 | 指标/证据 |
| --- | --- | --- |
| 目录导入 | 通过 | 文件 20，父块 40，子块 40 |
| embedding 任务 | 失败 | fetch failed |
| 导入后健康 | 通过 | 知识库 3，文档 40，chunks 634，retrieval=bm25 |

### 备份恢复

| 环节 | 结果 | 耗时/规模 |
| --- | --- | --- |
| 备份 | 通过 | 3321 ms，4.25 MB，6 文件 |
| 校验 | 通过 | 1047 ms，6 文件 |
| dry-run restore | 通过 | 1028 ms，requiresForce=true |
| throwaway 强制恢复 | 通过 | 1410 ms，tasks=10 |

## 8. Bug 与风险记录

- BUG-PERF-1 [P2] isolated-read read 并发 50 出现超时或触发停止条件。证据：errorRate=0.0145, p99=22570ms, stop=-。建议：排查健康检查内串行外部依赖、Agent Run 查询、SQLite 并发、接口超时和反向代理/隧道排队。先把生产容量口径控制在 20 并发以内。
- BUG-PERF-2 [P1] isolated-read read 并发 100 出现超时或触发停止条件。证据：errorRate=0.3543, p99=30015ms, stop=error_rate>0.1,p99>30000ms。建议：排查健康检查内串行外部依赖、Agent Run 查询、SQLite 并发、接口超时和反向代理/隧道排队。先把生产容量口径控制在 20 并发以内。
- BUG-JOB-3 [P1] 隔离副本 embedding 任务失败。证据：embed status=failed, error=fetch failed。建议：服务器 /api/health 显示 ollamaOk=false、retrievalMode=bm25；需要恢复 Ollama/bge-m3 或配置可用向量后端，再重跑 embed:local。
- BUG-DATA-4 [P2] direct 导入模式未覆盖 CSV 样本。证据：远程样本 30 个文件含 10 个 CSV，direct 导入结果 fileCount=20、tableRowParentCount=0。建议：CSV/XLSX/PDF 使用 clean/auto 清洗模式；报告中不要把 direct 模式写成支持表格导入。

## 9. 结论

- 隔离副本读接口在 20 并发以内 0 错误；50 并发开始出现 1.45% 超时，100 并发错误率升至 35.43% 并触发停止条件。
- 写入链路 boss-chat create/delete 在 1/3/5/10/20 并发均 0 错误，最高 12.47 RPS，20 并发 p99 约 1853 ms。
- 员工培训闭环已跑通：发布、邀请、答疑、生成考试、提交答案、报表汇总全部成功。
- 备份、校验、dry-run restore、throwaway 强制恢复均成功。
- 当前主要短板是 embedding 后端不可用导致新知识库向量重建失败，系统降级为 BM25 检索；高并发读接口在 50+ 并发出现明显排队和超时。
