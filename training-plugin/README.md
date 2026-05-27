# 钜洲培训 Agent Training Plugin

这是 OpenClaw 外部插件，把 `training-service` 的培训闭环能力暴露为 Agent tools。`training-service` 可以不安装插件独立运行；插件只负责让外部 OpenClaw Agent 调用现有培训 API。

## 工具

- `training_list_knowledge_bases`
- `training_search_employees`
- `training_create_task_draft`
- `training_publish_task`
- `training_get_task_status`
- `training_answer_question`
- `training_generate_quiz`
- `training_grade_answer`

当前插件只保留以上 8 个 training tool。网页端已经有营销软文和本地记忆功能，但本轮没有给 OpenClaw 插件新增软文或记忆 tool。

## 安装方式

在 OpenClaw 中安装本地插件：

```powershell
openclaw plugins install "D:\juzhou-agent\peixun\training-plugin"
openclaw gateway restart
```

也可以在 OpenClaw 配置里使用本地加载路径：

```json5
{
  plugins: {
    load: {
      paths: ["D:/juzhou-agent/peixun/training-plugin"],
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

高风险动作要由宿主 Agent 做二次确认。插件本身不保存业务数据，所有任务、邀请、考试、报表和 RAG 逻辑都在 `training-service` 中。
