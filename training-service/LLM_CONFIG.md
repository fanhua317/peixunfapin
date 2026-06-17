# LLM Provider 兼容说明

`training-service` 的默认模型调用路径是 OpenAI-compatible HTTP API。当前推荐配置 DeepSeek；OpenClaw Gateway 只作为可选兼容 provider，不是网页端普通聊天或培训生成的默认依赖。

## 默认：OpenAI-compatible API

```env
TRAINING_LLM_PROVIDER=auto
TRAINING_LLM_BASE_URL=https://api.deepseek.com/v1
TRAINING_LLM_MODEL=deepseek-chat
TRAINING_LLM_API_KEY=...
```

兼容变量仍可使用：

```env
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat
OPENAI_API_KEY=...
```

`TRAINING_LLM_API_KEY` 优先级最高；未设置时再读取兼容变量。

## 可选：OpenClaw Gateway

只有显式设置下面的变量时，服务才会尝试通过 OpenClaw Gateway：

```env
TRAINING_LLM_PROVIDER=openclaw
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=...
OPENCLAW_GATEWAY_PASSWORD=...
OPENCLAW_AGENT_ID=training-manager
OPENCLAW_SESSION_KEY=agent:training-manager:main
OPENCLAW_CHAT_TIMEOUT_MS=120000
```

该模式用于兼容历史 OpenClaw Agent 和插件编排。网页端、RAG、培训发布和软文功能不要求 OpenClaw Gateway 存在。

## 失败行为

- 未配置可用模型 API 时，普通聊天会返回明确的配置缺失错误。
- 讲义、试题和软文生成不会使用本地模板兜底，也不会假装调用成功。
- OpenClaw Gateway 连接失败时，只影响显式选择 `TRAINING_LLM_PROVIDER=openclaw` 的调用路径。

## 相关文档

- [README.md](README.md)：服务运行和部署配置。
- [../docs/PROJECT_OVERVIEW.md](../docs/PROJECT_OVERVIEW.md)：系统架构和模型调用位置。
