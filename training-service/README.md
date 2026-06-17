# 钜洲培训 Agent Service MVP

这是培训系统的 Web/API 服务。它保存员工、知识库、培训任务、邀请链接、考试和报表数据，可以独立运行；OpenClaw 只通过可选外部插件调用它。

## 运行

```powershell
npm start
```

默认地址：`http://127.0.0.1:8787`

## 页面

- 老板后台：`http://127.0.0.1:8787/`
- 导入管理：`http://127.0.0.1:8787/imports`
- 任务中心：`http://127.0.0.1:8787/jobs`
- Agent Run / Trace：`http://127.0.0.1:8787/traces`
- 员工邀请链接：发布任务后生成 `/t/{inviteToken}`

## 数据目录

培训系统代码在：

```text
D:\juzhou-agent\peixun\training-service
```

业务数据放在代码目录外：

```text
D:\juzhou-agent\data\training-raw    # 原始 PDF、Excel、CSV、TXT、Markdown
D:\juzhou-agent\data\training-clean  # 清洗后的 Markdown/TXT
D:\juzhou-agent\data\training-index  # training.db、JSON 回滚文件、conversation-history.jsonl、本地向量索引
D:\juzhou-agent\data\qdrant          # 本机 Qdrant Docker 持久化目录
```

默认数据根目录由项目根推导为 `D:\juzhou-agent\data`。如需整体换盘，可设置 `TRAINING_DATA_ROOT`；如只想覆盖运行索引目录，可设置 `TRAINING_DATA_DIR`。

默认主数据库：

```text
D:\juzhou-agent\data\training-index\training.db
D:\juzhou-agent\data\training-index\training.db-shm
D:\juzhou-agent\data\training-index\training.db-wal
```

旧版 JSON 文件仍保留为首次迁移来源和回滚导出目标：

```text
D:\juzhou-agent\data\training-index\state.json
D:\juzhou-agent\data\training-index\memory.json
D:\juzhou-agent\data\training-index\conversation-history.jsonl
D:\juzhou-agent\data\training-index\agent-traces.jsonl
D:\juzhou-agent\data\training-index\agent-runs.jsonl
D:\juzhou-agent\data\training-index\jobs.json
D:\juzhou-agent\data\training-index\knowledge-base-versions.json
D:\juzhou-agent\data\training-index\vector-index-bge-m3.json
```

`training.db` 保存业务状态、长期记忆、SQLite 模式下的异步任务、知识库版本快照和 Agent Run；`conversation-history.jsonl` 追加老板端聊天历史；`agent-traces.jsonl` 记录兼容 Trace 摘要；`agent-runs.jsonl` 是 JSON 回滚模式下的结构化运行记录；`jobs.json` 是 JSON 回滚模式下的任务队列；`knowledge-base-versions.json` 是 JSON 回滚模式下的知识库版本快照；`vector-index-bge-m3.json` 是可选的本地向量索引。它们不提交 Git。导出的 `state.json` 仍保持 `meta.version = 1`，用于回滚和兼容。

也可以用环境变量覆盖：

```powershell
$env:TRAINING_DATA_DIR="D:\juzhou-agent\data\training-index"
$env:TRAINING_STORAGE="sqlite"
npm start
```

SQLite 默认启用。首次启动时，如果 `training.db` 不存在或尚未初始化，会自动从 `state.json` 和 `memory.json` 导入并保留备份。手动迁移与回滚导出：

```powershell
npm run migrate:sqlite -- --dry
npm run migrate:sqlite
npm run export:json
```

如需临时回退旧 JSON 存储：

```powershell
$env:TRAINING_STORAGE="json"
npm start
```

## 备份与恢复

第一版备份只覆盖运行数据，不打包原始资料目录、Qdrant volume 或 Ollama：

```powershell
npm run backup:data
npm run backup:verify -- --from "D:\juzhou-agent\data\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip"
npm run restore:data -- --from "D:\juzhou-agent\data\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip" --force
```

默认备份目录是：

```text
D:\juzhou-agent\data\training-index\backups
```

备份包包含：

