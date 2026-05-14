# OpenClaw Training RAG Plugin

这是 OpenClaw 外部插件，把 `training-service` 的培训能力暴露为 Agent tools。

## 工具

- `training_list_knowledge_bases`
- `training_search_employees`
- `training_create_task_draft`
- `training_publish_task`
- `training_get_task_status`
- `training_answer_question`
- `training_generate_quiz`
- `training_grade_answer`

## 安装方式

在 OpenClaw 中安装本地插件：

```powershell
openclaw plugins install "D:\OpenClaw\peixun\training-plugin"
openclaw gateway restart
```

也可以在 OpenClaw 配置里使用本地加载路径：

```json5
{
  plugins: {
    load: {
      paths: ["D:/OpenClaw/peixun/training-plugin"],
    },
    entries: {
      "training-rag": {
        enabled: true,
        config: {
          serviceUrl: "http://127.0.0.1:8787",
          timeoutMs: 20000,
        },
      },
    },
  },
  tools: {
    allow: [
      "training_list_knowledge_bases",
      "training_search_employees",
      "training_create_task_draft",
      "training_publish_task",
      "training_get_task_status",
      "training_answer_question",
      "training_generate_quiz",
      "training_grade_answer",
    ],
  },
}
```

## Agent 使用原则

插件附带 `training-agent` skill。老板用自然语言创建任务时，Agent 应先生成草稿并展示确认；只有老板明确确认后，才调用 `training_publish_task`。
