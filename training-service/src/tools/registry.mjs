import { generateKnowledgeAnswer, generateMarketingArticle } from "../ai/index.mjs";
import { answerGeneralChat } from "../chat/general-chat.mjs";
import { summarizeTranslationPayload, translateText } from "../chat/translation.mjs";
import { createTaskDraft, deleteTrainingRecords, getTaskStatus, matchKnowledgeBase } from "../domain/index.mjs";
import { getRuntimeHealth, getVectorIndexStatus } from "../health.mjs";
import { trainingDefaultsFromMemory } from "../memory/index.mjs";
import { getKnowledgeBaseQuality } from "../quality.mjs";
import { mutateState } from "../store.mjs";

function compact(value, limit = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function createEnrichedTaskDraft(state, instruction, memoryContext = null) {
  const draft = createTaskDraft(state, instruction, {
    memoryDefaults: trainingDefaultsFromMemory(memoryContext),
  });
  const knowledgeBaseId = draft.knowledgeBase?.id;
  if (!knowledgeBaseId) return draft;
  const runtime = await getRuntimeHealth(state);
  const vectorIndex = await getVectorIndexStatus(state, knowledgeBaseId, runtime);
  draft.knowledgeBase.quality = getKnowledgeBaseQuality(state, knowledgeBaseId, vectorIndex);
  return draft;
}

function summarizeDraft(payload) {
  return {
    action: payload.action,
    draftId: payload.draft?.id || "",
    employeeCount: payload.draft?.employees?.length || 0,
    unmatchedCount: payload.draft?.unmatchedEmployees?.length || 0,
    knowledgeBaseId: payload.draft?.knowledgeBase?.id || "",
    warningCount: payload.draft?.warnings?.length || 0,
  };
}

function summarizeStatus(payload) {
  return {
    action: payload.action,
    taskCount: payload.tasks?.length || 0,
  };
}

function summarizeDelete(payload) {
  return {
    action: payload.action,
    deleted: payload.deleted || {},
    remainingTasks: payload.remainingTasks || 0,
  };
}

function summarizeArticle(payload) {
  return {
    action: payload.action,
    insufficient: payload.article?.insufficient === true,
    sourceCount: payload.article?.sourceRefs?.length || 0,
    webSourceCount: payload.article?.webSourceRefs?.length || payload.article?.webSources?.length || 0,
    webSearchMode: payload.article?.webSearchMode || "off",
    webSearchStatus: payload.article?.webSearchStatus || "",
    warningCount: payload.article?.warnings?.length || 0,
    retrievalMode: payload.article?.retrievalMode || "",
    model: payload.article?.model || "",
  };
}

function summarizeKnowledgeAnswer(payload) {
  return {
    action: payload.action,
    knowledgeBaseId: payload.knowledgeBase?.id || "",
    sourceCount: payload.sourceRefs?.length || payload.sources?.length || payload.usedSources?.length || 0,
    webSourceCount: payload.webSourceRefs?.length || payload.webSources?.length || 0,
    retrievalMode: payload.retrievalMode || "",
    webSearchMode: payload.webSearchMode || "off",
    webSearchStatus: payload.webSearchStatus || "",
    confidence: payload.confidence || "",
    insufficient: payload.insufficient === true || payload.answerQuality?.status === "insufficient",
    hasAnswer: Boolean(payload.answer),
    answerPreview: compact(payload.answer || payload.errorMessage, 160),
  };
}

function summarizeChat(payload) {
  return {
    action: payload.action,
    source: payload.source || "",
    route: payload.route || "",
    hasAnswer: Boolean(payload.answer),
    answerPreview: compact(payload.answer, 160),
    webSearchMode: payload.webSearchMode || "off",
    webSearchStatus: payload.webSearchStatus || "",
    webSourceCount: payload.webSourceRefs?.length || payload.webSources?.length || 0,
  };
}

function summarizeTranslation(payload) {
  return summarizeTranslationPayload(payload);
}

function resolveKnowledgeBaseForAnswer(state, message, decision = {}) {
  const ready = (state.knowledgeBases || []).filter((kb) => kb.status === "ready");
  const byDecision = ready.find((kb) => kb.id === decision?.knowledgeBaseId);
  if (byDecision) return byDecision;
  const matched = matchKnowledgeBase({ ...state, knowledgeBases: ready }, message);
  if (matched) return matched;
  return ready.length === 1 ? ready[0] : null;
}

function insufficientKnowledgeAnswer(message, { decision, knowledgeBase, error } = {}) {
  return {
    action: "knowledge_answer",
    decision,
    answer: message,
    keyPoints: [],
    caveats: [message].filter(Boolean),
    sources: [],
    usedSources: [],
    sourceRefs: [],
    confidence: "low",
    generatedBy: "none",
    source: "knowledge-base",
    route: "knowledge_answer",
    knowledgeBase: knowledgeBase ? { id: knowledgeBase.id, name: knowledgeBase.name } : null,
    retrievalMode: "none",
    webSearchMode: "off",
    webSearchStatus: "disabled",
    webSources: [],
    webSourceRefs: [],
    insufficient: true,
    errorMessage: error || "",
    answerQuality: {
      status: "insufficient",
      generatedBy: "none",
      retrievalMode: "none",
      sourceCount: 0,
      answerChars: String(message || "").length,
      warnings: error ? [error] : [],
    },
  };
}

const webSkills = [
  {
    id: "create_training_draft",
    kind: "web-skill",
    label: "创建培训草稿",
    description: "把老板自然语言培训安排解析为可确认的培训草稿，不直接发布。",
    risk: "normal",
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 15000,
    inputSummary: ({ message }) => ({ instructionPreview: compact(message) }),
    summarizeResult: summarizeDraft,
    async execute({ state, message, decision, memoryContext }) {
      return {
        action: "draft",
        decision,
        draft: await createEnrichedTaskDraft(state, message, memoryContext),
      };
    },
  },
  {
    id: "show_training_status",
    kind: "web-skill",
    label: "查询培训进度",
    description: "查询已发布培训任务的完成率、成绩、未完成人员和薄弱来源。",
    risk: "low",
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 10000,
    inputSummary: ({ state }) => ({ taskCount: state.tasks?.length || 0 }),
    summarizeResult: summarizeStatus,
    async execute({ state, decision }) {
      return {
        action: "status",
        decision,
        tasks: state.tasks.map((task) => getTaskStatus(state, task.id)),
      };
    },
  },
  {
    id: "delete_training_records",
    kind: "web-skill",
    label: "删除培训记录",
    description: "删除匹配的培训任务、邀请、试卷和答题记录，不删除知识库或员工名单。",
    risk: "high",
    requiresConfirmation: true,
    idempotent: false,
    timeoutMs: 10000,
    inputSummary: ({ message }) => ({ instructionPreview: compact(message) }),
    summarizeResult: summarizeDelete,
    async execute({ message, decision }) {
      const result = await mutateState((currentState) => deleteTrainingRecords(currentState, { instruction: message }));
      return {
        ...result,
        decision,
      };
    },
  },
  {
    id: "generate_marketing_article",
    kind: "web-skill",
    label: "生成营销软文",
    description: "基于本地知识库和 RAG 上下文生成 B2B 客户营销文章，不联网搜索。",
    risk: "normal",
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 60000,
    inputSummary: ({ message, webSearchMode }) => ({ instructionPreview: compact(message), webSearchMode: webSearchMode || "off" }),
    summarizeResult: summarizeArticle,
    async execute({ state, message, decision, memoryContext, webSearchMode }) {
      return {
        action: "marketing_article",
        decision,
        article: await generateMarketingArticle(state, { instruction: message, memoryContext, webSearchMode }),
      };
    },
  },
  {
    id: "answer_knowledge_question",
    kind: "web-skill",
    label: "知识库答疑",
    description: "自动匹配本地知识库，基于 RAG chunk 和来源回答老板端资料问题。",
    risk: "low",
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 60000,
    inputSummary: ({ message, decision, webSearchMode }) => ({
      questionPreview: compact(message),
      knowledgeBaseId: decision?.knowledgeBaseId || "",
      webSearchMode: webSearchMode || "off",
    }),
    summarizeResult: summarizeKnowledgeAnswer,
    async execute({ state, message, decision, webSearchMode }) {
      const knowledgeBase = resolveKnowledgeBaseForAnswer(state, message, decision);
      if (!knowledgeBase) {
        return insufficientKnowledgeAnswer("当前没有匹配到可用于答疑的知识库，请先导入或明确资料库名称。", { decision });
      }
      try {
        const answer = await generateKnowledgeAnswer(state, {
          knowledgeBaseId: knowledgeBase.id,
          question: message,
          webSearchMode,
        });
        const sources = answer.usedSources?.length ? answer.usedSources : answer.sources || [];
        return {
          action: "knowledge_answer",
          decision,
          ...answer,
          sources,
          usedSources: sources,
          source: "knowledge-base",
          route: "knowledge_answer",
          knowledgeBase: {
            id: knowledgeBase.id,
            name: knowledgeBase.name,
          },
        };
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        return insufficientKnowledgeAnswer(messageText || "当前知识库没有检索到足够相关的资料，已停止回答。", {
          decision,
          knowledgeBase,
          error: messageText,
        });
      }
    },
  },
  {
    id: "translate_text",
    kind: "web-skill",
    label: "多语言翻译",
    description: "把文本翻译成用户指定的任意目标语言，不执行系统写操作。",
    risk: "low",
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 60000,
    inputSummary: ({ message, webSearchMode }) => ({ messagePreview: compact(message), webSearchMode: webSearchMode || "off" }),
    summarizeResult: summarizeTranslation,
    async execute({ message, sessionId, webSearchMode }) {
      try {
        return await translateText(message, { sessionId, webSearchMode });
      } catch (error) {
        return {
          action: "translation",
          error: error instanceof Error ? error.message : String(error),
          source: "llm-api",
          route: "translation",
          llmConfigured: false,
          webSearchMode: webSearchMode || "off",
          webSearchStatus: "disabled",
          webSources: [],
          webSourceRefs: [],
        };
      }
    },
  },
  {
    id: "answer_general_chat",
    kind: "web-skill",
    label: "普通聊天",
    description: "普通大模型对话，不执行系统写操作。",
    risk: "low",
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 60000,
    inputSummary: ({ message, webSearchMode }) => ({ messagePreview: compact(message), webSearchMode: webSearchMode || "off" }),
    summarizeResult: summarizeChat,
    async execute({ message, decision, memoryContext, webSearchMode }) {
      try {
        return {
          action: "chat",
          decision,
          ...(await answerGeneralChat(message, { memoryContext, webSearchMode })),
        };
      } catch (error) {
        return {
          action: "chat",
          decision,
          error: error instanceof Error ? error.message : String(error),
          source: "llm-api",
          route: "general_chat",
          llmConfigured: false,
          webSearchMode: webSearchMode || "off",
          webSearchStatus: "disabled",
          webSources: [],
          webSourceRefs: [],
        };
      }
    },
  },
];

const openClawTools = [
  ["training_list_knowledge_bases", "List Training Knowledge Bases", "列出可用培训知识库。", "low", true, "GET /api/knowledge-bases"],
  ["training_search_employees", "Search Training Employees", "按姓名、别名、部门或角色搜索员工。", "low", true, "GET /api/employees"],
  ["training_create_task_draft", "Create Training Task Draft", "创建培训草稿，不发布。", "normal", true, "POST /api/agent/draft"],
  ["training_publish_task", "Publish Training Task", "发布已确认培训草稿并生成邀请链接。", "high", false, "POST /api/tasks/publish"],
  ["training_get_task_status", "Get Training Task Status", "查询培训任务状态和报表。", "low", true, "GET /api/tasks/:taskId"],
  ["training_answer_question", "Answer Training Question", "基于任务知识库回答员工问题。", "low", true, "POST /api/answer"],
  ["training_generate_quiz", "Generate Training Quiz", "为培训任务生成或读取试卷。", "normal", true, "POST /api/quiz/generate"],
  ["training_grade_answer", "Grade Training Answers", "提交并批改员工试卷答案。", "normal", false, "POST /api/quiz/submit"],
].map(([id, label, description, risk, idempotent, endpoint]) => ({
  id,
  kind: "openclaw-tool",
  label,
  description,
  risk,
  requiresConfirmation: risk === "high",
  idempotent,
  timeoutMs: 60000,
  endpoint,
}));

const registry = new Map([...webSkills, ...openClawTools].map((tool) => [tool.id, tool]));

export function getTool(id) {
  return registry.get(String(id || "")) || null;
}

export function getWebSkill(id) {
  const tool = getTool(id);
  return tool?.kind === "web-skill" ? tool : null;
}

export function listTools() {
  return [...registry.values()].map((tool) => ({
    id: tool.id,
    kind: tool.kind,
    label: tool.label,
    description: tool.description,
    risk: tool.risk,
    requiresConfirmation: tool.requiresConfirmation === true,
    idempotent: tool.idempotent === true,
    timeoutMs: tool.timeoutMs,
    endpoint: tool.endpoint || undefined,
  }));
}

export async function executeWebSkill(skillId, context) {
  const tool = getWebSkill(skillId);
  if (!tool) {
    const error = new Error(`Unknown Agent skill: ${skillId}`);
    error.statusCode = 400;
    throw error;
  }
  return await tool.execute(context);
}

export function summarizeToolInput(skillId, context) {
  const tool = getTool(skillId);
  if (!tool?.inputSummary) return {};
  return tool.inputSummary(context);
}

export function summarizeToolResult(skillId, payload) {
  const tool = getTool(skillId);
  if (!tool?.summarizeResult) return { action: payload?.action || "" };
  return tool.summarizeResult(payload);
}