- `training.db`：通过 SQLite backup API 生成的一致快照。
- `state.json` / `memory.json`：从当前 SQLite 状态导出的兼容回滚副本。
- `conversation-history.jsonl`、`agent-traces.jsonl`、`agent-runs.jsonl`、`jobs.json`：如果存在则一起备份。
- `knowledge-base-versions.json`：JSON 回滚模式下的知识库版本快照，如果存在则一起备份。
- `vector-index-*.json`：本地向量索引文件。
- `manifest.json`：文件清单、大小、sha256、项目版本和 schemaVersion。

恢复脚本默认只校验备份包，不覆盖数据。必须加 `--force` 才会恢复；恢复前会自动调用 `backup:data` 为当前数据生成一份安全备份。正式恢复前建议先停止服务，避免运行中的进程继续写入数据库。

## 导入 PDF 和表格资料

老板端可以打开 `/imports` 使用导入管理页。第一版支持两种入口：

- 本机目录导入：填写服务器本机目录路径、知识库名称和别名。
- 浏览器上传：上传 `.pdf`、`.xlsx`、`.csv`、`.md`、`.txt` 文件或文件夹。

导入管理页现在会创建后台任务。导入任务完成后，BM25 检索立即可用，并默认自动创建当前知识库的本地向量索引任务。可以打开 `/jobs` 查看导入和 embedding 子任务的进度、结果和错误；如果 embedding 失败，已导入知识库不会回滚，仍可使用 BM25。

每次成功导入会保留知识库“当前版 + 上一版”两个快照，并记录文档级导入差异。`/imports` 中每个知识库卡片可以查看版本、差异和质量变化；回滚上一版时必须输入 `ROLLBACK`，系统会创建 `rollback_knowledge_base` 异步任务，回滚成功后默认再创建当前知识库的本地向量索引任务。回滚只恢复知识库内容，不删除培训任务、邀请、考试、记忆、Trace 或 Jobs。

命令行方式仍然保留：

1. 把原始文件放到：

```text
D:\juzhou-agent\data\training-raw
```

2. 清洗 PDF / Excel / CSV：

```powershell
npm run clean:raw
```

3. 导入清洗后的知识库：

```powershell
npm run import:clean -- "D:\juzhou-agent\data\training-clean" "电机培训资料库" "电机,电动机,三相异步电动机,异步电机,银嘉电机,YINJIA,YINJIA motor,电机应用,电机结构,电机选型,能效等级"
```

导入后，老板自然语言里提到 `电机`、`电动机`、`三相异步电动机` 等关键词时，系统会尝试匹配到该知识库。

## 语义切片与混合检索

导入清洗资料时，服务会使用 `src/semantic-chunking.mjs` 做业务语义切片：

- `chunkParents` 保存知识点、型号/系列、表格行等父级业务上下文。
- `chunks` 是检索子块，带 `parentId`、`childType`、`businessKeys`、`searchText`。
- 训练讲义、员工答疑、考试出题和营销软文都使用父块上下文生成。

当前服务支持 `BM25 + 向量语义检索` 的混合 RAG。BM25 负责型号、参数、条款等精确召回，向量检索负责语义召回；向量索引不可用时会降级为 BM25。

本机准备：

```powershell
$env:QDRANT_URL="http://127.0.0.1:6333"
$env:QDRANT_COLLECTION="training_chunks_bge_m3"
$env:OLLAMA_URL="http://127.0.0.1:11434"
$env:TRAINING_EMBEDDING_MODEL="bge-m3"
```

本机完成资料清洗和导入后，可以生成 embedding 并写入 Qdrant：

```powershell
npm run embed:chunks
```

轻量服务器或不想部署 Qdrant 时，可以生成本地向量索引：

```powershell
npm run embed:local -- --model=bge-m3
```

只重建某个知识库：

```powershell
npm run embed:chunks -- --kb=kb-电机培训资料库
```

只查看待构建数量：

```powershell
npm run embed:chunks -- --dry
```

创建本机 Qdrant collection snapshot：

```powershell
npm run qdrant:snapshot -- create
```

查看已有 snapshot：

