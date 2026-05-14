# 通用助手 OpenClaw 转接配置

网页端现在分为两类问题：

- 培训任务类：创建培训、发布员工链接、查询进度、考试等，由本地 `training-service` 处理。
- 通用问题类：例如“今天天气怎么样”“帮我写一段通知”，会转到 `POST /api/chat`，再由服务端转发给 OpenClaw Gateway。

## 当前行为

`training-service` 只是网页套壳和业务服务，不直接暴露 OpenClaw 密钥给浏览器。

前端调用：

```text
POST /api/chat
```

后端再连接 OpenClaw Gateway WebSocket，并调用：

```text
chat.send
```

默认配置：

```text
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_AGENT_ID=training-manager
OPENCLAW_SESSION_KEY=agent:training-manager:main
```

如果 OpenClaw Gateway 未运行或凭据不正确，`/api/chat` 会返回兜底说明，不会再误当成培训任务。

例如问：

```text
今天天气怎么样？
```

系统会把问题交给 OpenClaw 里已配置的 Agent。是否能查到实时天气，取决于该 Agent 是否拥有联网、浏览器或天气工具。

## 连接 OpenClaw Gateway

启动服务前设置环境变量：

```powershell
$env:OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789"
$env:OPENCLAW_GATEWAY_TOKEN="你的 Gateway Token"
$env:OPENCLAW_AGENT_ID="training-manager"
$env:OPENCLAW_SESSION_KEY="agent:training-manager:main"
node src/server.mjs
```

如果 Gateway 使用 password 认证：

```powershell
$env:OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789"
$env:OPENCLAW_GATEWAY_PASSWORD="你的 Gateway Password"
$env:OPENCLAW_AGENT_ID="training-manager"
$env:OPENCLAW_SESSION_KEY="agent:training-manager:main"
node src/server.mjs
```

## 可用变量

- `OPENCLAW_GATEWAY_URL`：OpenClaw Gateway WebSocket 地址。
- `OPENCLAW_GATEWAY_TOKEN`：Gateway token 认证。
- `OPENCLAW_GATEWAY_PASSWORD`：Gateway password 认证。
- `OPENCLAW_AGENT_ID`：默认 Agent id，未指定 session key 时使用。
- `OPENCLAW_SESSION_KEY`：目标会话，默认 `agent:training-manager:main`。
- `OPENCLAW_CHAT_TIMEOUT_MS`：等待 OpenClaw 回复的超时时间，默认 120000。
