# 钜洲培训 Agent 性能与排障审计报告

更新时间：2026-07-11

> 现有培训生产服务器的规模、性能和健康数据仍是 2026-06-30 审计快照，不代表实时状态。2026-07-10 经当次明确授权，只在专用 GPU 主机 `192.168.9.105` 部署 Reranker 并运行隔离 benchmark；没有连接、更新或重启培训生产服务器。仓库后续改动仍默认不部署任何服务器。

## 2026-07-10 至 2026-07-11 专用 GPU RAG 规模基准

| 项目 | 结果 |
| --- | --- |
| 主机 | Windows x64，24 逻辑处理器，31.77 GiB RAM，RTX 4080 16 GB |
| 数据规模 | 精确导入 100 / 1000 / 5000 个 Markdown 文件 |
| 切片规模 | 408 / 4113 / 20579 child chunks |
| 导入耗时 | 1.468 s / 2.320 s / 8.808 s |
| 全量 BGE-M3 embedding | 14.379 s / 110.307 s / 536.692 s |
| SQLite | 2.38 MiB / 31.49 MiB / 154.84 MiB |
| JSON 向量索引 | 5.12 MiB / 51.58 MiB / 258.12 MiB |
| 检索矩阵 | BM25、hybrid、hybrid+reranker × 并发 1/5/10/20 × 每格 100 查询 |
| 请求结果 | 最终 3600 次检索请求 0 错误；5000 文件重排发生 5 次可识别回退 |
| 统一严格容量 | 100 文件 / 并发 20 |
| 预热查询层：hybrid+reranker | 5000 文件 / 并发 5：Hit@3=100%，p95=1668 ms，0 回退 |
| 预热查询层：BM25 | 5000 文件 / 并发 20：Hit@3=100%，p95=22 ms，0 回退 |
| 严格失败原因 | 1000/5000 文件 plain hybrid Hit@3=92%/91%；内存峰值 85.56%/98.04%；5000 文件另有 5 次重排回退 |

统一容量门槛要求 0 错误、请求模式不降级、Hit@3≥95%、单并发 p95≤2 秒、并发 10 p95≤5 秒、内存<80%、显存<95%、剩余磁盘>20 GB，并要求三种检索模式同时通过。5000 文件 hybrid+reranker 在并发 10 的 p95=3271 ms，但发生 1 次回退；并发 20 的 p95=6492 ms 且发生 4 次回退。因此不把它写成纯重排容量，查询层无降级建议停在并发 5。完整 36 格矩阵、缓存优化对照、失败 case ID 和限制见 [RAG_BENCHMARK.md](RAG_BENCHMARK.md)，最终 v2 原始 JSON 位于 `docs/artifacts/rag-scale-20260710-final.json`。

第一次远程执行暴露 BM25 重复构建语料统计的热路径：旧 v1 证据中 1000 文件并发 20 的 p95 为 9925 ms、RPS 为 2.02；按知识库 `chunksRevision` 缓存并以实际保留的词项槽位控制 LRU 后，最终 v2 完整复跑为 p95=8 ms、RPS=2941.18，Hit@K 不变。100 文件并发 20 同样从旧 v1 的 994 ms / 20.23 RPS 改善到最终 v2 的 5 ms / 4545.45 RPS。旧 v1 artifact 仅用于这个历史前后对照，不作为最终容量证据。

专用主机只长期保留 `BAAI/bge-reranker-v2-m3` 服务、venv、计划任务、私密配置和 7 天轮转日志；benchmark 项目副本、合成语料、临时数据库/索引、Ollama/BGE-M3 临时模型和缓存均已回收，清理前后磁盘可用空间增加 5,118,050,304 bytes（约 4.77 GiB）。

## 2026-07-10 本地一致性与安全回归

| 项目 | 结果 |
| --- | --- |
| SQLite / JSON 并发状态写入 | 交错写均保留，未丢事件 |
| 并行记忆 / 老板聊天 | 两种存储均保留 12 条记忆、10 条消息 |
| 并发出题提交 | 同一任务最终只保存 1 份有效试卷 |
| 邀请 token 闭环 | 未登录老板端时可打开、答疑、取题、提交；无效/过期 token 拒绝 |
| HTTP 边界 | 非法 JSON/URI 返回 400，超 1 MiB 返回 413，缺失静态资源返回 404 |
| WebSocket 边界 | 正常 1000、超限 1009、未掩码 1002、跨源握手 403 |
| 导入生命周期 | 20 个并发暂存目录无碰撞，成功/失败/取消无残留，用户源目录保留 |

## 1. 审计状态