```powershell
npm run qdrant:snapshot -- list
```

服务运行时默认启用混合检索；如需临时关闭向量检索并只使用 BM25：

```powershell
$env:TRAINING_HYBRID_RETRIEVAL="off"
```

## 服务器部署要点

推荐模式是本机生成 embedding，服务器只跑在线服务。向量后端二选一：

- 数据量或并发较高：本机生成 Qdrant snapshot，服务器恢复 Qdrant。
- 小型 Windows 服务器：本机或服务器生成 `vector-index-bge-m3.json`，使用 local vector backend。

Qdrant 方式：

1. 本机运行 `npm run clean:raw`、`npm run import:clean`、`npm run embed:chunks`。
2. 在本机 Qdrant 为 collection 创建 snapshot：`npm run qdrant:snapshot -- create`。
3. 传输 `training.db`、清洗资料和 Qdrant snapshot 到服务器；如果从旧版本升级，也可传输 `state.json`、`memory.json` 让服务首次启动自动迁移。
4. 服务器用 Docker 运行 Qdrant 并恢复 snapshot。
5. 服务器启动 `node src/server.mjs` 或使用 `pm2/systemd` 管理。

服务器环境变量至少包含：

```powershell
$env:TRAINING_DATA_DIR="D:\juzhou-agent\data\training-index"
$env:TRAINING_STORAGE="sqlite"
$env:QDRANT_URL="http://127.0.0.1:6333"
$env:QDRANT_COLLECTION="training_chunks_bge_m3"
$env:TRAINING_HYBRID_RETRIEVAL="on"
```

本地向量索引方式：

```powershell
$env:TRAINING_DATA_DIR="D:\juzhou-agent\data\training-index"
$env:TRAINING_VECTOR_BACKEND="local"
$env:TRAINING_EMBEDDING_MODEL="bge-m3"
$env:TRAINING_HYBRID_RETRIEVAL="auto"
```

LLM 调用默认使用 OpenAI-compatible API 直连 DeepSeek。OpenClaw Gateway 是兼容入口，需要显式设置 `TRAINING_LLM_PROVIDER=openclaw` 才会使用：

```powershell
$env:TRAINING_LLM_PROVIDER="auto"
$env:TRAINING_LLM_BASE_URL="https://api.deepseek.com/v1"
$env:TRAINING_LLM_MODEL="deepseek-chat"
$env:TRAINING_LLM_API_KEY="..."
```

```powershell
$env:TRAINING_LLM_PROVIDER="openclaw"
$env:OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789"
```

## 图片型 PDF 处理

如果 PDF 不能直接抽取文字，可以先渲染为图片页：

```powershell
npm run render:pdf -- "D:\juzhou-agent\data\training-raw\电机\电机1.pdf" "D:\juzhou-agent\data\training-vision" 3 1.4
```

渲染图片会输出到：

```text
D:\juzhou-agent\data\training-vision
```

随后将视觉识别出的内容整理为 Markdown，放回：

```text
D:\juzhou-agent\data\training-clean
```

再运行 `scripts/import-clean.mjs` 重新导入知识库。

## API 概览

- `GET /api/health`
- `GET /api/knowledge-bases`
- `GET /api/knowledge-bases/{knowledgeBaseId}/quality`
- `GET /api/knowledge-bases/{knowledgeBaseId}/versions`
- `GET /api/reports/overview`
- `GET /api/employees?q=销售部`
- `POST /api/chat`
- `POST /api/agent/draft`
- `POST /api/agent/dispatch`
- `WS /api/agent/stream`
- `GET /api/jobs`
- `GET /api/jobs/{jobId}`
- `POST /api/jobs/{jobId}/cancel`
- `POST /api/jobs/import/directory`
- `POST /api/jobs/import/upload`
- `POST /api/jobs/knowledge-bases/{knowledgeBaseId}/rollback`
- `POST /api/jobs/embed`
- `GET /api/agent-runs`
- `GET /api/agent-runs/{runId}`
- `GET /api/tools/registry`
- `GET /api/traces`
- `GET /api/traces/{traceId}`
- `GET /api/memory`
- `PATCH /api/memory/{memoryId}`
- `DELETE /api/memory/{memoryId}`
- `DELETE /api/memory`
- `POST /api/tasks/publish`
- `GET /api/tasks`
- `DELETE /api/tasks`
- `GET /api/tasks/{taskId}`
- `GET /api/invites/{token}`
- `POST /api/answer`
- `POST /api/quiz/generate`
- `POST /api/quiz/submit`

