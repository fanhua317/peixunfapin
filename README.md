# OpenClaw Training MVP

这个目录包含独立于 OpenClaw 主仓库的培训系统 MVP：

```text
training-service  # Web/API 服务，保存业务数据并提供老板/员工页面
training-plugin   # OpenClaw 外部插件，把培训服务暴露为 Agent tools
```

## 快速启动

1. 启动培训服务：

```powershell
node D:\OpenClaw\peixun\training-service\src\server.mjs
```

2. 打开老板后台：

```text
http://127.0.0.1:8787/
```

3. 在 OpenClaw 中安装插件：

```powershell
openclaw plugins install "D:\OpenClaw\peixun\training-plugin"
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

## 打包给 Windows 用户

生成绿色版 ZIP 和自解压安装 EXE：

```powershell
cd D:\OpenClaw\peixun
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1 -IncludeData
```

输出文件在：

```text
dist\OpenClawTraining.zip
dist\OpenClawTraining-Setup.exe
```

`-IncludeData` 会打包 `D:\OpenClawData\training-index`、`training-clean` 和 `training-vision`，不会打包原始 PDF、Qdrant、Ollama 或密钥。

大模型出题/生成资料建议通过服务端环境变量配置：

```text
TRAINING_LLM_PROVIDER=auto
TRAINING_LLM_BASE_URL=https://api.deepseek.com/v1
TRAINING_LLM_MODEL=deepseek-chat
TRAINING_LLM_API_KEY=你的 API Key
```

## 打包部署到服务器

生成服务器部署包：

```powershell
cd D:\OpenClaw\peixun
powershell -ExecutionPolicy Bypass -File .\scripts\package-server.ps1 -IncludeData
```

输出文件：

```text
dist\OpenClawTrainingServer.zip
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
