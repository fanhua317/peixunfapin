# 钜洲培训 Agent Service

`training-service` 是项目主服务，使用 Node.js 原生 HTTP 和无构建 ES modules 前端。它负责老板端聊天、员工学习页、知识库导入、RAG 检索、培训/考试闭环、营销软文、本地记忆、任务中心和运行轨迹。

## 运行

```powershell
cd D:\juzhou-agent\peixun\training-service
npm install
npm start
```

默认端口是 `8787`：

```text
http://127.0.0.1:8787/
```

常用页面：

- `/`：老板端聊天。
- `/imports`：导入管理、知识库质量、版本差异和回滚入口。
- `/jobs`：异步任务中心。
- `/traces`：Agent Run / Trace 可视化。
- `/t/{inviteToken}`：员工端学习、答疑和考试。

## 数据与存储

默认数据在仓库外：

```text
D:\juzhou-agent\data\training-index
├── training.db                  # 默认业务状态和本地记忆
├── conversation-history.jsonl   # 聊天历史追加日志
├── boss-chat-sessions.json      # JSON 回滚模式下的老板端会话历史
├── agent-traces.jsonl           # 脱敏路由 trace
├── agent-runs.jsonl             # JSON 回滚模式下的 run 记录
├── jobs.json                    # JSON 回滚模式下的任务队列
├── vector-index-bge-m3.json     # 本地向量索引
└── backups\                     # 运行数据备份
```

关键环境变量：

```env
TRAINING_DATA_ROOT=D:\juzhou-agent\data
TRAINING_DATA_DIR=D:\juzhou-agent\data\training-index
TRAINING_STORAGE=sqlite
TRAINING_SQLITE_PATH=D:\juzhou-agent\data\training-index\training.db
TRAINING_ACCESS_KEY=...
TRAINING_BACKUP_RETENTION_DAYS=14
TRAINING_BACKUP_KEEP_LAST=10
```

SQLite 是默认主存储；JSON 模式只作为兼容和回滚：

```env
TRAINING_STORAGE=json
```

`state.json` 的 `meta.version` 继续保持 `1`，但它不再是默认主存储。

老板端聊天历史随服务 schemaVersion `5` 保存到 SQLite 的 `boss_chat_sessions` / `boss_chat_messages`；JSON 回滚模式使用 `boss-chat-sessions.json`。当前账号口径固定为 `boss-default`，同一服务和数据目录下的不同浏览器或电脑应看到同一批老板端会话。会话列表按最后一条真实消息的 `lastMessageAt` 倒序；服务会按消息记录修复旧的 `lastMessageAt` 污染，`updatedAt` 只表示标题、预览、删除状态等元数据更新时间，不参与排序。

## LLM 配置

默认走 OpenAI-compatible API，当前推荐 DeepSeek：

```env
TRAINING_LLM_PROVIDER=auto
TRAINING_LLM_BASE_URL=https://api.deepseek.com/v1
TRAINING_LLM_MODEL=deepseek-chat
TRAINING_LLM_API_KEY=...
```

兼容变量：

```env
DEEPSEEK_API_KEY=...
OPENAI_API_KEY=...
```

只有显式设置 `TRAINING_LLM_PROVIDER=openclaw` 时才走 OpenClaw Gateway。详见 [LLM_CONFIG.md](LLM_CONFIG.md)。

没有可用大模型 API 时，普通聊天、翻译和生成类任务会返回明确错误；系统不会用模板假装生成讲义、试题、软文或翻译结果。意图路由当前以快速 LLM Router 为优先入口；本地规则用于高风险动作确认、Router 不可用兜底和 RAG 证据校验。

## 意图路由、软文和知识库答疑

老板端 `/api/agent/dispatch` 会优先把用户输入交给快速 LLM Router 判定 skill。规则层不再作为业务意图的首选解释器，而是保留三类职责：

- 删除、发布、回滚、恢复、清空记忆等高风险动作必须确认。
- Router 不可用或低置信时兜底到普通聊天或确认卡片。
- 知识库答疑和软文生成必须经过知识库选择与 RAG 命中校验，避免“水泵”问题误选电机资料库。

软文请求如“请帮我生成三篇水泵的宣传文章，500词左右，英文”和“请帮我生成三篇英文文章，同时附带中文翻译”都应进入 `generate_marketing_article`；后者的“中文翻译”是文章交付要求，不是 `translate_text`。资料问题如“请帮我检索 CM2 的相关知识”应进入 `answer_knowledge_question` 并选择银嘉泵/水泵知识库；水泵问答后的“有具体型号吗”追问也应沿用同一资料库。

## 多语言翻译 skill

