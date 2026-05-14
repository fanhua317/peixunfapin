# OpenClaw Training Service MVP

这是培训系统的外部 Web/API 服务。它保存员工、知识库、培训任务、邀请链接、考试和报表数据，OpenClaw 通过外部插件调用它。

## 运行

```powershell
npm start
```

默认地址：`http://127.0.0.1:8787`

## 页面

- 老板后台：`http://127.0.0.1:8787/`
- 员工邀请链接：发布任务后生成 `/t/{inviteToken}`

## 数据目录

培训系统代码在：

```text
D:\OpenClaw\peixun\training-service
```

业务数据放在代码目录外：

```text
D:\OpenClawData\training-raw    # 原始 PDF、Excel、CSV、TXT、Markdown
D:\OpenClawData\training-clean  # 清洗后的 Markdown/TXT
D:\OpenClawData\training-index  # 服务索引 state.json
D:\OpenClawData\qdrant          # 本机 Qdrant Docker 持久化目录
```

默认索引文件：

```text
D:\OpenClawData\training-index\state.json
```

也可以用环境变量覆盖：

```powershell
$env:TRAINING_DATA_DIR="D:\OpenClawData\training-index"
npm start
```

## 导入 PDF 和表格资料

1. 把原始文件放到：

```text
D:\OpenClawData\training-raw
```

2. 清洗 PDF / Excel / CSV：

```powershell
npm run clean:raw
```

3. 导入清洗后的知识库：

```powershell
npm run import:clean -- "D:\OpenClawData\training-clean" "电机培训资料库" "电机,电动机,三相异步电动机,异步电机,银嘉电机,YINJIA,YINJIA motor,电机应用,电机结构,电机选型,能效等级"
```

导入后，老板自然语言里提到 `电机`、`电动机`、`三相异步电动机` 等关键词时，系统会尝试匹配到该知识库。

## 向量检索 / Qdrant

当前服务支持 `关键词检索 + Qdrant 语义检索` 的混合 RAG。

本机准备：

```powershell
$env:QDRANT_URL="http://127.0.0.1:6333"
$env:QDRANT_COLLECTION="training_chunks_bge_m3"
$env:OLLAMA_URL="http://127.0.0.1:11434"
$env:TRAINING_EMBEDDING_MODEL="bge-m3"
```

本机完成资料清洗和导入后，生成 embedding 并写入 Qdrant：

```powershell
npm run embed:chunks
```

只重建某个知识库：

```powershell
npm run embed:chunks -- --kb=kb-电机培训资料库
```

只查看待构建数量：

```powershell
npm run embed:chunks -- --dry
```

创建本机 Qdrant collection snapshot：

```powershell
npm run qdrant:snapshot -- create
```

查看已有 snapshot：

```powershell
npm run qdrant:snapshot -- list
```

服务运行时默认启用混合检索；如需临时关闭向量检索并回退关键词检索：

```powershell
$env:TRAINING_HYBRID_RETRIEVAL="off"
```

## 服务器部署要点

推荐模式是本机生成 embedding 和 Qdrant 数据，服务器只跑在线服务：

1. 本机运行 `npm run clean:raw`、`npm run import:clean`、`npm run embed:chunks`。
2. 在本机 Qdrant 为 collection 创建 snapshot：`npm run qdrant:snapshot -- create`。
3. 传输 `state.json`、清洗资料和 Qdrant snapshot 到服务器。
4. 服务器用 Docker 运行 Qdrant 并恢复 snapshot。
5. 服务器启动 `node src/server.mjs` 或使用 `pm2/systemd` 管理。

服务器环境变量至少包含：

```powershell
$env:TRAINING_DATA_DIR="D:\OpenClawData\training-index"
$env:QDRANT_URL="http://127.0.0.1:6333"
$env:QDRANT_COLLECTION="training_chunks_bge_m3"
$env:TRAINING_HYBRID_RETRIEVAL="on"
```

LLM 调用默认仍走 OpenClaw：

```powershell
$env:TRAINING_LLM_PROVIDER="openclaw"
```

## 图片型 PDF 处理

如果 PDF 不能直接抽取文字，可以先渲染为图片页：

```powershell
npm run render:pdf -- "D:\OpenClawData\training-raw\电机\电机1.pdf" "D:\OpenClawData\training-vision" 3 1.4
```

渲染图片会输出到：

```text
D:\OpenClawData\training-vision
```

随后将视觉识别出的内容整理为 Markdown，放回：

```text
D:\OpenClawData\training-clean
```

再运行 `scripts/import-clean.mjs` 重新导入知识库。

## API 概览

- `GET /api/health`
- `GET /api/knowledge-bases`
- `GET /api/employees?q=销售部`
- `POST /api/chat`
- `POST /api/agent/draft`
- `POST /api/tasks/publish`
- `GET /api/tasks`
- `GET /api/tasks/{taskId}`
- `GET /api/invites/{token}`
- `POST /api/answer`
- `POST /api/quiz/generate`
- `POST /api/quiz/submit`

## 当前限制

- 服务器模式不建议运行 embedding 模型；embedding 推荐在本机离线构建后迁移 Qdrant snapshot。
- Qdrant collection 的向量维度固定；更换 embedding 模型后需要重建 collection。
- 图片型或扫描型 PDF 需要 OCR 后才能得到完整文本；当前清洗脚本只能直接抽取可复制文本。
- 当前邀请链接没有手机号/企业身份校验，正式版需要补权限验证。
