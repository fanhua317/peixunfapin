# AGENTS.md

本文件是 Codex 和其他 AI Agent 处理本仓库任务时的项目规范。只要任务涉及 `D:\juzhou-agent\peixun`，应优先遵守这里的规则。

## 项目边界

- Git 仓库根目录：`D:\juzhou-agent\peixun`。
- 本机运行数据根目录：`D:\juzhou-agent\data`。
- 主服务：`training-service`。
- 可选兼容插件：`training-plugin`。
- 项目默认独立于 OpenClaw 运行；OpenClaw Gateway 和 OpenClaw 插件只是兼容集成，不是默认运行依赖。
- 不要重新创建或依赖 `D:\OpenClaw`、`D:\OpenClawData`。
- 默认只修改本机仓库并推送 GitHub；除非用户在当前任务明确重新授权，不得连接、探测、更新、上传、部署或重启任何服务器。

## 开始工作前先读

处理非平凡任务前，按顺序阅读：

1. `README.md`
2. `training-service/README.md`
3. `docs/PROJECT_OVERVIEW.md`
4. 涉及架构、RAG、Agent 路由、部署、测试、安全、数据路径或面试表达时，再读 `docs/Agent项目面试QA.md`

做代码修改前必须查看相关源码，不要只依赖历史聊天记忆。

## 当前架构约定

- 后端使用 Node.js 原生 HTTP。除非用户明确批准，不引入 Express、Fastify 或前端构建链。
- 前端使用无构建浏览器 ES modules，代码在 `training-service/public/src`。
- 业务状态默认使用 SQLite：`D:\juzhou-agent\data\training-index\training.db`。
- JSON 文件是兼容、备份或回滚格式；`state.json` 继续保持 `meta.version = 1`。
- RAG 默认是 BM25 + 本地向量混合检索。
- Parent-Child RAG 是核心设计：child chunk 用于检索，parent context 用于生成答案。
- LLM 默认走 OpenAI-compatible API，例如 DeepSeek。只有显式设置 `TRAINING_LLM_PROVIDER=openclaw` 时才走 OpenClaw Gateway。
- 不做假的兜底生成：没有可用大模型 API 时，不生成培训讲义、不出题、不写软文。

## 数据安全

- 不要提交运行数据、API Key、数据库、向量索引、上传文件、打包产物或本地备份。
- 业务数据保持在 Git 仓库外的 `D:\juzhou-agent\data`。
- 做删除、移动目录等危险操作前，必须校验解析后的绝对路径。
- 未经用户明确要求，不删除培训任务、邀请链接、记忆、任务队列、Trace、Agent Run 或知识库版本。
- 修改存储层时，必须保留 JSON 回滚模式和 SQLite 迁移兼容能力。

## 开发工作流

- 搜索优先使用 `rg` / `rg --files`。
- 手动改文件使用 `apply_patch`。
- 改动保持聚焦，不把无关清理混入功能提交。
- 如果工作区已有无关未提交改动，不要回滚，也不要提交进去。
- 前端改动要检查文字不溢出、按钮可用、桌面和移动端布局不重叠。
- RAG 改动要保留来源引用，不能放松“不编造”的约束。
- 删除、发布、回滚、恢复、清空记忆等高风险动作必须保留确认门禁。

## 文档同步规则

以下内容发生变化时，必须在同一轮工作里同步项目文档：

- 启动或部署命令。
- 环境变量。
- 数据路径。
- API 行为。
- RAG、embedding、知识库导入行为。
- Agent 路由、记忆、skill、Tool Registry 行为。
- 安全、备份、恢复、运维流程。

文档分工：

- `README.md`：项目入口、启动、打包、关键路径。
- `training-service/README.md`：服务开发、数据、API、导入、检索、部署和验证命令。
- `docs/PROJECT_OVERVIEW.md`：完整架构、流程、风险和路线图。
- `docs/Agent项目面试QA.md`：中文面试问答，必须基于真实代码和真实项目经验。

不要胡编项目事实。没有从代码、文档或运行结果验证过的内容，只能写成假设，或者不写。

## 常用验证命令

```powershell
cd D:\juzhou-agent\peixun\training-service
npm run check
npm run smoke
npm run eval:rag -- --retrieval-only
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
npm run eval:kb-versions
git diff --check
```

当前本机服务健康状态通常应满足：

```text
dataDir = D:\juzhou-agent\data\training-index
Ollama bge-m3 和本地向量索引可用时 retrievalMode = hybrid
llmProvider = deepseek 或其他已配置的 OpenAI-compatible provider
```

## 稳定完成标准

当一次改动是有意的，并且已经通过必要验证：

1. 简要说明改了什么。
2. 报告执行过的验证命令和关键结果。
3. 只提交本次相关文件。
4. 推送到 GitHub，除非用户明确说不要推送。

不要提交无关 dirty 文件。

## 常用运行信息

- 本地服务地址：`http://127.0.0.1:8787/`。
- 重要页面：`/`、`/imports`、`/jobs`、`/traces`、`/t/{inviteToken}`。
- 整体数据根目录可用 `TRAINING_DATA_ROOT` 覆盖。
- 运行索引目录可用 `TRAINING_DATA_DIR` 覆盖。

本地向量索引重建：

```powershell
cd D:\juzhou-agent\peixun\training-service
npm run embed:local -- --full
```

备份与恢复：

```powershell
npm run backup:data
npm run backup:verify -- --from D:\juzhou-agent\data\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip
npm run restore:data -- --from D:\juzhou-agent\data\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip --force
```

恢复前应停止服务。恢复是高风险操作，必须要求 `--force`。

## 必须保持不变的接口和行为

- 现有培训、考试、答疑、邀请、记忆、任务、导入、Trace、Agent Run API 路径。
- OpenClaw 插件已有 8 个 tool 名。
- `state.json meta.version = 1`。
- SQLite “索引列 + JSON 原文”的兼容存储策略。
- 培训发布确认、删除确认、知识库回滚确认和低置信意图确认。
- 向量检索不可用时必须能回退 BM25。
- 培训讲义、考试题、RAG 答疑、营销软文必须保留来源引用。

## 项目经验总结

- 项目重点不是做泛聊天壳，而是把“资料导入、培训发布、员工学习、答疑、考试、报表、软文生成”做成闭环。
- RAG 精度来自资料治理、业务语义切片、BM25 精确召回、向量语义召回和 parent-child 上下文，不是只靠 embedding。
- Agent 可靠性来自混合意图路由、确认门禁、Tool Registry、Agent Run 轨迹和评测集，不是让模型自由决定所有动作。
- 本地记忆只能补默认偏好，不能覆盖用户当前明确指令，也不能当产品事实库。
- SQLite 是当前单机部署的务实选择，不是最终多租户 SaaS 数据库。
- 导入、embedding、回滚这类长任务应走异步任务中心，避免页面假进度和同步阻塞。
- OpenClaw 保留为可选集成是为了兼容历史工具入口；项目默认运行路径应保持独立、可部署、可备份。
