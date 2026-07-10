# 钜洲培训 Agent

钜洲培训 Agent 是一个面向企业内部资料培训的本地部署系统。它把资料导入、RAG 检索、培训发布、员工学习、答疑、考试、报表、营销软文、记忆、任务中心和运行轨迹串成一个闭环。

项目默认可以独立运行；OpenClaw Gateway 和 OpenClaw 插件只是兼容集成入口，不是默认运行依赖。

仓库修改默认只在本机完成并推送 GitHub，不会连接、探测、更新或重启服务器。只有用户在当前任务明确授权部署时，才执行服务器操作；部署说明本身不代表代码会自动上线。

## 快速启动

```powershell
cd D:\juzhou-agent\peixun\training-service
npm install
npm start
```

默认访问：

```text
http://127.0.0.1:8787/
```

主要页面：

- `/`：老板端聊天和内部 skill。
- `/imports`：知识库导入、质量和版本差异。
- `/jobs`：异步导入、embedding、回滚任务中心。
- `/traces`：Agent Run、脱敏 Trace 和近 24 小时可观测指标。
- `/t/{inviteToken}`：员工学习、答疑和考试。

## 核心能力

- 老板端自然语言创建培训草稿、确认发布、生成员工学习链接。
- 老板端聊天历史已按 `boss-default` 账号服务端持久化，同一服务数据目录下跨浏览器/电脑可见；列表按最后一条真实消息的 `lastMessageAt` 倒序，旧元数据会按消息记录重算，`updatedAt` 只表示会话元数据更新时间。
- 老板端意图路由以快速 LLM Router 为优先入口，规则主要负责确认门禁、兜底和 RAG 证据校验。
- 老板端提到已导入资料相关内容时，先由 Router 判断答疑意图，再通过知识库别名、会话上下文和 RAG 命中校验选择资料库并展示来源片段。
- 老板端支持多语言翻译 skill，可从明确正文、末尾翻译指令或上一条老板端正文中提取待翻译内容；“生成英文文章并附中文翻译”仍归为软文生成，不抢到翻译 skill。
- 员工端查看讲义、提问、生成考试、提交答案。
- 员工邀请 token 是员工端能力凭证；启用老板访问密钥后，员工仍可凭有效 token 完成学习闭环，无效或过期 token 会被拒绝。
- 基于本地知识库生成营销软文，不保存文章记录；生成 prompt 已约束减少通用 AI 模板感、空泛套话和夸大表达。
- 本地记忆用于普通聊天连续性和低风险默认偏好。
- 快速 LLM Router、确认卡片、Tool Registry 和 Agent Run 轨迹用于减少误判。
- 知识库支持目录导入、上传导入、异步任务、版本差异和上一版回滚。
- RAG 使用 BM25 + 本地向量 hybrid + parent-child 上下文，并可通过独立 `bge-reranker-v2-m3` 服务重排；reranker 或向量不可用时自动回退，不中断答疑。
- Agent Run 记录脱敏的 token、成本估算、TTFT、工具成功率、检索证据命中率和检索/rerank 延迟；OpenTelemetry OTLP 导出可选且默认关闭。

## 数据目录

仓库只放代码和文档，运行数据默认在仓库外：

```text
D:\juzhou-agent\data
├── training-index\        # SQLite、JSONL、向量索引、备份
│   └── boss-chat-sessions.json  # JSON 回滚模式下的老板端聊天历史
├── training-clean\        # 清洗后的知识库资料
├── training-vision\       # PDF 页面渲染和视觉补充资料
└── qdrant\                # 可选 Qdrant 数据，不是轻量部署默认项
```

可用环境变量覆盖：

```text
TRAINING_DATA_ROOT=D:\juzhou-agent\data
TRAINING_DATA_DIR=D:\juzhou-agent\data\training-index
```

项目不再依赖 `D:\OpenClawData`。如果文档中需要提到旧路径，只应放在迁移或兼容说明里。

## 大模型与检索

普通聊天、讲义、出题、软文和多语言翻译默认走 OpenAI-compatible API，当前推荐 DeepSeek：

```env
TRAINING_LLM_PROVIDER=auto
TRAINING_LLM_BASE_URL=https://api.deepseek.com/v1
TRAINING_LLM_MODEL=deepseek-chat
TRAINING_LLM_API_KEY=...
```