老板端 Agent 支持把明确翻译请求路由到多语言翻译 skill。翻译 skill 只处理“把已有文本翻译成目标语言”的请求，不抢“生成文章并附翻译”这类内容生成任务。常见入口包括：

- `翻译成英文：这是一个电机培训系统`
- `翻译成英文：这是一台水泵`
- `把 hello 翻译成中文`
- `translate to Spanish: high efficiency motor`
- `翻译一下：high efficiency motor`
- `这段长正文 ... 翻译成英文`

响应契约：

```json
{
  "action": "translation",
  "targetLanguage": "英文",
  "sourceText": "这是一个电机培训系统",
  "translatedText": "This is a motor training system."
}
```

默认目标语言规则是：英文正文默认翻译成中文，中文正文默认翻译成英文。只说“翻译成法语”但当前请求和老板端上一条正文都没有可用文本时，返回：

```json
{
  "action": "translation_request",
  "targetLanguage": "法语",
  "message": "请提供要翻译的正文。"
}
```

如果同一 `sessionId` 的老板端历史里上一条正文可用，“翻译成法语”应复用上一条正文作为 `sourceText`。翻译 turn 会和其他老板端 Agent 请求一样写入 `/api/boss-chat/sessions/:sessionId`，助手消息的 `action` 为 `translation`。

翻译输入不会再被静默截断；默认单次原文上限为 `TRAINING_TRANSLATION_MAX_SOURCE_CHARS=30000`，超过上限会返回 `translation_request`，提示分段发送或调整环境变量。

缺少 `TRAINING_LLM_API_KEY`、`DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY` 时，翻译 skill 返回 `action: "translation"` 和清晰 `error`，不生成伪翻译。

## 资料导入

网页导入管理页 `/imports` 支持：

- 本机目录导入。
- 浏览器上传 `.pdf`、`.xlsx`、`.csv`、`.md`、`.txt`。
- 知识库质量检查。
- 当前版/上一版差异查看。
- 通过任务中心执行回滚。

命令行入口：

```powershell
npm run clean:raw
npm run import:clean
npm run eval:import
```

导入成功后会写入 `knowledgeBases`、`documents`、`chunkParents`、`chunks`。同名知识库覆盖时只替换知识库资料，不删除培训任务、邀请、考试、记忆、Trace 或 Jobs。

## RAG 与向量索引

主检索路径：

```text
用户问题
-> BM25 子块召回
-> 可用时做 bge-m3 向量召回
-> 融合排序
-> parent-child 展开
-> 将父块上下文交给讲义、答疑、出题或软文生成
```

老板端聊天的主路由由快速 LLM Router 先判断是否需要 `answer_knowledge_question`。随后规则层只做知识库别名、会话上下文和 RAG 命中校验：例如 CM2、水泵、银嘉泵应选择银嘉泵/水泵资料库；“这是水泵，不是电机”不能落到电机资料库。通过校验后返回 `knowledge_answer`、知识库名、检索模式、来源和命中片段。用户在确认卡片里选择“当普通聊天”时，前端会向 `/api/chat` 传 `forceGeneralChat: true`，后端跳过自动知识库探测。

本地向量索引推荐命令：

```powershell
npm run embed:local -- --full
npm run embed:local -- --kb=kb-电机培训资料库
```

轻量服务器建议上传匹配当前 `chunks` / `chunkParents` 的 `vector-index-bge-m3.json`，服务器只运行 Ollama `bge-m3` 做 query embedding。Qdrant 仍保留为可选后端，适合数据量或并发更高的部署。

相关变量：

```env
TRAINING_HYBRID_RETRIEVAL=auto
TRAINING_VECTOR_BACKEND=local
TRAINING_EMBEDDING_MODEL=bge-m3
OLLAMA_URL=http://127.0.0.1:11434
TRAINING_RAG_EMBEDDING_TIMEOUT_MS=12000
```

向量服务或索引不可用时，服务会回退 BM25；不会因为语义检索离线而让培训和答疑完全不可用。

## 图片型 PDF 处理

当前不接外部 OCR，也不运行 Tesseract/PaddleOCR。可读图片型 PDF 的补充流程是：

```text
npm run render:pdf
-> 查看页面图片
-> 人工式视觉识别整理成 Markdown
-> import:clean 重新导入
-> embed:local 重建向量索引
```

已处理过的电机资料包括 `YINJIA motor catalog-2025.10.pdf`、`电机1-4.pdf` 和电机 3D 爆炸图。银嘉泵目录中的型号表按“系列 -> 型号 -> 参数行”整理到 `visual-pump-model-tables.md`，用于 VM、QB、WZB、CPM、SCM 等型号级检索。看不清的参数必须留空或标注不确定，不允许编造。

服务器同步视觉补全资料时，推荐上传 clean 目录后在服务器重新导入并执行：

