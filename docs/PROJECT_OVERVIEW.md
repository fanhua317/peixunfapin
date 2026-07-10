# 钜洲培训 Agent 项目总览

更新时间：2026-07-10

## 1. 项目定位

钜洲培训 Agent 是一个本地部署的企业资料培训系统。它不是单纯聊天壳，也不是纯 RAG demo，而是把资料导入、检索、Agent 路由、培训发布、员工学习、答疑、考试、报表、营销软文、记忆、任务中心和运行轨迹连成业务闭环。

默认运行路径是独立的 `training-service`。OpenClaw Gateway 和 OpenClaw 插件保留为可选兼容入口，用于让外部 Agent 调用 8 个 training tool；网页端和核心培训流程不依赖 OpenClaw 才能运行。

## 2. 设计原则

- 不引入 Express/Fastify，后端继续使用 Node.js 原生 HTTP。
- 前端使用无构建 ES modules，页面入口由 `bootstrap.js` 按路由分发。
- 业务状态默认存 SQLite，JSON 文件保留为迁移、导出和回滚格式。
- 讲义、答疑、考试、软文必须基于知识库来源；资料不足时拒绝编造。
- 没有可用大模型 API 时，不生成讲义、不出题、不写软文。
- 高风险动作必须确认，包括发布、删除、回滚、恢复、清空记忆等。
- RAG 不只靠 embedding，主路径是 BM25 + BGE-M3 hybrid + parent-child 上下文，可选 BGE reranker 重排并自动降级。
- 可观测性以 Agent Run 为本地事实源，OpenTelemetry 只做可选外部导出；不保存完整 prompt、回答或密钥。
- 本地改动默认只提交并推送 GitHub，不自动连接、更新或重启服务器；部署必须获得当前任务的明确授权。

## 3. 系统分层

```text
browser
  ├─ boss chat / imports / jobs / traces
  └─ employee learning / quiz
       ↓
native HTTP server
       ↓
controllers
       ↓
agent runtime / domain / import / jobs / memory / rag / ai
       ↓
SQLite + JSONL + local vector index + clean documents
```

主要模块：

- `src/http`：请求解析、响应、认证、静态文件和路由基础能力。
- `src/http/controllers`：HTTP API 适配层。
- `src/agent`、`src/tools`、`src/agent-runs`：Agent 运行治理、Tool Registry、Run/Step 记录。
- `src/domain`：培训、员工、邀请、考试、报表等业务逻辑。
- `src/rag.mjs`、`src/reranker.mjs`：BM25、向量检索、parent-child 展开、证据门禁和远程重排降级。
- `src/observability`：AsyncLocalStorage 关联 Run、LLM、tool、RAG 和 reranker 指标，可选导出 OTLP spans。
- `src/ai`、`src/chat`：意图识别、普通聊天、多语言翻译、讲义、答疑、出题、软文和 LLM 调用。
- `src/import`：资料清洗、语义切片、导入写入和质量统计。
- `src/jobs`：异步任务队列，覆盖导入、embedding 和知识库回滚。
- `src/memory`：短期会话记忆、长期偏好记忆和记忆策略。
- `src/boss-chat`：老板端会话历史、消息追加、30 天保留和旧本地记录导入。
- `public/src`：无构建前端模块。

## 4. 核心流程

### 老板发布培训

```text
用户输入培训需求
-> 记忆召回补默认值
-> 混合意图识别
-> create_training_draft
-> RAG 选择知识库和上下文
-> 返回确认草稿
-> 用户短确认
-> 发布任务并生成邀请链接
```

重新输入完整培训安排时，应生成新草稿，不直接发布旧草稿。

### 员工学习、答疑和考试

```text
员工打开 /t/:token
-> 以邀请 token 作为员工能力凭证并校验有效期
-> 查看讲义
-> 基于任务资料提问
-> 生成考试
-> 提交答案
-> 记录成绩并更新报表
```

启用老板访问密钥时，员工页仍可凭有效邀请 token 完成打开、答疑、取题和提交；无效、过期或与任务不匹配的 token 会被拒绝。重复考试以最新有效提交作为报表参考。

### 营销软文

```text
用户请求软文
-> 快速 LLM Router 判定 generate_marketing_article
-> 匹配知识库
-> hybrid RAG 获取产品卖点和应用场景
-> 用户开启联网搜索时补充 Tavily 选题/开头/市场场景参考
-> LLM 按差异化角度生成结构化文章数组
-> 重复率和 AI 写作痕迹评估，必要时自动重写最多 2 轮
-> 前端展示文章卡片、来源、重复率和 AI 写作痕迹指标
```

