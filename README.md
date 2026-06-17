# 钜洲培训 Agent

钜洲培训 Agent 是一个面向企业内部资料培训的本地部署系统。它把资料导入、RAG 检索、培训发布、员工学习、答疑、考试、报表、营销软文、记忆、任务中心和运行轨迹串成一个闭环。

项目默认可以独立运行；OpenClaw Gateway 和 OpenClaw 插件只是兼容集成入口，不是默认运行依赖。

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
- `/traces`：Agent Run 和脱敏 Trace。
- `/t/{inviteToken}`：员工学习、答疑和考试。

## 核心能力

- 老板端自然语言创建培训草稿、确认发布、生成员工学习链接。
- 老板端提到已导入资料相关内容时，自动转为知识库答疑并展示来源片段。
- 员工端查看讲义、提问、生成考试、提交答案。
- 基于本地知识库生成营销软文，不保存文章记录。
- 本地记忆用于普通聊天连续性和低风险默认偏好。
- 混合意图路由、确认卡片、Tool Registry 和 Agent Run 轨迹用于减少误判。
- 知识库支持目录导入、上传导入、异步任务、版本差异和上一版回滚。
- RAG 使用 BM25 + 本地向量 hybrid + parent-child 上下文；向量不可用时回退 BM25。

## 数据目录

仓库只放代码和文档，运行数据默认在仓库外：

```text
D:\juzhou-agent\data
├── training-index\        # SQLite、JSONL、向量索引、备份
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

普通聊天、讲义、出题和软文默认走 OpenAI-compatible API，当前推荐 DeepSeek：

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

没有可用大模型 API 时，系统不会假装生成讲义、试题或软文，而是返回配置缺失或调用失败的明确错误。

轻量服务器建议使用本地向量索引：

```powershell
cd D:\juzhou-agent\peixun\training-service
npm run embed:local -- --full
```

服务器可只运行 Ollama `bge-m3` 做 query embedding，资料侧复用已生成的 `vector-index-bge-m3.json`。Qdrant 仍保留为可选方案，适合数据量或并发更高的场景。

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

## 备份与恢复

运行数据备份命令：

```powershell
cd D:\juzhou-agent\peixun\training-service
npm run backup:data
npm run backup:verify -- --from D:\juzhou-agent\data\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip
npm run restore:data -- --from D:\juzhou-agent\data\training-index\backups\training-backup-YYYYMMDD-HHmmss.zip --force
```

恢复前应停止服务。恢复脚本会校验 ZIP，并在覆盖前自动生成当前数据的安全备份。

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

更细的部署说明见：

- [training-service/README.md](training-service/README.md)
- [deploy/server/README-server.md](deploy/server/README-server.md)

## 常用验证

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
npm run eval:backup
npm run eval:import
npm run eval:jobs
npm run eval:kb-versions
git diff --check
```

文档-only 改动通常至少跑 `npm run check` 和 `git diff --check`。

## 文档索引

- [training-service/README.md](training-service/README.md)：服务运行、API、导入、检索、部署和验证命令。
- [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md)：架构总览、数据流、风险和路线图。
- [docs/Agent项目面试QA.md](docs/Agent项目面试QA.md)：中文面试问答，按真实项目实现整理。
- [training-service/LLM_CONFIG.md](training-service/LLM_CONFIG.md)：LLM Provider 与 OpenClaw Gateway 兼容说明。
- [training-plugin/README.md](training-plugin/README.md)：OpenClaw 插件的 8 个 training tool。
