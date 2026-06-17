# 钜洲培训 Agent Training Plugin

这是可选的 OpenClaw 外部插件，用来把 `training-service` 的培训闭环能力暴露为 Agent tools。`training-service` 可以不安装插件独立运行；插件只负责让外部 OpenClaw Agent 调用现有培训 API。

## Tools

插件保留 8 个 tool 名：

- `training_list_knowledge_bases`
- `training_search_employees`
- `training_create_task_draft`
- `training_publish_task`
- `training_get_task_status`
- `training_answer_question`
- `training_generate_quiz`
- `training_grade_answer`

网页端已有营销软文、本地记忆、任务中心和 Trace 页面；这些能力本轮没有新增到 OpenClaw 插件 tool 中。

## 安装

本地安装：

```powershell
openclaw plugins install "D:\juzhou-agent\peixun\training-plugin"
openclaw gateway restart
```

也可以在 OpenClaw 配置里使用本地路径加载：

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

## 使用原则

- 外部 Agent 创建培训时，应先调用 `training_create_task_draft` 生成草稿。
- 只有老板明确确认后，才允许调用 `training_publish_task`。
- 删除、发布、回滚、恢复等高风险动作需要宿主 Agent 做二次确认。
- 插件不保存业务数据；任务、邀请、考试、报表和 RAG 逻辑都在 `training-service` 中。
- 若 `training-service` 不可访问，插件应返回明确错误，不生成假内容。