软文生成默认不联网；显式传 `webSearchMode: "on"` 时，Tavily 结果可作为选题、开头角度、买家痛点、地区/应用场景和市场表达来源，产品事实、参数、认证、性能声明和卖点仍以本地知识库为准。软文链路使用营销专用温度，默认 `TRAINING_MARKETING_TEMPERATURE=0.6`；营销专用联网数量默认 `TRAINING_MARKETING_WEB_SEARCH_MAX_RESULTS=8`，搜索深度默认 `basic`。资料不足时返回“资料不足”，不编造产品参数。“请帮我生成三篇水泵的宣传文章，500词左右，英文”和“请帮我生成三篇英文文章，同时附带中文翻译”都属于 `generate_marketing_article`；后者的中文翻译是文章交付格式要求，不是单独的 `translate_text`。
软文 prompt 直接约束首轮输出减少“AI 味”：文章要像外贸水泵销售工程师或工业品内容编辑写给真实客户看的内容，不能用内部资料摘要、参数罗列或 “In today's...” 类泛泛开头，优先从客户问题、地区场景、农场/灌溉/偏远地区、柴油替代、维护成本或选型风险切入；多篇文章会分配应用场景型、采购决策型、技术卖点型、维护成本型、客户沟通型等角度，要求开头、段落结构、小标题顺序和结尾句式不得复用；同时固定 vendoring `conorbronsdon/avoid-ai-writing` 的 MIT detector，检测英文 AI-isms、模板转场、夸张营销词、万能结尾和 chatbot 式客套。自然化表达不能新增资料外细节。
软文去重和 AI 写作痕迹检查默认开启。后端使用纯 JS 计算中文 4/5-gram、英文 3-gram、分句重复、同批相似度、标题相似度、模板句命中、最近 3 天老板端历史软文最高相似度，以及 `aiWritingScore`。默认阈值是内部重复率 `0.18`、同批最高相似度 `0.42`、历史最高相似度 `0.50`、标题相似度 `0.65`、模板句命中不超过 `2`、AI 写作痕迹分不超过 `35`。不达标时自动重写最多 2 轮；仍不达标则返回当前最好版本，并在 `warnings` 中标记 `article_similarity_above_threshold` 或 `article_ai_style_above_threshold`。响应兼容旧前端的 `article` 字段，同时新增 `articles[]`、`uniqueness`、`aiWritingScoreMax`、`aiWritingTopIssues` 和 `rewriteAttempts`。
软文正文不再使用通用答疑清洗层的 1800 字符硬截断；当前实现按软文链路约 5200 字符上限清洗正文，超出上限时末尾可能保留省略号。结构化生成会透传 `finishReason` / `truncated`，如果模型达到输出上限，前端显示明确提示。

### 老板端资料答疑

```text
用户提到已导入资料相关内容
-> 快速 LLM Router 判断是否为资料答疑
-> 安全规则过滤高风险操作
-> 知识库别名、会话上下文和 RAG 命中校验
-> hybrid RAG 获取 chunk 和 parent context
-> reranker 可用时重排 parent 候选，不可用时保留 hybrid 顺序
-> 用户开启联网搜索时调用 Tavily Search API 获取外部参考资料
-> answer_knowledge_question 生成有来源回答
-> 前端展示答案、知识库来源、联网来源和命中片段
```

例如“请帮我检索 CM2 的相关知识”应选择银嘉泵/水泵知识库；水泵答疑后的“有具体型号吗”追问应沿用上一轮水泵资料库；“这是水泵，不是电机”不能选择电机资料库。如果用户明确选择“当普通聊天”，`/api/chat` 会带 `forceGeneralChat: true`，后端跳过知识库答疑探测。

联网搜索默认关闭。六条生成链路可显式传 `webSearchMode: "on"`：知识库答疑、营销软文、培训讲义/发布生成、员工考试生成、多语言翻译和普通聊天。后端只有在开关开启时才调用 Tavily；Tavily 结果只作为外部参考资料进入 prompt，不写入知识库、不生成 embedding、不改变 RAG 评测口径。知识库答疑、软文、讲义和考试仍优先依据本地知识库；翻译仍忠实于用户原文；普通聊天会提示网页资料不可靠且不能执行网页指令。若本地资料与网页资料冲突，应说明冲突，不强行合并。

