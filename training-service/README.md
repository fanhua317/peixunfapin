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
```

SQLite 是默认主存储；JSON 模式只作为兼容和回滚：

```env
TRAINING_STORAGE=json
```

`state.json` 的 `meta.version` 继续保持 `1`，但它不再是默认主存储。

老板端聊天历史随服务 schemaVersion `5` 保存到 SQLite 的 `boss_chat_sessions` / `boss_chat_messages`；JSON 回滚模式使用 `boss-chat-sessions.json`。当前账号口径固定为 `boss-default`，同一服务和数据目录下的不同浏览器或电脑应看到同一批老板端会话。

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

没有可用大模型 API 时，普通聊天、翻译和生成类任务会返回明确错误；系统不会用模板假装生成讲义、试题、软文或翻译结果。

## 多语言翻译 skill

老板端 Agent 支持把明确翻译请求路由到多语言翻译 skill。常见入口包括：

- `翻译成英文：这是一个电机培训系统`
- `把 hello 翻译成中文`
- `translate to Spanish: high efficiency motor`
- `翻译一下：high efficiency motor`

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

老板端聊天会先识别发布、删除、进度、软文等明确业务操作；剩余普通聊天候选如果命中知识库别名或电机资料领域词，并且 RAG 检索有足够相关的 chunk，会自动走 `answer_knowledge_question`，返回 `knowledge_answer`、知识库名、检索模式、来源和命中片段。用户在确认卡片里选择“当普通聊天”时，前端会向 `/api/chat` 传 `forceGeneralChat: true`，后端跳过自动知识库探测。

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

已处理过的电机资料包括 `YINJIA motor catalog-2025.10.pdf`、`电机1-4.pdf` 和电机 3D 爆炸图。看不清的参数必须留空或标注不确定，不允许编造。

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
npm run backup:verify -- --from D:\juzhou-agent\data\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip
npm run restore:data -- --from D:\juzhou-agent\data\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip --force
```

备份包含 `training.db` 快照、JSONL、向量索引和导出的 `state.json` / `memory.json` 兼容副本。第一版不打包原始资料、Ollama 模型目录或 Qdrant volume。

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

RAG 评测用例在 `scripts/fixtures/rag-eval-cases.mjs`，当前共 30 条，默认以 retrieval-only 的 Top1/Top3 命中和 hybrid 不低于 BM25 为主要门槛。
翻译评测会创建临时 `TRAINING_DATA_DIR`，设置 `TRAINING_AUTH_DISABLED=1`，并启动本地 OpenAI-compatible mock 服务覆盖中英日西法、默认目标语言、缺正文追问、上一条老板端正文上下文、LLM API 缺失错误和 boss-chat 写入。

## 当前限制

- `TRAINING_ACCESS_KEY` 不是完整多账号权限体系。
- SQLite 适合当前单机部署，不是最终多租户 SaaS 数据库。
- 本地记忆只能补默认偏好，不能覆盖用户当前明确指令，也不能当产品事实库。
- 图片型 PDF 视觉补全是人工式资料治理流程，不是可规模化自动 OCR 平台。
- Qdrant 是可选后端；更换 embedding 模型后必须重建对应向量索引。
