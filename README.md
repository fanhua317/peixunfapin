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