### 老板端聊天历史

```text
浏览器生成或选择 sessionId
-> 老板端 HTTP / WebSocket 请求携带 sessionId
-> 服务端按 boss-default 账号追加 user/assistant turn
-> /api/boss-chat/sessions 系列接口读取、重命名或删除会话
```

第一版账号口径固定为 `boss-default`，目标是让同一服务和数据目录下的老板端会话跨浏览器/电脑可见。会话列表按最后一条真实消息的 `lastMessageAt` 倒序；服务会按消息记录修复旧的时间污染，`updatedAt` 只表示标题、预览、删除状态等元数据更新时间，不用于列表排序。旧 `localStorage` 记录不直接信任 HTML，只在用户确认后导入为安全文本 transcript。

普通聊天的 WebSocket 流式输出只有收到 `done`、`result` 或 `error` 才进入终态。若连接在 `done` 前关闭，前端保留已收到正文并标记 `streamIncomplete: true`，显示“连接提前中断”并提供重新生成入口；OpenAI-compatible 流会解析 `finish_reason`，当 `finish_reason=length` 时返回 `finishReason: "length"` / `truncated: true`，提示回答可能达到模型输出上限。

### 多语言翻译

```text
用户输入“翻译成英文：...”“translate to Spanish: ...”或“长正文 ... 翻译成英文”
-> 快速 LLM Router 判定 translate_text
-> 翻译 parser 校验它确实是已有文本翻译
-> 解析 targetLanguage 和 sourceText
-> sourceText 为空时读取同 session 上一条正文
-> 仍无正文则返回 translation_request
-> OpenAI-compatible LLM 生成 translatedText
-> action translation 写入老板端聊天历史
```

默认目标语言规则是英文正文翻译成中文、中文正文翻译成英文；显式目标语言优先。`翻译成英文：这是一台水泵` 属于 `translate_text`。翻译输入不静默截断，默认超过 `TRAINING_TRANSLATION_MAX_SOURCE_CHARS=30000` 时提示分段或调整配置。开启 `webSearchMode: "on"` 时，联网资料只用于术语/行业背景参考，不改变原文忠实翻译原则，也不会把网页内容额外翻进译文。缺少大模型 API 时返回 `action: "translation"` 和清晰错误，不伪造翻译。

## 5. Agent 运行治理

网页端内部 skill 包括：

- `create_training_draft`
- `show_training_status`
- `delete_training_records`
- `generate_marketing_article`
- `answer_knowledge_question`
- `answer_general_chat`
- `translate_text`（多语言翻译，HTTP action 使用 `translation` / `translation_request`）

OpenClaw 插件保留 8 个 training tool：

- `training_list_knowledge_bases`
- `training_search_employees`
- `training_create_task_draft`
- `training_publish_task`
- `training_get_task_status`
- `training_answer_question`
- `training_generate_quiz`
- `training_grade_answer`

一次 `/api/agent/dispatch`、`/api/agent/stream` 或 `/api/chat` 请求会生成一个 Agent Run。Run step 通常包括：

```text
memory_recall
-> state_load
-> intent_route
-> confirmation_verify
-> tool_execute
-> memory_write
-> result_output
```

Run 和 Trace 只保存脱敏摘要、message hash、message preview、意图、skill、action、耗时和错误，不保存完整 API Key、prompt 或模型输出。每个新 Run 的 `summary.observability` 聚合 LLM token/成本/TTFT、工具成功率、线上证据命中、检索与 rerank 延迟和降级原因；历史 Run 缺少指标时保持“无数据”。

`GET /api/observability/summary?hours=24&skill=` 提供老板鉴权后的时间窗聚合。线上证据命中率表示“检索调用返回至少一条可用证据”，与离线 ground-truth Hit@K 是两种指标，不能混用。OpenTelemetry 默认关闭；开启后可向 OTLP HTTP collector 导出 `agent.run`、`agent.tool`、`rag.retrieve`、`rag.rerank` 和 `llm.chat` spans，没有 collector 时本地指标仍正常写入。

## 6. 意图识别与安全门禁

路由策略是快速 LLM Router 优先 + 安全规则门禁 + RAG 证据校验：

