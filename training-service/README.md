# 钜洲培训 Agent Service

`training-service` 是项目主服务，使用 Node.js 原生 HTTP 和无构建 ES modules 前端。它负责老板端聊天、员工学习页、知识库导入、RAG 检索、培训/考试闭环、营销软文、本地记忆、任务中心和运行轨迹。

本地代码修改默认不连接、不更新、不重启服务器；只有当前任务得到用户明确授权时才执行部署或服务器探测。

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

业务状态、记忆、老板聊天、Jobs 和知识库版本的 JSON 回滚存储采用进程内串行写入与“唯一临时文件 + 原子替换”。SQLite 与 JSON 的业务状态变更都通过串行提交避免交错写丢失；讲义生成、出题、文件读取和语义切片在锁外完成，提交时重新校验知识库或任务状态。

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

## Tavily 联网搜索配置

六条 LLM 生成链路支持可选联网搜索，默认关闭：知识库答疑、营销软文、培训讲义/发布生成、员工考试生成、多语言翻译和普通聊天。只有老板端或员工端请求显式传 `webSearchMode: "on"` 时，后端才会调用 Tavily Search API；联网结果不写入知识库、不做 embedding，也不改变 RAG 评测口径。本地知识库资料或用户原文优先，联网资料与本地资料冲突时应说明，不强行合并。营销软文链路会把联网结果用于选题、开头角度、买家痛点、市场表达和应用场景，产品事实、参数、认证和性能声明仍以本地知识库为准。

```env
TRAINING_WEB_SEARCH_PROVIDER=tavily
TRAINING_WEB_SEARCH_BASE_URL=https://api.tavily.com
TRAINING_WEB_SEARCH_API_KEY=...
# 也可使用 TAVILY_API_KEY=...
TRAINING_WEB_SEARCH_MAX_RESULTS=5
TRAINING_WEB_SEARCH_TIMEOUT_MS=8000
TRAINING_WEB_SEARCH_SEARCH_DEPTH=basic
TRAINING_MARKETING_WEB_SEARCH_MAX_RESULTS=8
TRAINING_MARKETING_WEB_SEARCH_SEARCH_DEPTH=basic
```

生成响应会在现有本地来源字段之外补充 `webSearchMode`、`webSearchStatus`、`webSources` 和 `webSourceRefs`。未配置 key、搜索超时、Tavily 返回错误或无结果时，系统只追加 warning，并继续使用本地知识库或用户原文完成原链路。

## 意图路由、软文和知识库答疑

老板端 `/api/agent/dispatch` 会优先把用户输入交给快速 LLM Router 判定 skill。规则层不再作为业务意图的首选解释器，而是保留三类职责：

- 删除、发布、回滚、恢复、清空记忆等高风险动作必须确认。
- Router 不可用或低置信时兜底到普通聊天或确认卡片。
- 知识库答疑和软文生成必须经过知识库选择与 RAG 命中校验，避免“水泵”问题误选电机资料库。

软文请求如“请帮我生成三篇水泵的宣传文章，500词左右，英文”和“请帮我生成三篇英文文章，同时附带中文翻译”都应进入 `generate_marketing_article`；后者的“中文翻译”是文章交付要求，不是 `translate_text`。软文链路支持 `articleCount`、`targetLanguage`、`bilingual`，多篇文章会按应用场景型、采购决策型、技术卖点型、维护成本型、客户沟通型等角度拆分生成，避免只靠模型自由发挥。软文模型调用使用营销专用温度，默认 `TRAINING_MARKETING_TEMPERATURE=0.6`；其他问答、培训资料、翻译和普通聊天不受影响。软文 prompt 要求文章像外贸水泵销售工程师或工业品内容编辑写给真实客户看的内容，不能用内部资料摘要、参数罗列或 “In today's...” 类泛泛开场；开启联网时，Tavily 材料可用于选题、开头、买家痛点、地区/应用场景和市场表达，本地知识库负责校验产品事实、参数、卖点、认证和性能声明。prompt 仍要求减少通用 AI 模板感、空泛套话、万能开头、过度排比和口号式结尾，并接入 vendored `conorbronsdon/avoid-ai-writing` 检测器识别英文 AI-isms、模板转场、夸张营销词和 chatbot 式客套；所有自然化表达都不得新增资料外事实。资料问题如“请帮我检索 CM2 的相关知识”应进入 `answer_knowledge_question` 并选择银嘉泵/水泵知识库；水泵问答后的“有具体型号吗”追问也应沿用同一资料库。

软文生成默认启用重复率和 AI 写作痕迹检查：首轮生成后计算单篇内部重复、同批文章相似度、最近 3 天老板端历史软文相似度、标题相似度、模板句命中和 `aiWritingScore`；不达标时自动重写，默认最多 2 轮。重写只能改变表达、角度和段落组织，不能新增知识库或联网资料之外的产品事实。响应保留旧的 `article` 单篇字段，并新增 `articles[]`、`uniqueness` 和 `rewriteAttempts`；前端会展示“重复率 / AI 写作痕迹”摘要和每篇文章的指标。