```powershell
npm run import:clean -- <clean-dir> "银嘉泵产品资料库" "银嘉泵,水泵,YINJIA Pump,YINJIA"
npm run embed:local -- --full
```

不要直接上传本地向量索引覆盖服务器索引，除非确认两边的 `chunks` / `chunkParents` 完全一致。

## 任务中心与 Trace

异步任务覆盖：

- 知识库目录导入。
- 浏览器上传导入。
- 本地向量索引重建。
- 知识库上一版回滚。

接口：

```text
GET  /api/jobs
GET  /api/jobs/:jobId
POST /api/jobs/:jobId/cancel
POST /api/jobs/import/directory
POST /api/jobs/import/upload
POST /api/jobs/embed
POST /api/jobs/knowledge-bases/:kbId/rollback
```

Trace 和 Agent Run 只保存脱敏摘要、消息预览、hash、意图、skill、耗时、错误和 step 时间线，不保存完整密钥或完整模型输出。

## 备份与恢复

运行数据备份：

```powershell
npm run backup:data
npm run backup:data -- --retention-days 14 --keep-last 10
npm run backup:verify -- --from D:\juzhou-agent\data\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip
npm run restore:data -- --from D:\juzhou-agent\data\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip --force
```

备份包含 `training.db` 快照、JSONL、向量索引和导出的 `state.json` / `memory.json` 兼容副本。第一版不打包原始资料、Ollama 模型目录或 Qdrant volume。
`backup:data` 的保留策略只识别带钜洲备份 manifest 的 ZIP；`--retention-days` 删除超过天数的旧备份，`--keep-last` 保证至少保留最近 N 份，新生成的备份始终保留。

恢复前应停止服务；恢复命令必须带 `--force`，并会先自动备份当前数据。

## API 概览

认证和状态：

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
GET  /api/health
```

老板端 Agent：

```text
POST /api/agent/dispatch
GET  /api/agent/stream
POST /api/chat                 # 可传 forceGeneralChat=true 跳过自动知识库答疑
GET  /api/tools/registry
GET  /api/agent-runs
GET  /api/agent-runs/:runId
GET  /api/traces
GET  /api/traces/:traceId
```

老板端聊天历史：

```text
GET    /api/boss-chat/sessions
POST   /api/boss-chat/sessions
GET    /api/boss-chat/sessions/:sessionId
PATCH  /api/boss-chat/sessions/:sessionId
DELETE /api/boss-chat/sessions/:sessionId
POST   /api/boss-chat/import-local
```

当前行为：

- `/api/chat`、`/api/agent/dispatch`、`/api/agent/draft` 和 `/api/agent/stream` 的老板端 turn 进入当前 `sessionId` 对应会话。
- 会话列表按最后一条真实消息的 `lastMessageAt` 倒序；GET 读取会话、PATCH 标题/预览、前端恢复渲染只更新元数据，不应把会话顶到列表前面，只有追加新消息才会刷新排序时间。
- 翻译 skill 的助手消息以 `action: "translation"` 保存；缺正文时的追问以 `action: "translation_request"` 保存。
- 会话保留 30 天；过期会话和消息在读取/写入路径中清理或过滤。
- 删除聊天会话只删除/隐藏该会话历史，不删除 `tasks`、`invites`、`quizzes` 或本地 `memories`。
- 旧前端 `localStorage` 聊天记录只在用户确认导入后进入 `POST /api/boss-chat/import-local`，服务端保存为去 HTML/script 的安全文本 `local_transcript`，不复原成可执行富文本。

知识库和导入：

```text
GET  /api/knowledge-bases
GET  /api/knowledge-bases/:kbId/versions
GET  /api/imports
POST /api/imports/directory
POST /api/imports/upload
```

培训闭环：

```text
GET  /api/tasks/:taskId/status
DELETE /api/tasks
GET  /api/invites/:token
POST /api/answer
POST /api/quiz/generate
POST /api/quiz/submit
```

记忆：

```text
GET    /api/memory
PATCH  /api/memory/:id
DELETE /api/memory/:id
DELETE /api/memory
```

OpenClaw 插件保留 8 个 training tool 名，不在本轮文档整理中改变。

## 部署要点

Windows Server 轻量部署建议：

```env
TRAINING_STORAGE=sqlite
TRAINING_VECTOR_BACKEND=local
TRAINING_HYBRID_RETRIEVAL=auto
TRAINING_EMBEDDING_MODEL=bge-m3
TRAINING_LLM_PROVIDER=auto
TRAINING_LLM_BASE_URL=https://api.deepseek.com/v1
TRAINING_LLM_MODEL=deepseek-chat
```

2 核 4GB 服务器不建议长期运行完整聊天大模型。若要启用语义检索，可以只安装 Ollama 和 `bge-m3` 做 query embedding，资料向量索引用本地生成后同步的 `vector-index-bge-m3.json`。

Windows Server 长期运行建议保留计划任务，但要去掉默认运行时长限制：

```powershell
Export-ScheduledTask -TaskName JuzhouAgentTraining | Out-File .\backups\JuzhouAgentTraining.before.xml
```

当前线上约定：

- `JuzhouAgentTraining`：以 `SYSTEM` 运行 `start-server.ps1`，`ExecutionTimeLimit=PT0S`，`RestartCount=3`，`RestartInterval=PT1M`，`StartWhenAvailable=true`。
- `JuzhouAgentTrainingWatchdog`：每 5 分钟运行 `watchdog-server.ps1`，检查 `0.0.0.0:8787`、`http://127.0.0.1:8787/` 和 `/api/health`。线上 `/api/health` 未带密钥返回 `401` 属于正常鉴权，watchdog 视为健康。
- `JuzhouAgentTrainingBackup`：建议每天运行 `backup-server.ps1`，脚本会加载 `.env`，执行 `backup:data`，校验新备份，并按默认 14 天/最近 10 份的策略清理旧备份。
- `start-server.ps1` 不覆盖旧日志，会追加写入 `logs\server.log`，记录启动时间、Node 路径、工作目录、关键环境变量摘要和 Node 退出码。
- `watchdog-server.ps1` 写入 `logs\watchdog.log`；如果主任务显示 Running 但端口或 HTTP 不通，会先停止主任务再重新启动。
- `backup-server.ps1` 写入 `logs\backup.log`；可用 `TRAINING_BACKUP_RETENTION_DAYS`、`TRAINING_BACKUP_KEEP_LAST` 和 `TRAINING_BACKUP_OUT` 覆盖保留天数、最少份数和输出目录。

