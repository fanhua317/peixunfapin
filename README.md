# 钜洲培训 Agent MVP

这个目录包含独立于 OpenClaw 主仓库的企业培训 Agent MVP。当前主路径是网页端：老板用自然语言创建培训、导入知识库、生成软文、查询进度和管理记忆；员工通过邀请链接学习、答疑和考试。OpenClaw 插件仍保留为可选工具入口。

```text
training-service  # Web/API 服务，保存业务数据并提供老板/员工页面
training-plugin   # OpenClaw 外部插件，把培训服务暴露为 Agent tools
```

## 快速启动

1. 启动培训服务：

```powershell
node D:\juzhou-agent\peixun\training-service\src\server.mjs
```

2. 打开老板后台：

```text
http://127.0.0.1:8787/
http://127.0.0.1:8787/imports
http://127.0.0.1:8787/jobs
http://127.0.0.1:8787/traces
```

3. 可选：在 OpenClaw 中安装插件，让外部 Agent 调用培训工具：

```powershell
openclaw plugins install "D:\juzhou-agent\peixun\training-plugin"
openclaw gateway restart
```

## 数据目录

真实业务数据默认放在 `D:\OpenClawData`，不要提交到 Git：

```text
D:\OpenClawData\training-raw
D:\OpenClawData\training-clean
D:\OpenClawData\training-index
D:\OpenClawData\training-vision
D:\OpenClawData\qdrant
D:\OpenClawData\ollama
```

`training-index` 下默认使用 SQLite 保存业务状态和本地 Agent 记忆，旧版 JSON 仍保留为首次迁移来源和回滚导出格式：

```text
training.db                # 默认主数据库：知识库、任务、邀请、考试、记忆
training.db-shm            # SQLite WAL 辅助文件，可能存在
training.db-wal            # SQLite WAL 辅助文件，可能存在
state.json                 # 旧版业务状态；首次迁移来源、export:json 回滚目标
memory.json                # 旧版长期记忆；首次迁移来源、export:json 回滚目标
conversation-history.jsonl # 老板端聊天和工具调用历史，按 session 追加
agent-traces.jsonl         # 意图路由和确认链路轨迹
agent-runs.jsonl           # JSON 回滚模式下的 Agent Run 结构化运行记录
jobs.json                  # JSON 回滚模式下的异步任务队列
knowledge-base-versions.json # JSON 回滚模式下的知识库 current/previous 版本快照
vector-index-bge-m3.json   # 可选，本地向量索引
```

默认 `TRAINING_STORAGE=sqlite`，如需临时回退旧文件存储可设置 `TRAINING_STORAGE=json`。

## 推荐开发顺序

1. 先用 Web 页面跑通老板发布任务、员工链接学习、考试和报表。
2. 再验证营销软文、记忆、删除确认和普通聊天。
3. 需要外部 Agent 编排时，再安装 OpenClaw 插件。
4. 最后再考虑报价、阿里发布、视频生成或企业微信等新 skill。

## 当前架构

`training-service` 已按轻量分层拆分：

```text
src/server.mjs      # 只负责启动原生 HTTP server
src/http            # 请求解析、认证、静态文件、API controller
src/domain          # 知识库、员工、任务、邀请、考试、报表业务逻辑
src/ai              # 意图识别、讲义、答疑、出题、软文、LLM JSON 调用
src/memory          # 本地短期会话记忆、长期偏好记忆、记忆策略和召回
src/import          # 资料清洗、网页上传、本机目录导入和语义切片写入
src/jobs            # 本地异步任务队列，执行导入和本地向量索引重建
src/knowledge-base-versions.mjs # 知识库 current/previous 版本、文档级导入差异和回滚
src/agent-runs      # Agent Run 运行治理记录，按请求拆分 step 时间线
src/tools           # Tool Registry，统一登记网页 skill 和 OpenClaw tool 元信息
src/semantic-chunking.mjs # 业务语义切片，生成 parent-child RAG 结构
src/rag.mjs         # BM25 + 向量混合检索，命中 child 后展开 parent
src/intent-confirmation.mjs # 操作确认 token，防止误确认执行
src/agent-trace.mjs # Agent 路由轨迹 JSONL 日志
src/traces.mjs      # 脱敏 Agent Trace 查询
public/src          # 无构建浏览器 ES modules
```

`training-plugin` 保留 8 个 OpenClaw training tool 名不变，内部拆成配置、HTTP client、schema 和 tool 定义。软文和记忆目前只在网页端内部 skill 中提供，插件没有新增 tool。

文档分工：

- `README.md`：项目入口、启动、打包和关键目录。
- `training-service/README.md`：服务开发、导入资料、检索、API 和部署要点。
- `docs/PROJECT_OVERVIEW.md`：完整架构、流程、风险和路线图。
- `docs/Agent项目面试QA.md`：面试表达用的问答材料。

常用验证：

```powershell
cd D:\juzhou-agent\peixun\training-service
npm run check
npm run eval:import
npm run eval:jobs
npm run eval:kb-versions
npm run eval:traces
npm run eval:agent-trajectory
npm run eval:sqlite
npm run smoke
npm run eval:rag -- --retrieval-only
npm run eval:intent
npm run eval:memory
```