```env
TRAINING_MARKETING_TEMPERATURE=0.6
TRAINING_MARKETING_WEB_SEARCH_MAX_RESULTS=8
TRAINING_MARKETING_WEB_SEARCH_SEARCH_DEPTH=basic
TRAINING_MARKETING_UNIQUENESS_ENABLED=1
TRAINING_MARKETING_REWRITE_ATTEMPTS=2
TRAINING_MARKETING_HISTORY_LIMIT=50
TRAINING_MARKETING_HISTORY_DAYS=3
TRAINING_MARKETING_INTERNAL_REPEAT_MAX=0.18
TRAINING_MARKETING_BATCH_SIMILARITY_MAX=0.42
TRAINING_MARKETING_HISTORY_SIMILARITY_MAX=0.50
TRAINING_MARKETING_TITLE_SIMILARITY_MAX=0.65
TRAINING_MARKETING_TEMPLATE_HITS_MAX=2
TRAINING_MARKETING_AI_STYLE_ENABLED=1
TRAINING_MARKETING_AI_SCORE_MAX=35
TRAINING_MARKETING_AI_STYLE_TOP_ISSUES=8
TRAINING_MARKETING_MAX_ARTICLES=5
```

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

上传和清洗暂存目录使用 UUID，路径会做真实边界校验。成功、失败或取消后只清理系统创建的暂存目录，不删除用户选择的源目录。导入、embedding 和知识库回滚共享知识数据串行资源，避免并行任务互相覆盖。

## RAG 与向量索引

主检索路径：

```text
用户问题
-> BM25 子块召回
-> 可用时做 bge-m3 向量召回
-> 融合排序
-> parent-child 展开
-> 可用时将最多 20 个 parent 候选交给 bge-reranker-v2-m3
-> 0.75 * rerankerNormalized + 0.25 * hybridNormalized
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

GPU reranker 是独立 HTTP 服务，配置后由 Node 主服务调用：

```env
TRAINING_RERANKER_ENABLED=1
TRAINING_RERANKER_URL=http://192.168.9.105:8910
TRAINING_RERANKER_API_KEY=...
TRAINING_RERANKER_MODEL=BAAI/bge-reranker-v2-m3
TRAINING_RERANKER_TIMEOUT_MS=15000
TRAINING_RERANKER_CANDIDATES=20
TRAINING_RERANKER_WEIGHT=0.75
```

请求最多发送 50 个候选、每段最多 4000 字符；默认实际候选数为 20。未配置、超时、401、5xx、非 JSON 响应或模型不可用时，当前请求保留原 hybrid 排序并写入降级原因。向量服务或索引不可用时继续回退 BM25；不会因为语义检索或 reranker 离线而让培训和答疑完全不可用。

2026-07-10 至 2026-07-11 的专用 RTX 4080 主机基准显示：统一严格门槛同时评价导入、全量 embedding、资源和三路检索时，最大通过档位为 100 文件/并发 20。仅看 5 次预热后的查询层，5000 文件 BM25 在并发 20 时 Hit@3=100%、p95=22 ms；hybrid+reranker 在并发 5 时 Hit@3=100%、p95=1668 ms 且无降级，并发 10 虽 p95=3271 ms 但有 1 次回退。完整三路矩阵和适用限制见 [../docs/RAG_BENCHMARK.md](../docs/RAG_BENCHMARK.md)。

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

Trace 和 Agent Run 只保存脱敏摘要、消息预览、hash、意图、skill、耗时、错误和 step 时间线，不保存完整密钥、完整 prompt 或完整模型输出。

每个新 Run 的 `summary.observability` 还会记录 LLM provider/model、输入/输出/缓存/总 token、调用时延、流式 TTFT、是否估算、工具成功率、检索证据命中、检索与 rerank 延迟和降级原因。`/traces` 展示近 24 小时聚合卡片和单 Run 明细；历史 Run 没有指标时显示“无数据”，不伪造为 0。

成本必须通过带来源日期的环境快照配置，代码不内置长期价格：

```env
TRAINING_LLM_INPUT_COST_PER_MILLION=...
TRAINING_LLM_OUTPUT_COST_PER_MILLION=...
TRAINING_LLM_CACHED_INPUT_COST_PER_MILLION=...
TRAINING_LLM_COST_CURRENCY=USD
TRAINING_LLM_PRICE_SOURCE_DATE=YYYY-MM-DD
TRAINING_LLM_PRICE_SOURCE=provider-pricing-page
```

可选 OpenTelemetry 默认关闭。开启后输出 `agent.run`、`agent.tool`、`rag.retrieve`、`rag.rerank` 和 `llm.chat` spans；collector 不可用不会影响本地 Run 指标：

```env
TRAINING_OTEL_ENABLED=0
TRAINING_OTEL_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces
TRAINING_OTEL_SERVICE_NAME=juzhou-agent-training-service
```

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
GET  /api/auth/status
GET  /api/health
```