兼容变量仍可使用：

```env
DEEPSEEK_API_KEY=...
OPENAI_API_KEY=...
```

OpenClaw Gateway 只在显式设置时启用：

```env
TRAINING_LLM_PROVIDER=openclaw
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
```

没有可用大模型 API 时，系统不会假装生成讲义、试题、软文或翻译结果，而是返回配置缺失或调用失败的明确错误。意图路由可使用快速 LLM Router；本地规则只作为高风险安全门禁、服务不可用兜底和知识库/RAG 证据校验，不再作为业务意图的首选解释器。

轻量服务器建议使用本地向量索引：

```powershell
cd D:\juzhou-agent\peixun\training-service
npm run embed:local -- --full
```

服务器可只运行 Ollama `bge-m3` 做 query embedding，资料侧复用已生成的 `vector-index-bge-m3.json`。Qdrant 仍保留为可选方案，适合数据量或并发更高的场景。

可选 GPU reranker 通过 HTTP 接入；API key 只放在未跟踪环境文件中：

```env
TRAINING_RERANKER_ENABLED=1
TRAINING_RERANKER_URL=http://192.168.9.105:8910
TRAINING_RERANKER_API_KEY=...
TRAINING_RERANKER_MODEL=BAAI/bge-reranker-v2-m3
TRAINING_RERANKER_TIMEOUT_MS=15000
TRAINING_RERANKER_CANDIDATES=20
TRAINING_RERANKER_WEIGHT=0.75
```

2026-07-10 至 2026-07-11 的专用 GPU 主机规模基准覆盖 100/1000/5000 个 Markdown 文件。把导入、全量 embedding、资源峰值、质量、错误和模式降级一起纳入门槛后，最大严格通过档位是 100 文件/并发 20。仅看 5 次预热后的查询层，5000 文件 BM25 在并发 20 时 Hit@3=100%、p95=22 ms；hybrid+reranker 在并发 5 时 Hit@3=100%、p95=1668 ms 且无降级，并发 10 虽 p95=3271 ms 但出现 1 次回退，不能计作纯重排容量。完整矩阵、限制和失败样本见 [docs/RAG_BENCHMARK.md](docs/RAG_BENCHMARK.md)。这些数据不是现有培训生产服务器的实时状态。

成本单价不写死在代码中，应按供应商当前价格给环境变量配置带日期的快照；未配置时 token 和时延仍记录，成本显示为“无数据”。OpenTelemetry 默认关闭，即使没有 collector，本地 Run 指标仍完整可用。

## 资料导入

网页导入入口是 `/imports`。第一版支持本机目录导入和浏览器上传，导入任务会进入 `/jobs`，成功后可自动创建本地向量索引任务。

命令行入口保留：

```powershell
cd D:\juzhou-agent\peixun\training-service
npm run clean:raw
npm run import:clean
npm run embed:local -- --full
```

图片型 PDF 的当前处理方式是：

```text
render:pdf 渲染页面图片
-> 人工式视觉识别整理 Markdown
-> 重新导入知识库
-> embed:local 重建本地向量索引
```

这个流程不调用外部 OCR API，也不运行 Tesseract/PaddleOCR。看不清或无法确认的参数不要编造。
型号参数表类资料按“系列 -> 型号 -> 参数行”整理成结构化 Markdown，例如银嘉泵目录补充文件 `visual-pump-model-tables.md`。服务器同步这类资料时优先在服务器重新导入并执行 `npm run embed:local -- --full`，避免本地和服务器 chunk id 不一致。

项目文档和面试 QA 使用 Markdown 维护，桌面 QA 镜像与仓库版本保持同步。

## 备份与恢复

运行数据备份命令：

```powershell
cd D:\juzhou-agent\peixun\training-service
npm run backup:data
npm run backup:data -- --retention-days 14 --keep-last 10
npm run backup:verify -- --from D:\juzhou-agent\data\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip
npm run restore:data -- --from D:\juzhou-agent\data\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip --force
```

保留策略只会清理带有钜洲备份 manifest 的 ZIP，不会删除同目录下其他压缩包。恢复前应停止服务；恢复脚本会校验 ZIP，并在覆盖前自动生成当前数据的安全备份。

## 打包部署

Windows 便携包：

```powershell
cd D:\juzhou-agent\peixun
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1
```

