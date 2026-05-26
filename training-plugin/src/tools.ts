import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { callTrainingService, jsonResult } from "./client";
import { EmptyParams, objectSchema, parameters } from "./schemas";

function createTool(tool: AnyAgentTool): AnyAgentTool {
  return tool;
}

export function createTrainingTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    createTool({
      name: "training_list_knowledge_bases",
      label: "List Training Knowledge Bases",
      description: "List available training knowledge bases prepared by the technical administrator.",
      parameters: parameters(EmptyParams),
      async execute() {
        return jsonResult(await callTrainingService(api, "/api/knowledge-bases"));
      },
    }),

    createTool({
      name: "training_search_employees",
      label: "Search Training Employees",
      description: "Search employees by name, alias, department, or role before creating a training task.",
      parameters: objectSchema({
        query: { type: "string", description: "Employee name, alias, department, or role to search." },
      }, ["query"]),
      async execute(_toolCallId, params) {
        const query = typeof (params as { query?: unknown }).query === "string" ? (params as { query: string }).query : "";
        return jsonResult(await callTrainingService(api, `/api/employees?q=${encodeURIComponent(query)}`));
      },
    }),

    createTool({
      name: "training_create_task_draft",
      label: "Create Training Task Draft",
      description: "Parse a boss natural-language training instruction into a structured draft. This does not publish anything.",
      parameters: objectSchema({
        instruction: { type: "string", description: "Boss natural-language instruction." },
      }, ["instruction"]),
      async execute(_toolCallId, params) {
        return jsonResult(await callTrainingService(api, "/api/agent/draft", {
          method: "POST",
          body: JSON.stringify({ instruction: (params as { instruction?: string }).instruction || "" }),
        }));
      },
    }),

    createTool({
      name: "training_publish_task",
      label: "Publish Training Task",
      description: "Publish a confirmed training task draft and generate employee invite links. Only call this after explicit boss confirmation.",
      parameters: objectSchema({
        draft: { description: "Draft returned by training_create_task_draft." },
      }, ["draft"]),
      async execute(_toolCallId, params) {
        return jsonResult(await callTrainingService(api, "/api/tasks/publish", {
          method: "POST",
          body: JSON.stringify({ draft: (params as { draft?: unknown }).draft }),
        }));
      },
    }),

    createTool({
      name: "training_get_task_status",
      label: "Get Training Task Status",
      description: "Get completion, invite, score, and weak-point status for a training task.",
      parameters: objectSchema({
        task_id: { type: "string", description: "Training task id." },
      }, ["task_id"]),
      async execute(_toolCallId, params) {
        return jsonResult(await callTrainingService(api, `/api/tasks/${encodeURIComponent((params as { task_id?: string }).task_id || "")}`));
      },
    }),

    createTool({
      name: "training_answer_question",
      label: "Answer Training Question",
      description: "Answer an employee question against the knowledge base bound to a task or invite token.",
      parameters: objectSchema({
        question: { type: "string", description: "Employee question." },
        token: { type: "string", description: "Invite token from the employee link." },
        task_id: { type: "string", description: "Training task id." },
      }, ["question"]),
      async execute(_toolCallId, params) {
        return jsonResult(await callTrainingService(api, "/api/answer", {
          method: "POST",
          body: JSON.stringify({
            question: (params as { question?: string }).question || "",
            token: (params as { token?: string }).token,
            taskId: (params as { task_id?: string }).task_id,
          }),
        }));
      },
    }),

    createTool({
      name: "training_generate_quiz",
      label: "Generate Training Quiz",
      description: "Generate or retrieve quiz questions for a published training task.",
      parameters: objectSchema({
        task_id: { type: "string", description: "Training task id." },
      }, ["task_id"]),
      async execute(_toolCallId, params) {
        return jsonResult(await callTrainingService(api, "/api/quiz/generate", {
          method: "POST",
          body: JSON.stringify({ taskId: (params as { task_id?: string }).task_id || "" }),
        }));
      },
    }),

    createTool({
      name: "training_grade_answer",
      label: "Grade Training Answers",
      description: "Submit and grade quiz answers for an invite token.",
      parameters: objectSchema({
        token: { type: "string", description: "Invite token from the employee link." },
        answers: { description: "Object keyed by question id with selected answer values." },
      }, ["token", "answers"]),
      async execute(_toolCallId, params) {
        return jsonResult(await callTrainingService(api, "/api/quiz/submit", {
          method: "POST",
          body: JSON.stringify({
            token: (params as { token?: string }).token || "",
            answers: (params as { answers?: unknown }).answers || {},
          }),
        }));
      },
    }),
  ];
}