`/api/health` 保留原字段并新增只读的 `reranker` / `rerankerOk` 与 `openTelemetry` 状态；URL 中的凭据和 Bearer token 不会回显。

除员工邀请能力接口外，`/api/*` 在启用 `TRAINING_ACCESS_KEY` 时都要求老板端认证。JSON 请求默认上限 1 MiB；非法 JSON/URI 返回 400，超限返回 413，缺失静态资源返回 404，只有无扩展名页面路由回退 `index.html`。未知 500 只向客户端返回通用错误，不暴露内部路径。WebSocket 要求浏览器同源、客户端掩码、合法 opcode，单条消息上限 1 MiB。

老板端 Agent：

```text
POST /api/agent/draft
POST /api/agent/dispatch
GET  /api/agent/stream
POST /api/chat                 # 可传 forceGeneralChat=true 跳过自动知识库答疑；可传 webSearchMode=on 为答疑/软文/翻译/普通聊天启用 Tavily 外部参考
GET  /api/tools/registry
GET  /api/agent-runs
GET  /api/agent-runs/:runId
GET  /api/traces
GET  /api/traces/:traceId
GET  /api/observability/summary?hours=24&skill=
```

`/api/observability/summary` 需要老板端认证。返回的“证据命中率”是线上检索调用是否返回至少一条可用证据，不等于离线带 ground truth 的 Hit@K。

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
- `/api/agent/stream` 的普通聊天只有收到 `done` 才视为完整结束；如果 WebSocket 在 `done` 前关闭，前端会保留已收到正文并标记 `streamIncomplete: true`，提示用户重新生成，不再把半截输出静默当成完成。
- OpenAI-compatible 流式响应会解析 `finish_reason`；当 `finish_reason=length` 时，聊天 payload 带 `finishReason: "length"` 和 `truncated: true`，前端显示“达到模型输出上限，回答可能不完整”。
- 软文、知识库答疑等结构化 JSON 生成也会透传 `finishReason` / `truncated`。营销软文正文清洗层不再固定裁到 1800 字符；当前按软文链路约 5200 字符上限清洗，超出上限时正文末尾可能保留省略号；模型达到输出上限时会通过 `finishReason` / `truncated` 和 warning 提示回答可能不完整。
- 会话列表按最后一条真实消息的 `lastMessageAt` 倒序；GET 读取会话、PATCH 标题/预览、前端恢复渲染只更新元数据，不应把会话顶到列表前面，只有追加新消息才会刷新排序时间。
- 翻译 skill 的助手消息以 `action: "translation"` 保存；缺正文时的追问以 `action: "translation_request"` 保存。
- 会话保留 30 天；过期会话和消息在读取/写入路径中清理或过滤。
- 删除聊天会话只删除/隐藏该会话历史，不删除 `tasks`、`invites`、`quizzes` 或本地 `memories`。
- 旧前端 `localStorage` 聊天记录只在用户确认导入后进入 `POST /api/boss-chat/import-local`，服务端保存为去 HTML/script 的安全文本 `local_transcript`，不复原成可执行富文本。

知识库和导入：

```text
GET  /api/knowledge-bases
GET  /api/knowledge-bases/:kbId/versions
GET  /api/knowledge-bases/:kbId/quality
GET  /api/imports
POST /api/imports/directory
POST /api/imports/upload
```

培训闭环：

```text
GET    /api/employees
GET    /api/reports/overview
POST   /api/tasks/publish      # 可传 webSearchMode=on，只影响发布时的培训讲义生成
GET    /api/tasks
GET    /api/tasks/:taskId
DELETE /api/tasks
DELETE /api/tasks/:taskId
GET    /api/invites/:token     # 有效邀请 token 可在未登录老板端时访问
POST   /api/answer             # 员工传 token；已认证调用方仍可传 taskId
POST   /api/quiz/generate      # 新增可选 token；已认证调用方保留 taskId 兼容
POST   /api/quiz/submit        # 员工传 token
```

记忆：

```text
GET    /api/memory
PATCH  /api/memory/:id
DELETE /api/memory/:id
DELETE /api/memory
```

OpenClaw 插件固定保留 8 个 training tool 名和既有 endpoint；`npm run check:plugin` 会做 TypeScript 语法、tool 清单和 endpoint 契约检查。

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