HTTP 层把老板认证与员工邀请能力分开：老板 API 继续使用访问密钥或登录 Cookie；员工只在 `/api/invites/:token`、`/api/answer`、`/api/quiz/generate`、`/api/quiz/submit` 使用有效邀请 token。JSON/WS 消息默认限制 1 MiB，非法 JSON/URI、静态资源缺失、跨源或不合规 WebSocket 帧都有明确状态码或关闭码，内部 500 不暴露文件路径。

- 快速 LLM Router 先判断应调用的 skill，覆盖软文、翻译、知识库答疑、培训、进度、删除和普通聊天。
- 本地规则只处理高风险确认、Router 不可用兜底和少量确定性 parser 校验。
- 低置信操作返回 `intent_confirm`。
- 删除、发布、回滚、恢复、清空记忆等高风险动作必须确认。
- 明确翻译请求属于低风险 skill；只有缺正文时返回 `translation_request`，不进入发布或删除确认流，也不能抢走文章生成需求。
- 资料相关问题会走 `answer_knowledge_question`，但必须先满足知识库别名、会话上下文或领域信号，并通过 RAG 命中门槛。
- 普通聊天默认走 `answer_general_chat`，不能被宽泛关键词或无关高分 chunk 误拦成操作或资料答疑。

模型判定错误时，前端确认卡片允许用户改为普通聊天、重新输入或确认执行；后端仍按 Tool Registry 的风险等级和确认要求做最终门禁。

## 7. RAG 策略

### 业务语义切片

导入阶段优先生成 parent-child 结构：

- parent：完整业务语义块，用于生成答案。
- child：较小检索块，用于 BM25 和向量召回。
- `businessKeys`、`searchText`、标题、来源和表格字段会进入检索文本。

电机资料按知识点、型号、系列、表格行和结构部件尽量保持业务完整性。对于法律、合同等强条款结构资料，后续接入时应增加专门切片规则，避免把“第三条第二款”和“第三条之二”等不同条款混在一起。

### 混合检索

```text
query
-> BM25 child hits
-> vector child hits
-> score normalization
-> weighted fusion
-> same parent dedupe
-> optional bge-reranker-v2-m3 over at most 20 parent candidates
-> 0.75 * rerankerNormalized + 0.25 * hybridNormalized
-> parent context rendering
```

参数、型号、功率、能效、条款类问题会提高 BM25 权重；口语化问题更多依赖向量召回。Reranker 请求最多 50 个文档、单段最多 4000 字符，默认候选 20 个。未配置、超时、鉴权失败、5xx 或模型不可用时保留 hybrid 排序；向量不可用时使用 BM25-only，服务仍可答复基于文本的请求。

2026-07-10 至 2026-07-11 的隔离规模基准表明，把导入、全量 embedding、资源峰值、质量、错误和模式降级一起纳入统一门槛后，最大严格通过 100 文件/并发 20。仅看 5 次预热后的查询层，5000 文件 BM25 在并发 20 时 p95=22 ms；hybrid+reranker 在并发 5 时 p95=1668 ms 且无降级，并发 10 虽 p95=3271 ms 但发生 1 次回退。该结论来自合成语料，不替代 150 条真实分层评测，完整证据见 [RAG_BENCHMARK.md](RAG_BENCHMARK.md)。

### 资料质量

系统会统计文档数、父块数、子块数、表格行父块、OCR/图片占位、短文本、低价值片段和最长子块。低价值或占位内容不应进入最终提示词。

图片型 PDF 当前采用人工式视觉补全流程：渲染页面图片、识别可读内容、整理 Markdown、重新导入和重建向量索引。型号参数表类资料按“系列 -> 型号 -> 参数行”整理，例如银嘉泵目录补全后可按 VM22、QB60、WZB750 等具体型号检索。该流程不等同于自动 OCR 平台。

## 8. 数据与持久化

SQLite 默认保存：

- 知识库、文档、父块、子块。
- 员工、任务、邀请、考试、答题、事件。
- 本地记忆。
- 任务队列。
- Agent Run 和 Step。
- 知识库当前版和上一版快照。
- 老板端聊天会话和消息，随 SQLite schemaVersion `5` 使用 `boss_chat_sessions` / `boss_chat_messages`。

仍保留的文件：

- `conversation-history.jsonl`：完整聊天历史追加日志。
- `boss-chat-sessions.json`：老板端聊天历史的 JSON 回滚文件。
- `agent-traces.jsonl`：脱敏 trace。
- `vector-index-bge-m3.json`：本地向量索引。
- `state.json` / `memory.json`：迁移、导出和 JSON 回滚格式。