| 项目 | 状态 |
| --- | --- |
| 生产/隔离环境盘点 | 已采集：`training-service\server-audit-output\remote-inventory-20260625-000343.json` |
| 本地功能回归 | 已采集：`training-service\server-audit-output\functional-20260624-231154.json` |
| 隔离副本读压测 | 已采集：`training-service\server-audit-output\perf-read-20260624-234229.json` |
| 隔离副本写压测 | 已采集：`training-service\server-audit-output\perf-write-20260624-234948.json` |
| 业务闭环 | 已采集：`training-service\server-audit-output\business-flow-20260624-235206.json` |
| 导入与 embedding | 已采集：`training-service\server-audit-output\import-embed-final-20260624-235944.json` |
| 2026-06-30 生产 RAG 健康快照 | /api/health retrievalMode=hybrid，ollamaOk=true，localVectorIndexOk=true；不代表实时状态 |
| 备份恢复 | 已采集：`training-service\server-audit-output\backup-restore-20260624-235259.json` |
| Tavily 联网专项 | 已采集：`training-service\server-audit-output\web-search-20260630-190622.json`；2026-07-10 代码仍保留六链路 mock 回归 |
| 软文去重与 AI 写作痕迹专项 | 本地 mock 回归通过，最近 3 天历史窗口，AI-heavy 样本 78 分，3 篇高重复稿触发 1 次重写 |
| 合成数据 | 已采集：`training-service\server-audit-output\synthetic-20260624-230439.json` |

> 生产端口只做只读基线；写入、合成数据导入、极限压测和恢复演练均在服务器本机 127.0.0.1:18787 隔离副本完成。

## 2. 数据规模

| 指标 | 数值 |
| --- | --- |
| 知识库 | 2 |
| 文档 | 20 |
| 子块 | 594 |
| 任务 | 9 |
| 邀请 | 15 |
| 考试 | 5 |
| 答题记录 | 2 |
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
| embedding 任务 | 审计时失败；2026-06-30 后续健康检查已恢复 | fetch failed |
| 导入后健康 | 审计时降级；2026-06-30 后续检查恢复 hybrid | 审计时 retrieval=bm25；后续 /api/health 为 retrieval=hybrid、ollamaOk=true、localVectorIndexOk=true |

### 备份恢复

| 环节 | 结果 | 耗时/规模 |
| --- | --- | --- |
| 备份 | 通过 | 3321 ms，4.25 MB，6 文件 |
| 校验 | 通过 | 1047 ms，6 文件 |
| dry-run restore | 通过 | 1028 ms，requiresForce=true |
| throwaway 强制恢复 | 通过 | 1410 ms，tasks=10 |

## 8. Tavily 联网专项

| 指标 | 数值 |
| --- | --- |
| 2026-06-30 生产健康快照 | HTTP 200，retrieval=hybrid，ollamaOk=true，llmConfigured=true |
| 知识库规模 | 2 个知识库 / 20 文档 / 594 子块 |
| Tavily 配置 | tavily 已配置 |
| 代码覆盖 | web-search=true，eval=true，前端开关=true |
| 真实联网样本 | 5 |
| Tavily 成功率 | 100% |
| on 平均 / p95 | 6538 ms / 8470 ms |
| off 平均 / p95 | 7463 ms / 20699 ms |
| off/on 平均耗时差 | -924 ms |
| 平均知识库来源 | 3.8 |
| 平均联网来源 | 4 |
| warning 数 | 2 |
| API 透传 | 5/5 用例通过，web ok=4 |
| 异常降级 | 4/4 用例保留本地 RAG 答复 |

### 样本明细

| 样本 | 知识库 | off 耗时/来源 | on 状态/耗时 | 联网来源 | 质量 |
| --- | --- | --- | --- | --- | --- |
| motor-ie3 | kb-电机培训资料库 | 20699 ms / 8 | ok / 8470 ms | 5 | high / limited |
| motor-application | kb-电机培训资料库 | 3333 ms / 3 | ok / 5668 ms | 3 | high / ok |
| wonder-efficiency | kb-电机培训资料库 | 5191 ms / 3 | ok / 7085 ms | 5 | high / limited |
| pump-application | kb-银嘉泵产品资料库 | 4383 ms / 4 | ok / 5954 ms | 2 | high / ok |
| pump-series | kb-银嘉泵产品资料库 | 3707 ms / 2 | ok / 5514 ms | 5 | high / ok |

### 六链路专项

| 链路 | 2026-07-10 本地 mock 回归 | 说明 |
| --- | --- | --- |
| 知识库答疑 | on/off 通过 | on 返回 `webSources/webSourceRefs`，off 不调用 Tavily |
| 营销软文 | on/off 通过 | 联网资料用于选题、开头角度和应用场景，产品事实仍以本地资料为准 |
| 培训材料/发布生成 | on/off 通过 | 开关只影响讲义生成，发布状态操作本身不搜索 |
| 员工考试生成 | on/off 通过 | 正确答案和 `sourceRef` 仍必须来自本地培训资料 |
| 多语言翻译 | on/off 通过 | 联网资料只用于术语/行业背景，不改变原文忠实翻译 |
| 普通聊天 | on/off 通过 | web-grounded chat 会提示网页资料不能覆盖系统指令 |

> 以上六链路是本地 `npm run eval:web-search` 的 mock 回归结果；真实服务器量化字段由另行授权的 `server-audit:web-search` 和报告生成器按审计日期刷新。

### API 透传