常用排查命令：

```powershell
Get-ScheduledTask -TaskName JuzhouAgentTraining,JuzhouAgentTrainingWatchdog,JuzhouAgentTrainingBackup | Select TaskName,State
Get-ScheduledTaskInfo -TaskName JuzhouAgentTraining
Export-ScheduledTask -TaskName JuzhouAgentTraining | Select-String ExecutionTimeLimit
Get-NetTCPConnection -LocalPort 8787 -State Listen
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/health
Get-Content .\logs\server.log -Tail 80
Get-Content .\logs\watchdog.log -Tail 80
Get-Content .\logs\backup.log -Tail 80
```

回滚方式：导入变更前备份的 `JuzhouAgentTraining` XML，恢复旧 `start-server.ps1`，并删除 `JuzhouAgentTrainingWatchdog` / `JuzhouAgentTrainingBackup` 任务。恢复运行数据前仍应先停服务。

更完整的服务器说明见 [../deploy/server/README-server.md](../deploy/server/README-server.md)。

## 常用验证

```powershell
npm run check
npm run smoke
npm run eval:rag -- --retrieval-only
npm run eval:intent
npm run eval:memory
npm run eval:agent-trajectory
npm run eval:traces
npm run eval:sqlite
npm run eval:backup
npm run eval:import
npm run eval:jobs
npm run eval:boss-chat
npm run eval:translation
npm run eval:kb-versions
git diff --check
```

RAG 评测用例在 `scripts/fixtures/rag-eval-cases.mjs`，当前共 30 条，默认以 retrieval-only 的 Top1/Top3 命中和 hybrid 不低于 BM25 为主要门槛。备份评测覆盖 SQLite 快照、JSONL/向量索引打包、校验、强制恢复和保留策略清理。
翻译评测会创建临时 `TRAINING_DATA_DIR`，设置 `TRAINING_AUTH_DISABLED=1`，并启动本地 OpenAI-compatible mock 服务覆盖中英日西法、默认目标语言、缺正文追问、上一条老板端正文上下文、正文在前且翻译指令在末尾、长文本不静默截断、LLM API 缺失错误、`翻译成英文：这是一台水泵` 和 boss-chat 写入；同时断言“生成英文文章，同时附带中文翻译”不会被翻译 parser 抢走。

当前文档和评测流程只维护 Markdown 项目文档和 QA 镜像，本轮不做 Word 导出。

## 当前限制

- `TRAINING_ACCESS_KEY` 不是完整多账号权限体系。
- SQLite 适合当前单机部署，不是最终多租户 SaaS 数据库。
- 本地记忆只能补默认偏好，不能覆盖用户当前明确指令，也不能当产品事实库。
- 图片型 PDF 视觉补全是人工式资料治理流程，不是可规模化自动 OCR 平台。
- Qdrant 是可选后端；更换 embedding 模型后必须重建对应向量索引。