`state.json meta.version` 保持 `1`；SQLite 内部 schema 独立演进。

业务状态、记忆、老板聊天、Jobs 和知识库版本的 JSON 回滚存储采用串行写队列与原子替换。SQLite/JSON 的业务状态提交都经过进程内串行化；讲义、出题、文件读取和切片在锁外执行，提交阶段复核知识库或任务版本，避免丢写和长时间占锁。

老板端聊天历史保留 30 天。列表按最后一条真实消息的 `lastMessageAt` 排序，GET 读取、PATCH 标题/预览和前端恢复渲染不改变排序位置，追加新消息才会刷新排序时间。删除某条聊天会话只影响该会话历史，不应删除培训任务、邀请、考试或本地记忆。

## 9. 记忆模块

记忆分三类：

- 短期会话：最近对话和摘要，用于普通聊天连续性。
- 长期偏好：软文风格、默认题数、默认及格分等低风险偏好。
- 工作流经验：用户纠正过的交互规则，例如“重新输入不是确认发布”。

记忆只能补默认值，不能覆盖用户当前明确指令，不能自动触发高风险动作，也不能当作产品事实库。产品事实仍必须来自知识库 RAG。

## 10. 导入、任务和版本

导入管理支持本机目录和浏览器上传。导入任务进入本地任务队列，成功后可自动创建 `embed_local` 子任务。

上传暂存目录使用 UUID 并做路径边界校验；成功、失败或取消后只删除系统自建暂存目录，不删除用户源目录。导入、embedding 和回滚属于同一知识数据资源，按串行顺序执行。

知识库保留当前版和上一版：

- 同名导入成功后生成文档级差异。
- 可查看新增、删除、变更、未变文档。
- 回滚通过异步任务执行。
- 回滚不影响培训任务、邀请、考试、记忆、Trace 或 Jobs。

## 11. 部署架构

本地开发：

```text
Node service + SQLite + local files + optional Ollama
```

轻量 Windows Server：

```text
Scheduled Task: JuzhouAgentTraining
Scheduled Task: JuzhouAgentTrainingWatchdog
Scheduled Task: JuzhouAgentTrainingBackup
Scheduled Task: JuzhouAgentOllama
SQLite
vector-index-bge-m3.json
optional Ollama bge-m3 query embedding
DeepSeek/OpenAI-compatible chat API
```

可选专用 GPU Reranker：

```text
Windows GPU host
Scheduled Task: JuzhouAgentReranker
FastAPI :8910 + bearer token + LAN firewall
BAAI/bge-reranker-v2-m3
7-day rotated logs
```

部署脚本支持“主计划任务 + watchdog + 备份任务 + Ollama 任务”：`JuzhouAgentTraining` 运行 `start-server.ps1`，watchdog 检查 8787 端口、首页和 `/api/health`，备份任务执行生成、校验和保留策略，Ollama 任务只提供本机 query embedding。专用 GPU Reranker 独立于培训服务部署；当前 `192.168.9.105` 只用于明确授权的 reranker/benchmark，不是培训生产服务器。这里描述的是可用部署结构，不代表任何服务器实时状态；实际状态只引用带日期的审计证据。

Qdrant 是可选部署，不是低并发轻量服务器默认项。使用 Qdrant 时，需要单独备份 volume 或 snapshot。

## 12. 关键环境变量