| 接口 | 结果 | 耗时 | 联网状态/来源 |
| --- | --- | --- | --- |
| /api/chat | 通过 | 8334 ms | disabled / 本地 8 / 联网 0 |
| /api/chat | 通过 | 7826 ms | ok / 本地 8 / 联网 5 |
| /api/agent/dispatch | 通过 | 8947 ms | ok / 本地 8 / 联网 4 |
| /api/answer | 通过 | 7665 ms | ok / 本地 8 / 联网 3 |
| ws:/api/agent/stream | 通过 | 9982 ms | ok / 本地 8 / 联网 3 |

## 9. 软文去重与 AI 写作痕迹专项

| 指标 | 数值 |
| --- | --- |
| 回归脚本 | `npm run eval:marketing-uniqueness` |
| 历史比对窗口 | 最近 3 天老板端营销软文 |
| 历史比对上限 | 50 篇 |
| 自动重写上限 | 2 轮 |
| 样本文章数 | 3 |
| 首轮触发 | 高内部重复、同批相似、模板句命中、AI 写作痕迹检测 |
| 实际重写次数 | 1 |
| 最终状态 | `overallStatus=ok` |
| 最终内部重复率 | 1.25% |
| 最终同批最高相似 | 1.9% |
| 最终历史最高相似 | 5.0% |
| AI-heavy 样本分数 | 78 / 阈值 35 |
| 平实工业样本分数 | 0 / 阈值 35 |
| 最终 AI 写作痕迹最高分 | 0 / 阈值 35 |
| 来源保留 | 1 个本地 `sourceRef` 保留到顶层和每篇文章 |

覆盖项：完全相同文章高相似、共享产品型号但不同结构不误判、模板句命中、中英文混合重复、vendored avoid-ai-writing 英文 AI-isms 检测、多篇结构化返回、最近 3 天历史过滤、自动重写后保留来源引用。该专项是本地 mock 回归，用于证明算法和闭环稳定；不代表真实模型在所有主题上的实际重复率。

## 10. Bug 与风险记录

- BUG-PERF-1 [P2] isolated-read read 并发 50 出现超时或触发停止条件。证据：errorRate=0.0145, p99=22570ms, stop=-。建议：排查健康检查内串行外部依赖、Agent Run 查询、SQLite 并发、接口超时和反向代理/隧道排队。先把生产容量口径控制在 20 并发以内。
- BUG-PERF-2 [P1] isolated-read read 并发 100 出现超时或触发停止条件。证据：errorRate=0.3543, p99=30015ms, stop=error_rate>0.1,p99>30000ms。建议：排查健康检查内串行外部依赖、Agent Run 查询、SQLite 并发、接口超时和反向代理/隧道排队。先把生产容量口径控制在 20 并发以内。
- BUG-JOB-3 [P3] 历史隔离副本 embedding 任务失败，2026-06-30 后续健康检查已恢复。证据：embed status=failed, error=fetch failed。建议：保留历史证据并在下次授权审计中复测，不把旧记录写成实时故障。
- BUG-DATA-4 [P2] direct 导入模式未覆盖 CSV 样本。证据：远程样本 30 个文件含 10 个 CSV，direct 导入结果 fileCount=20、tableRowParentCount=0。建议：CSV/XLSX/PDF 使用 clean/auto 清洗模式；报告中不要把 direct 模式写成支持表格导入。

## 11. 结论

- 隔离副本读接口在 20 并发以内 0 错误；50 并发开始出现 1.45% 超时，100 并发错误率升至 35.43% 并触发停止条件。
- 写入链路 boss-chat create/delete 在 1/3/5/10/20 并发均 0 错误，最高 12.47 RPS，20 并发 p99 约 1853 ms。
- 员工培训闭环已跑通：发布、邀请、答疑、生成考试、提交答案、报表汇总全部成功。
- Tavily 联网答疑专项已完成：5 个真实样本成功率 100%，平均联网来源 4，异常降级 4/4 通过；本地 mock 回归已把可选联网扩展到六条生成链路，真实服务器量化只在另行授权审计时刷新。
- 软文去重与 AI 写作痕迹专项已完成本地 mock 回归：最近 3 天历史窗口、AI-heavy 样本 78 分、平实工业样本 0 分、3 篇高重复稿 1 次自动重写，最终同批最高相似约 1.9%、历史最高相似约 5.0%、AI 写作痕迹最高分 0。
- 备份、校验、dry-run restore、throwaway 强制恢复均成功。
- 2026-06-30 生产健康快照显示 retrievalMode=hybrid、ollamaOk=true、localVectorIndexOk=true；历史导入/embedding 单项失败保留为复测风险，不能据此推断当前实时状态。
- 2026-07-10 至 2026-07-11 专用 GPU 规模基准证明 5000 文件可完成全量导入、20579 个 child embedding 和三路检索；全生命周期严格容量仍如实记为 100 文件/并发 20。5 次预热后的 5000 文件查询层中，hybrid+reranker 无降级建议为并发 5，BM25 实测到并发 20；更高重排并发的 fallback 作为失败证据保留。