服务器包：

```powershell
cd D:\juzhou-agent\peixun
powershell -ExecutionPolicy Bypass -File .\scripts\package-server.ps1
```

Windows Server 当前推荐用计划任务长期运行：

- 主任务 `JuzhouAgentTraining` 运行 `start-server.ps1`，`ExecutionTimeLimit=PT0S`，避免 72 小时后被任务计划程序终止。
- 守护任务 `JuzhouAgentTrainingWatchdog` 每 5 分钟检查 `8787`、首页和 `/api/health`；未带访问密钥的 `/api/health` 返回 `401` 仍视为服务存活。
- 备份任务 `JuzhouAgentTrainingBackup` 可每天运行 `backup-server.ps1`，默认生成备份后校验，并保留 14 天且至少保留最近 10 份。
- 运行日志在部署目录的 `logs\server.log`，守护日志在 `logs\watchdog.log`，备份日志在 `logs\backup.log`；`start-server.ps1` 追加日志并记录 Node 路径、关键环境变量摘要和退出码。

更细的部署说明见：

- [training-service/README.md](training-service/README.md)
- [deploy/server/README-server.md](deploy/server/README-server.md)

`192.168.9.105` 只承载本次明确授权的专用 Reranker 和隔离 benchmark，不是培训生产服务器。benchmark 完成后回收项目副本、合成语料、临时数据库/索引、Ollama 模型和缓存，只保留 Reranker 服务所需文件与轮转日志。

## 常用验证

```powershell
cd D:\juzhou-agent\peixun\training-service
npm run check
npm run smoke
npm run eval:rag -- --retrieval-only
npm run eval:reranker
npm run eval:observability
npm run eval:tool-observability
npm run eval:answer-evidence-gate
npm run eval:bm25-cache
npm run eval:rag-scale-benchmark
npm run eval:intent
npm run eval:memory
npm run eval:agent-trajectory
npm run eval:traces
npm run eval:sqlite
npm run eval:concurrency
npm run eval:backup
npm run eval:import
npm run eval:import-lifecycle
npm run eval:jobs
npm run eval:http-security
npm run eval:boss-chat
npm run eval:translation
npm run eval:kb-versions
npm run benchmark:rag-scale -- --sizes=100,1000,5000
git diff --check
```

文档-only 改动通常至少跑 `npm run check` 和 `git diff --check`。
RAG fixture 共 150 条，按 120 条开发/回归集和 30 条冻结测试集分层，另有 60 条真实答案质量子集；Agent trajectory 共 30 条。`npm run eval:rag -- --retrieval-only` 会忠实反映当前环境：Ollama 关闭时是 BM25 降级验证，不应冒充 hybrid 质量验收；hybrid 和 hybrid+reranker 验收必须确认对应运行状态后再检查 Hit@K、MRR、nDCG、拒答与降级门槛。规模 benchmark 的 v2 artifact 还会记录 requested/effective mode 和降级原因，任何 semantic/reranker fallback 都不能计作原模式成功。

服务器审计属于显式授权的独立运维流程，证据和日期统一记录在 [docs/PERFORMANCE_AUDIT.md](docs/PERFORMANCE_AUDIT.md)，不作为本地代码修改的默认步骤。

## 文档索引

- [training-service/README.md](training-service/README.md)：服务运行、API、导入、检索、部署和验证命令。
- [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md)：架构总览、数据流、风险和路线图。
- [docs/Agent项目面试QA.md](docs/Agent项目面试QA.md)：中文面试问答，按真实项目实现整理。
- [docs/PERFORMANCE_AUDIT.md](docs/PERFORMANCE_AUDIT.md)：服务器性能、数据规模、回归结果和 bug 排查记录。
- [docs/RAG_BENCHMARK.md](docs/RAG_BENCHMARK.md)：100/1000/5000 文件 RAG 三路检索规模基准、容量边界和原始失败证据。
- [docs/RESUME_EVIDENCE.md](docs/RESUME_EVIDENCE.md)：可改写进简历的业务成果和量化证据。
- [training-service/LLM_CONFIG.md](training-service/LLM_CONFIG.md)：LLM Provider 与 OpenClaw Gateway 兼容说明。
- [training-plugin/README.md](training-plugin/README.md)：OpenClaw 插件的 8 个 training tool。