| 变量 | 作用 |
| --- | --- |
| `TRAINING_ACCESS_KEY` | 老板端访问密钥 |
| `TRAINING_DATA_ROOT` | 项目运行数据根目录 |
| `TRAINING_DATA_DIR` | 索引、数据库和日志目录 |
| `TRAINING_STORAGE` | `sqlite` 或 `json` |
| `TRAINING_SQLITE_PATH` | SQLite 文件路径 |
| `TRAINING_LLM_PROVIDER` | `auto` 或 `openclaw` |
| `TRAINING_LLM_BASE_URL` | OpenAI-compatible API 地址 |
| `TRAINING_LLM_MODEL` | 生成模型名 |
| `TRAINING_LLM_API_KEY` | 生成模型 API key |
| `TRAINING_WEB_SEARCH_PROVIDER` | 联网搜索 provider，当前为 `tavily` |
| `TRAINING_WEB_SEARCH_API_KEY` / `TAVILY_API_KEY` | Tavily Search API key |
| `TRAINING_WEB_SEARCH_MAX_RESULTS` | 单次联网搜索返回数量，默认 5 |
| `TRAINING_WEB_SEARCH_SEARCH_DEPTH` | Tavily 搜索深度，默认 `basic` |
| `TRAINING_MARKETING_TEMPERATURE` | 软文专用生成温度，默认 `0.6` |
| `TRAINING_MARKETING_WEB_SEARCH_MAX_RESULTS` | 软文联网搜索返回数量，默认 8 |
| `TRAINING_MARKETING_WEB_SEARCH_SEARCH_DEPTH` | 软文 Tavily 搜索深度，默认 `basic` |
| `TRAINING_MARKETING_UNIQUENESS_ENABLED` | 软文重复率检查开关，默认 `1` |
| `TRAINING_MARKETING_REWRITE_ATTEMPTS` | 软文自动重写轮数，默认 2 |
| `TRAINING_MARKETING_HISTORY_DAYS` | 历史软文相似度比对窗口，默认最近 3 天 |
| `TRAINING_MARKETING_HISTORY_LIMIT` | 历史软文比对上限，默认 50 篇 |
| `TRAINING_MARKETING_INTERNAL_REPEAT_MAX` | 单篇内部重复率阈值，默认 `0.18` |
| `TRAINING_MARKETING_BATCH_SIMILARITY_MAX` | 同批文章最高相似度阈值，默认 `0.42` |
| `TRAINING_MARKETING_HISTORY_SIMILARITY_MAX` | 历史文章最高相似度阈值，默认 `0.50` |
| `TRAINING_MARKETING_TITLE_SIMILARITY_MAX` | 同批标题最高相似度阈值，默认 `0.65` |
| `TRAINING_MARKETING_TEMPLATE_HITS_MAX` | 模板句命中阈值，默认 `2` |
| `TRAINING_MARKETING_AI_STYLE_ENABLED` | 软文 AI 写作痕迹检测开关，默认 `1` |
| `TRAINING_MARKETING_AI_SCORE_MAX` | AI 写作痕迹分阈值，默认 `35` |
| `TRAINING_MARKETING_AI_STYLE_TOP_ISSUES` | 返回的 AI 写作问题类型数量，默认 `8` |
| `TRAINING_HYBRID_RETRIEVAL` | 是否启用 hybrid 检索 |
| `TRAINING_VECTOR_BACKEND` | `auto`、`local` 或 `qdrant` |
| `TRAINING_EMBEDDING_MODEL` | embedding 模型名 |
| `OLLAMA_URL` | Ollama 地址 |
| `TRAINING_RERANKER_ENABLED` | 是否显式启用已通过 A/B 验收的远程重排，默认关闭 |
| `TRAINING_RERANKER_URL` | Reranker 内网地址 |
| `TRAINING_RERANKER_API_KEY` | 独立 Bearer token，仅放未跟踪环境文件 |
| `TRAINING_RERANKER_MODEL` | 默认 `BAAI/bge-reranker-v2-m3` |
| `TRAINING_RERANKER_TIMEOUT_MS` | 重排超时，默认 15000 ms |
| `TRAINING_RERANKER_CANDIDATES` | 重排候选数，默认 20，上限 50 |
| `TRAINING_RERANKER_WEIGHT` | 最终融合中的重排权重，默认 `0.75` |
| `TRAINING_LLM_*_COST_PER_MILLION` | 可选 token 单价快照，不在代码中写死 |
| `TRAINING_LLM_PRICE_SOURCE_DATE` | 成本价格快照日期；未配置则成本为“无数据” |
| `TRAINING_OTEL_ENABLED` | OpenTelemetry 导出开关，默认关闭 |
| `TRAINING_OTEL_OTLP_ENDPOINT` | OTLP HTTP trace endpoint |
| `PUBLIC_BASE_URL` | 固定邀请链接域名 |
| `TRAINING_AGENT_TRACE` | 是否写入脱敏 trace |
| `TRAINING_BACKUP_RETENTION_DAYS` | `backup-server.ps1` 默认保留天数 |
| `TRAINING_BACKUP_KEEP_LAST` | `backup-server.ps1` 至少保留的最近备份份数 |
| `TRAINING_BACKUP_OUT` | 备份输出目录或指定 ZIP 路径 |

## 13. 验证体系

常用命令：