老板端聊天主入口为 `/api/agent/dispatch`，WebSocket 流式入口为 `/api/agent/stream`。两者都支持：

```json
{
  "message": "给王小明发布电机基础培训，出 10 道题，80 分及格",
  "sessionId": "browser-session-id",
  "memoryMode": "auto"
}
```

执行高风险或低置信操作时，服务端会先返回 `action: "intent_confirm"`。确认执行时把原消息、`confirmedSkill` 和 `confirmationToken` 一起提交：

```json
{
  "message": "把之前培训记录删掉",
  "confirmedSkill": "delete_training_records",
  "confirmationToken": "server-issued-token"
}
```

`memoryMode` 可设为 `off`，用于临时不读取和不写入记忆的对话。

每次 `/api/agent/dispatch`、`/api/agent/stream` 和 `/api/chat` 都会生成一条 Agent Run。Run 会按 step 记录 `memory_recall`、`intent_route`、`confirmation_verify`、`tool_execute`、`memory_write` 和 `result_output` 等阶段；`/api/tools/registry` 返回当前网页端 5 个 skill 和 OpenClaw 8 个 training tool 的风险等级、确认要求和入口说明。治理记录只保存脱敏消息预览、hash、摘要和耗时，不保存完整聊天内容或 API Key。

维护边界：HTTP controller 和 WebSocket stream 只负责协议适配，共用 `src/agent` 下的确认校验、run 收尾和摘要逻辑；Agent Run 的 SQLite 表结构只维护在 `src/agent-runs/schema.mjs`。AI 层中 `core.mjs` 只做兼容导出，真实实现按意图、上下文、答疑、讲义、软文、出题和文本工具拆分。

## 常用验证

```powershell
npm run check
npm run eval:backup
npm run eval:import
npm run eval:jobs
npm run eval:kb-versions
npm run eval:traces
npm run eval:agent-trajectory
npm run eval:sqlite
npm run smoke
npm run eval:intent
npm run eval:memory
npm run eval:rag -- --retrieval-only
```

RAG 检索评测用例维护在 `scripts/fixtures/rag-eval-cases.mjs`，当前共 30 条。默认建议先跑 `--retrieval-only`，以 Top1/Top3 命中、hybrid 是否不低于 BM25 和分类统计作为检索质量回归门槛；完整 `npm run eval:rag` 会额外调用大模型检查答案来源、长度和 OCR 占位。

`eval:jobs` 使用临时数据目录验证异步导入、自动 embedding 子任务、取消、重启恢复和 JSON 任务存储。`eval:kb-versions` 验证知识库 current/previous 快照、文档级 diff、异步回滚、业务数据保护和 JSON 版本文件。`eval:traces` 验证脱敏 Trace 读取、过滤和关闭开关。`eval:agent-trajectory` 验证 Agent Run step 时间线、Tool Registry、确认门禁和禁止误执行的负例。

## 当前限制

- 服务器模式不建议运行大规模 embedding 构建；embedding 推荐在本机离线构建后迁移 Qdrant snapshot 或本地向量索引。
- 如果使用本地向量索引，迁移服务器时需要一起备份 `vector-index-bge-m3.json`。
- Qdrant collection 的向量维度固定；更换 embedding 模型后需要重建 collection。
- 图片型或扫描型 PDF 需要 OCR 后才能得到完整文本；当前清洗脚本只能直接抽取可复制文本。
- 当前邀请链接没有手机号/企业身份校验，正式版需要补权限验证。
- 记忆模块只用于老板端聊天连续性和默认偏好，不作为产品事实来源；敏感信息、高风险动作和一次性任务不会自动保存为长期记忆。

