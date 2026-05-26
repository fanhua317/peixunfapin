# 钜洲培训 Agent MVP

这个目录包含独立于 OpenClaw 主仓库的培训系统 MVP：

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
```

3. 在 OpenClaw 中安装插件：

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

## 推荐开发顺序

1. 先用 Web 页面跑通老板发布任务、员工链接学习、考试和报表。
2. 再安装 OpenClaw 插件，让 Agent 调用 `training-service`。
3. 最后再考虑小红书、公众号或企业微信等发布/通知渠道。

## 当前架构

`training-service` 已按轻量分层拆分：

```text
src/server.mjs      # 只负责启动原生 HTTP server
src/http            # 请求解析、认证、静态文件、API controller
src/domain          # 知识库、员工、任务、邀请、考试、报表业务逻辑
src/ai              # 意图识别、讲义、答疑、出题、LLM JSON 调用
src/intent-confirmation.mjs # 操作确认 token，防止误确认执行
src/agent-trace.mjs # Agent 路由轨迹 JSONL 日志
public/src          # 无构建浏览器 ES modules
```

`training-plugin` 保留 8 个 OpenClaw tool 名不变，内部拆成配置、HTTP client、schema 和 tool 定义。

常用验证：

```powershell
cd D:\juzhou-agent\peixun\training-service
npm run check
npm run smoke
npm run eval:rag -- --retrieval-only
npm run eval:intent
```

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
```

网页老板端会先做意图路由：发布培训、查询进度等培训意图走系统内置技能；其他普通聊天只走直连大模型 API。未配置 `TRAINING_LLM_API_KEY`、`DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY` 时，普通聊天会明确报配置缺失，不使用本地话术。

意图路由采用防误判机制：本地规则先判断高置信操作，模糊表达可交给 LLM router，低置信或高风险操作返回确认卡片。确认执行时必须带服务端签发的 `confirmationToken`，token 会绑定原始消息和 skill，过期、缺失或消息被替换都会拒绝执行。每次 `/api/agent/dispatch` 和 `/api/agent/stream` 的路由结果会写入数据目录下的 `agent-traces.jsonl`，可用 `TRAINING_AGENT_TRACE=0` 关闭。

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