`eval:rag -- --retrieval-only` 当前固定覆盖 30 条电机业务问题，重点检查型号参数、结构原理、制造工艺、质量检测、销售话术、多语言资料和标准资料的 Top1/Top3 命中。`eval:agent-trajectory` 验证一次老板端请求的运行轨迹，包括记忆召回、意图路由、确认门禁、skill 执行和禁止误执行的负例。

SQLite 迁移和 JSON 回滚导出：

```powershell
npm run migrate:sqlite -- --dry
npm run migrate:sqlite
npm run export:json
```

运行数据备份和恢复：

```powershell
npm run backup:data
npm run backup:verify -- --from D:\OpenClawData\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip
npm run restore:data -- --from D:\OpenClawData\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip --force
```

`backup:data` 默认输出到 `TRAINING_DATA_DIR\backups`，包含 `training.db` 快照、JSON 回滚副本、聊天/路由日志、Agent Run 记录、JSON 模式任务队列、JSON 模式知识库版本文件和本地向量索引。恢复属于高风险操作，执行 `--force` 前建议先停止服务；脚本会在覆盖前自动为当前数据再做一份安全备份。

## 打包给 Windows 用户

生成绿色版 ZIP 和自解压安装 EXE：

```powershell
cd D:\juzhou-agent\peixun
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1 -IncludeData
```

输出文件在：

```text
dist\JuzhouAgentTraining.zip
dist\JuzhouAgentTraining-Setup.exe
```

`-IncludeData` 会打包 `D:\OpenClawData\training-index`、`training-clean` 和 `training-vision`，不会打包原始 PDF、Qdrant、Ollama 或密钥。

普通聊天和大模型出题/生成资料建议通过服务端环境变量配置：

```text
TRAINING_LLM_PROVIDER=auto
TRAINING_LLM_BASE_URL=https://api.deepseek.com/v1
TRAINING_LLM_MODEL=deepseek-chat
TRAINING_LLM_API_KEY=你的 API Key
TRAINING_STORAGE=sqlite
TRAINING_SQLITE_BUSY_TIMEOUT_MS=5000
```

网页老板端会先做意图路由：发布培训、查询进度等培训意图走系统内置技能；其他普通聊天只走直连大模型 API。未配置 `TRAINING_LLM_API_KEY`、`DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY` 时，普通聊天会明确报配置缺失，不使用本地话术。

意图路由采用防误判机制：本地规则先判断高置信操作，模糊表达可交给 LLM router，低置信或高风险操作返回确认卡片。确认执行时必须带服务端签发的 `confirmationToken`，token 会绑定原始消息和 skill，过期、缺失或消息被替换都会拒绝执行。每次 `/api/agent/dispatch`、`/api/agent/stream` 和 `/api/chat` 都会生成 Agent Run，并按 step 记录记忆召回、意图路由、确认校验、skill 执行和结果输出；兼容 Trace 仍会写入 `agent-traces.jsonl`，可用 `TRAINING_AGENT_TRACE=0` 关闭。

老板端新增 `/jobs` 任务中心和 `/traces` 运行轨迹页面。`/imports` 页面提交导入后会创建后台任务，导入成功后自动创建当前知识库的本地向量索引任务；如果 Ollama/bge-m3 不可用，embedding 子任务会失败并显示原因，但已导入知识库仍可用 BM25 检索。`/traces` 同时展示 Agent Run、step 时间线、Tool Registry 和兼容 Trace 摘要，只展示脱敏消息预览，不展示完整聊天内容或 API Key。

知识库导入现在保留“当前版 + 上一版”两个快照。每次成功导入会记录文档级差异，`/imports` 可查看新增、删除、变更文件；回滚需要输入 `ROLLBACK`，会创建异步回滚任务并在成功后自动触发当前知识库的本地向量索引重建任务。回滚只恢复知识库元数据、documents、chunkParents 和 chunks，不影响培训任务、邀请链接、考试、记忆、Trace 或 Jobs。

老板端聊天已加入本地记忆模块：前端会为浏览器生成 `sessionId`，服务端用最近会话和可召回的长期偏好改善普通聊天、培训草稿默认题数/及格分、软文长度/渠道/口吻。记忆不是事实库，产品资料仍必须来自 RAG；删除、发布、成绩、API Key、联系方式等敏感或高风险内容不会自动写入长期记忆。用户可以在聊天里说“查看记忆”“清空全部记忆”，也可以通过 `/api/memory` 查看、确认、归档或删除记忆。

知识库导入使用业务语义切片：SQLite 中保留 `chunkParents` 作为父级业务上下文，`chunks` 作为检索子块并带 `parentId`、`childType`、`businessKeys`、`searchText`。检索时 BM25 和向量都命中 child，生成讲义、答疑、出题和软文时再展开 parent。执行 `npm run export:json` 时仍会导出兼容的 `state.json`。

## 打包部署到服务器

生成服务器部署包：

```powershell
cd D:\juzhou-agent\peixun
powershell -ExecutionPolicy Bypass -File .\scripts\package-server.ps1 -IncludeData
```

输出文件：

```text
dist\JuzhouAgentTrainingServer.zip
```

服务器部署包内置 Docker Compose 配置和 `.env.example`。复制为 `.env` 后填写：

```text
TRAINING_ACCESS_KEY=给老板和员工使用的访问密钥
TRAINING_LLM_API_KEY=大模型 API Key
PUBLIC_BASE_URL=https://你的域名
```

启动：

```bash
docker compose up -d --build
```