GPU reranker 可以部署为独立服务并由主服务通过内网 HTTP 调用。仓库中的 `ops/reranker-service` 提供 Windows 安装、计划任务、输入上限、日志轮转和验证脚本；token 只进入未跟踪的远程配置文件。`192.168.9.105` 是专用 reranker/benchmark 主机，不是培训生产服务器。

Windows Server 长期运行建议保留计划任务，但要去掉默认运行时长限制：

```powershell
Export-ScheduledTask -TaskName JuzhouAgentTraining | Out-File .\backups\JuzhouAgentTraining.before.xml
```

部署脚本支持以下约定；实际服务器状态必须以带日期的审计报告或当次授权检查为准：

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
npm run eval:streaming
npm run eval:web-search
npm run eval:marketing-uniqueness
npm run eval:marketing-length
npm run eval:boss-chat
npm run eval:translation
npm run eval:kb-versions
npm run benchmark:rag-scale -- --sizes=100,1000,5000 --queries=100 --concurrency=1,5,10,20
git diff --check
```

RAG 评测用例按领域拆分到 `scripts/fixtures/rag-eval-*-cases.mjs`，共 150 条：120 条开发/回归集、30 条冻结测试集，覆盖 60 条型号/参数、30 条语义改写/原理、20 条多语言、20 条跨知识库 hard negative 和 20 条无答案/拒答。60 条答案质量子集覆盖 45 条可回答和 15 条拒答，检查事实覆盖、禁止事实、数字/型号一致性、引用合法性、引用召回和明确拒答；2026-07-10 最终真实 DeepSeek 回归结果为忠实 42/45（93.33%）、引用 precision/recall=100%/100%、拒答 15/15，3 条失败均为期望事实覆盖不足，没有错误引用、禁止事实或网络失败混入通过结果。Agent trajectory fixture 共 30 条。Ollama 关闭时 `eval:rag -- --retrieval-only` 验证的是 BM25 环境降级；hybrid 与 hybrid+reranker 质量回归必须在对应运行状态下验收 Hit@1/3/5、MRR@5、nDCG@5、拒答、分层统计和降级行为。`eval:answer-evidence-gate` 防止拒答后绕过门禁回填，`eval:bm25-cache` 覆盖 JSON/SQLite 跨 load、同对象属性修改和 LRU，`eval:rag-scale-benchmark` 检查 requested/effective mode、降级硬门槛与原子 checkpoint；`eval:reranker` 覆盖正常、401、5xx、超时、超限与断连回退，`eval:observability` / `eval:tool-observability` 覆盖 token/cost/TTFT、工具业务失败、检索聚合及 OpenTelemetry no-op/脱敏。
翻译评测会创建临时 `TRAINING_DATA_DIR`，设置 `TRAINING_AUTH_DISABLED=1`，并启动本地 OpenAI-compatible mock 服务覆盖中英日西法、默认目标语言、缺正文追问、上一条老板端正文上下文、正文在前且翻译指令在末尾、长文本不静默截断、LLM API 缺失错误、`翻译成英文：这是一台水泵` 和 boss-chat 写入；同时断言“生成英文文章，同时附带中文翻译”不会被翻译 parser 抢走。
联网搜索评测 `npm run eval:web-search` 使用 mock Tavily 和 mock OpenAI-compatible LLM，覆盖知识库答疑、营销软文、培训讲义、考试生成、翻译、普通聊天六条生成链路：`off` 不调用 Tavily，`on` 返回 `webSources/webSourceRefs`，缺 key、500、超时、空结果都不打断原生成链路，并检查 prompt 已区分本地资料/联网资料且不会执行网页指令。
软文去重评测 `npm run eval:marketing-uniqueness` 使用 mock LLM 覆盖纯 JS 相似度算法、模板句命中、中英文混合文本、vendored avoid-ai-writing AI 写作痕迹检测、多篇文章生成、最近 3 天历史比对和自动重写闭环；当前夹具中英文 AI-heavy 样本 `aiWritingScore=78`，平实工业产品样本 `aiWritingScore=0`，首轮三篇高度相似稿会触发 1 次重写，最终同批相似度约 1.9%、历史最高相似度约 5%、AI 写作痕迹最高分 0。
服务器审计是显式授权的独立流程，脚本输出到 `server-audit-output`，再由 `server-audit:report` 刷新带日期的 `docs/PERFORMANCE_AUDIT.md` / `docs/RESUME_EVIDENCE.md`。长期有效的架构说明不把某次服务器状态写成当前事实。

## 当前限制

- `TRAINING_ACCESS_KEY` 不是完整多账号权限体系。
- SQLite 适合当前单机部署，不是最终多租户 SaaS 数据库。
- 本地记忆只能补默认偏好，不能覆盖用户当前明确指令，也不能当产品事实库。
- 图片型 PDF 视觉补全是人工式资料治理流程，不是可规模化自动 OCR 平台。
- Qdrant 是可选后端；更换 embedding 模型后必须重建对应向量索引。