```powershell
npm run check
npm run smoke
npm run eval:rag -- --retrieval-only
npm run eval:reranker
npm run eval:observability
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

RAG 评测集按领域维护，共 150 条：120 条开发/回归集、30 条冻结测试集；分类为 60 条型号/参数、30 条语义改写/原理、20 条多语言、20 条跨知识库 hard negative、20 条无答案/拒答。60 条真实答案子集进一步检查事实忠实、禁止事实、数字/型号一致性、引用 precision/recall 和明确拒答；2026-07-10 最终实测为忠实 42/45（93.33%）、引用 precision/recall=100%/100%、拒答 15/15。3 条未通过用例均为期望事实覆盖不足，没有错误引用、禁止事实或网络失败混入通过结果。Agent trajectory 从 14 条扩到 30 条。Ollama 关闭时评测结果属于 BM25 环境降级；hybrid 与 hybrid+reranker 验收必须先确认对应运行状态，再比较 Hit@1/3/5、MRR@5、nDCG@5、拒答和分层失败样本。备份评测覆盖 SQLite 快照、JSONL/向量索引打包、校验、强制恢复和备份保留策略。
翻译评测 `npm run eval:translation` 不依赖真实模型质量：脚本使用临时数据目录和本地 OpenAI-compatible mock，覆盖显式目标语言、默认目标语言、无正文追问、老板端上一条正文上下文、正文在前且翻译指令在末尾、长文本不静默截断、LLM API 缺失错误、`翻译成英文：这是一台水泵` 和 boss-chat 持久化，并断言“生成英文文章，同时附带中文翻译”不会被翻译 parser 抢走。
软文去重评测 `npm run eval:marketing-uniqueness` 使用 mock LLM 和临时老板端历史，覆盖相同文章高相似、仅共享产品型号不误判、模板句命中、中英文混合重复、avoid-ai-writing AI 写作痕迹检测、三篇文章结构化返回、最近 3 天历史窗口过滤和自动重写闭环。当前夹具英文 AI-heavy 样本 `aiWritingScore=78`、平实工业产品样本 `aiWritingScore=0`；首轮三篇高度相似稿触发 1 次重写，最终 `overallStatus=ok`、同批最高相似度约 `0.019`、历史最高相似度约 `0.05`、AI 写作痕迹最高分 `0`。
服务器审计属于显式授权的独立流程。脚本、原始 artifact 和带日期结论分别位于 `server-audit:*`、`training-service/server-audit-output` 和 `docs/PERFORMANCE_AUDIT.md` / `docs/RESUME_EVIDENCE.md`；本总览只保留长期有效的架构与验证口径。

## 14. 主要风险

- 资料质量仍是效果上限。扫描型 PDF、图片、目录页、低价值页眉会影响生成质量。
- SQLite 适合当前单机部署，不是最终多租户 SaaS 数据库。
- 本地记忆需要可查看、可删除、可确认，避免“偷偷记住”。
- 老板端旧本地聊天记录导入需要确认，并且只能作为安全文本 transcript 进入服务端历史。
- 大模型仍可能表达偏差，必须依赖来源引用、低置信拒答和评测约束。
- 服务器资源有限时，不建议同时运行完整聊天模型、Qdrant 和重型 embedding 服务。
- 远程 reranker 是可降级依赖；内网、token、计划任务、显存和超时都必须监控，不能把它变成答疑单点故障。
- 5000 文件时 JSON 向量索引约 258 MiB，继续扩容应评估增量索引、Qdrant 和进程/队列隔离。
- `TRAINING_ACCESS_KEY` 不是完整账号体系，公网部署时仍需反向代理、HTTPS、防火墙和更细权限。

## 15. 后续方向

短期：

- 完善导入页面的质量说明和批量资料治理体验。
- 增加备份失败告警、异地副本和恢复演练记录。
- 在服务器定期复跑 `server-audit:*`，沉淀真实性能趋势和容量上限。
- 扩展更多业务资料的语义切片规则。

中期：

- 增加完整账号和权限体系。
- 把报价表、阿里发布、图片资产和视频生成接成独立 skill。
- 引入更成熟的 OCR/版面解析流水线。

长期：

- 从单机 SQLite 演进到多用户数据库和对象存储。
- 增加多租户、审计、审批和企业级运维。
- 持续扩充冻结测试集和真实答案抽样，并将 OTLP traces 接入正式 collector/告警平台。
