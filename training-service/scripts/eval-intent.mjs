import { classifyTrainingIntent } from "../src/ai/index.mjs";
import { registerLlmProvider } from "../src/llm.mjs";

process.env.TRAINING_LLM_PROVIDER = "eval-intent-router";
process.env.TRAINING_LLM_INTENT_ROUTER = "1";

function routerDecisionForPrompt(prompt) {
  const userInputMatch = String(prompt || "").match(/用户输入：(".*")/s);
  let message = "";
  try {
    message = userInputMatch ? JSON.parse(userInputMatch[1]) : "";
  } catch {
    message = "";
  }
  if (/生成三篇水泵的宣传文章|生成三篇英文文章，同时附带中文翻译/.test(message)) {
    return { intent: "generate_marketing_article", skill: "generate_marketing_article", confidence: 0.94, reason: "用户要生成文章，翻译只是文章附加要求。" };
  }
  if (/请帮我检索 CM2 的相关知识|有具体型号吗/.test(message)) {
    return { intent: "answer_knowledge_question", skill: "answer_knowledge_question", confidence: 0.91, reason: "用户询问水泵知识库资料和型号。" };
  }
  if (/这是水泵，不是电机/.test(message)) {
    return { intent: "answer_knowledge_question", skill: "answer_knowledge_question", confidence: 0.86, reason: "用户纠正主题为水泵，应优先水泵资料。" };
  }
  return { intent: "answer_general_chat", skill: "answer_general_chat", confidence: 0.6, reason: "eval mock fallback" };
}

const evalIntentRouter = async (prompt) => ({
  answer: JSON.stringify(routerDecisionForPrompt(prompt)),
  source: "eval-intent-router",
  provider: "eval",
  model: "eval-router-mock",
});

registerLlmProvider("eval-intent-router", evalIntentRouter);
registerLlmProvider("auto", evalIntentRouter);

const state = {
  knowledgeBases: [
    {
      id: "kb-motor",
      name: "电机基础资料库",
      aliases: ["电机", "电动机", "电机基础培训", "WONDER"],
      status: "ready",
    },
    {
      id: "kb-yinjia-pump",
      name: "银嘉泵水泵资料库",
      aliases: ["银嘉泵", "银嘉水泵", "水泵", "泵", "CM2", "YINJIA"],
      status: "ready",
    },
  ],
  documents: [],
  chunkParents: [
    {
      id: "parent-motor-basics",
      knowledgeBaseId: "kb-motor",
      documentId: "doc-motor",
      sourceRef: "电机基础.md :: 什么是电机",
      content: "电机是一种把电能转换为机械能的装置，常见三相异步电动机由定子、转子、绕组、轴承和机座等部分组成。",
    },
    {
      id: "parent-low-pressure-casting",
      knowledgeBaseId: "kb-motor",
      documentId: "doc-motor",
      sourceRef: "电机工艺.md :: 低压铸铝",
      content: "低压铸铝相比压力铸铝排气更好，转子填充率和电气性能更稳定；相比离心铸铝，工艺一致性更容易控制。",
    },
    {
      id: "parent-wonder-series",
      knowledgeBaseId: "kb-motor",
      documentId: "doc-motor",
      sourceRef: "WONDER 高效电机.md :: 系列",
      content: "WONDER 高效电机资料提到 WE/WEA、ZW/ZWEA、SWE/SWEA、SNA/NEMA 等系列。",
    },
    {
      id: "parent-pump-cm2",
      knowledgeBaseId: "kb-yinjia-pump",
      documentId: "doc-yinjia-pump",
      sourceRef: "银嘉泵目录.md :: CM2",
      content: "银嘉泵水泵资料中，CM2 属于离心泵相关型号，可用于清水输送、增压和一般工业配套场景。",
    },
    {
      id: "parent-pump-models",
      knowledgeBaseId: "kb-yinjia-pump",
      documentId: "doc-yinjia-pump",
      sourceRef: "银嘉泵目录.md :: 型号",
      content: "银嘉泵资料包含 CM2、VM22、QB60、WZB750 等具体水泵型号，型号参数应以资料表为准。",
    },
  ],
  chunks: [
    {
      id: "chunk-motor-basics",
      parentId: "parent-motor-basics",
      knowledgeBaseId: "kb-motor",
      documentId: "doc-motor",
      sourceRef: "电机基础.md :: 什么是电机",
      content: "电机是一种把电能转换为机械能的装置，三相异步电动机包含定子、转子、绕组、轴承和机座。",
      searchText: "电机 是什么 三相异步电动机 定子 转子 绕组",
    },
    {
      id: "chunk-low-pressure-casting",
      parentId: "parent-low-pressure-casting",
      knowledgeBaseId: "kb-motor",
      documentId: "doc-motor",
      sourceRef: "电机工艺.md :: 低压铸铝",
      content: "低压铸铝排气更好，转子填充率和电气性能更稳定，是压力铸铝和离心铸铝对比中的优势工艺。",
      searchText: "低压铸铝 优势 压力铸铝 离心铸铝 电气性能",
    },
    {
      id: "chunk-wonder-series",
      parentId: "parent-wonder-series",
      knowledgeBaseId: "kb-motor",
      documentId: "doc-motor",
      sourceRef: "WONDER 高效电机.md :: 系列",
      content: "WONDER 高效电机系列包括 WE/WEA、ZW/ZWEA、SWE/SWEA、SNA/NEMA。",
      searchText: "WONDER 电机 系列 WE WEA ZW ZWEA SWE SNA NEMA",
    },
    {
      id: "chunk-pump-cm2",
      parentId: "parent-pump-cm2",
      knowledgeBaseId: "kb-yinjia-pump",
      documentId: "doc-yinjia-pump",
      sourceRef: "银嘉泵目录.md :: CM2",
      content: "CM2 是银嘉泵水泵资料中的型号，可用于清水输送、增压和一般工业配套。",
      searchText: "银嘉泵 水泵 泵 CM2 相关知识 清水输送 增压 工业配套",
    },
    {
      id: "chunk-pump-models",
      parentId: "parent-pump-models",
      knowledgeBaseId: "kb-yinjia-pump",
      documentId: "doc-yinjia-pump",
      sourceRef: "银嘉泵目录.md :: 型号",
      content: "银嘉泵水泵具体型号包括 CM2、VM22、QB60、WZB750，追问型号时应沿用水泵资料库。",
      searchText: "水泵 具体型号 型号 CM2 VM22 QB60 WZB750 银嘉泵",
    },
  ],
  employees: [
    {
      id: "emp-wang-xiaoming",
      name: "王小明",
      aliases: ["小明"],
      department: "销售部",
      role: "销售新人",
      status: "active",
    },
    {
      id: "emp-li-xiaohong",
      name: "李小红",
      aliases: ["小红"],
      department: "销售部",
      role: "销售新人",
      status: "active",
    },
  ],
};

const cases = [
  {
    name: "training draft",
    message: "给王小明发布电机培训",
    skill: "create_training_draft",
    needsConfirmation: false,
  },
  {
    name: "new draft after reinput",
    message: "重新输入：给李小红发布电机基础培训，明天下午 6 点前完成",
    skill: "create_training_draft",
    needsConfirmation: false,
  },
  {
    name: "short publish confirmation is not backend skill",
    message: "确认发布",
    skill: "answer_general_chat",
    needsConfirmation: false,
  },
  {
    name: "delete requires confirmation",
    message: "把之前培训记录删掉",
    skill: "delete_training_records",
    needsConfirmation: true,
  },
  {
    name: "confirmed delete executes",
    message: "把之前培训记录删掉",
    confirmedSkill: "delete_training_records",
    skill: "delete_training_records",
    needsConfirmation: false,
    source: "confirmed",
  },
  {
    name: "marketing article",
    message: "写一篇电机选型公众号文章，短一点",
    skill: "generate_marketing_article",
    needsConfirmation: false,
  },
  {
    name: "three English pump marketing articles",
    message: "请帮我生成三篇水泵的宣传文章，500词左右，英文",
    skill: "generate_marketing_article",
    needsConfirmation: false,
  },
  {
    name: "English articles with Chinese translation stay marketing",
    message: "请帮我生成三篇英文文章，同时附带中文翻译",
    skill: "generate_marketing_article",
    needsConfirmation: false,
  },
  {
    name: "translation zh to en",
    message: "翻译成英文：这是一个电机培训系统",
    skill: "translate_text",
    needsConfirmation: false,
  },
  {
    name: "translation pump zh to en",
    message: "翻译成英文：这是一台水泵",
    skill: "translate_text",
    needsConfirmation: false,
  },
  {
    name: "translation en command",
    message: "translate to Spanish: high efficiency motor",
    skill: "translate_text",
    needsConfirmation: false,
  },
  {
    name: "general identity chat",
    message: "你是谁，帮我解释一下这个系统",
    skill: "answer_general_chat",
    needsConfirmation: false,
  },
  {
    name: "training status",
    message: "查一下培训完成情况",
    skill: "show_training_status",
    needsConfirmation: false,
  },
  {
    name: "status with scores",
    message: "看看这次考试成绩和谁没完成",
    skill: "show_training_status",
    needsConfirmation: false,
  },
  {
    name: "question about system is chat",
    message: "帮我介绍一下这个系统怎么工作",
    skill: "answer_general_chat",
    needsConfirmation: false,
  },
  {
    name: "generic generate is chat",
    message: "帮我生成一个想法",
    skill: "answer_general_chat",
    needsConfirmation: false,
  },
  {
    name: "generic search is chat",
    message: "查一下火锅怎么做",
    skill: "answer_general_chat",
    needsConfirmation: false,
  },
  {
    name: "explain motor uses knowledge",
    message: "给王小明讲一下电机是什么",
    skill: "answer_knowledge_question",
    needsConfirmation: false,
  },
  {
    name: "low pressure casting uses knowledge",
    message: "低压铸铝有什么优势",
    skill: "answer_knowledge_question",
    needsConfirmation: false,
  },
  {
    name: "wonder series uses knowledge",
    message: "WONDER 电机有哪些系列",
    skill: "answer_knowledge_question",
    needsConfirmation: false,
  },
  {
    name: "cm2 pump knowledge uses yinjia pump kb",
    message: "请帮我检索 CM2 的相关知识",
    skill: "answer_knowledge_question",
    needsConfirmation: false,
    knowledgeBaseId: "kb-yinjia-pump",
  },
  {
    name: "pump follow-up model question keeps yinjia pump kb",
    message: "有具体型号吗",
    skill: "answer_knowledge_question",
    needsConfirmation: false,
    knowledgeBaseId: "kb-yinjia-pump",
    memoryHint: "上一轮用户正在询问银嘉泵水泵资料库中 CM2 的相关知识。",
  },
  {
    name: "pump correction must not select motor kb",
    message: "这是水泵，不是电机",
    skill: "answer_knowledge_question",
    needsConfirmation: false,
    knowledgeBaseId: "kb-yinjia-pump",
    notKnowledgeBaseId: "kb-motor",
  },
  {
    name: "training design discussion is chat",
    message: "帮我看看培训应该怎么设计比较合理",
    skill: "answer_general_chat",
    needsConfirmation: false,
  },
  {
    name: "delete knowledge base is not training records",
    message: "删除知识库",
    skill: "answer_general_chat",
    needsConfirmation: false,
  },
  {
    name: "delete quiz wording is not record deletion",
    message: "把这句话里的考试题三个字删掉",
    skill: "answer_general_chat",
    needsConfirmation: false,
  },
  {
    name: "explicit all training delete requires confirmation",
    message: "清空全部培训任务记录",
    skill: "delete_training_records",
    needsConfirmation: true,
  },
  {
    name: "quiz assignment draft",
    message: "给王小明出 10 道电机选择题，80 分及格",
    skill: "create_training_draft",
    needsConfirmation: false,
  },
  {
    name: "study assignment draft",
    message: "安排王小明下周学习电机资料",
    skill: "create_training_draft",
    needsConfirmation: false,
  },
  {
    name: "marketing article for unmatched topic still article skill",
    message: "写一篇关于火锅的软文",
    skill: "generate_marketing_article",
    needsConfirmation: false,
  },
  {
    name: "web search marketing request is article skill",
    message: "联网查一下电机资料再写软文",
    skill: "generate_marketing_article",
    needsConfirmation: false,
  },
];

const results = [];
for (const item of cases) {
  const decision = await classifyTrainingIntent(state, item.message, {
    confirmedSkill: item.confirmedSkill || "",
    memoryHint: item.memoryHint || "",
  });
  const ok = decision.skill === item.skill
    && decision.needsConfirmation === item.needsConfirmation
    && (!item.source || decision.source === item.source)
    && (!item.knowledgeBaseId || decision.knowledgeBaseId === item.knowledgeBaseId)
    && (!item.notKnowledgeBaseId || decision.knowledgeBaseId !== item.notKnowledgeBaseId);
  results.push({
    name: item.name,
    ok,
    message: item.message,
    expected: {
      skill: item.skill,
      needsConfirmation: item.needsConfirmation,
      source: item.source || undefined,
    },
    actual: {
      skill: decision.skill,
      confidence: decision.confidence,
      source: decision.source,
      needsConfirmation: decision.needsConfirmation,
      reason: decision.reason,
      knowledgeBaseId: decision.knowledgeBaseId,
      knowledgeBaseName: decision.knowledgeBaseName,
    },
  });
}

const failed = results.filter((result) => !result.ok);
const bySkill = results.reduce((acc, result) => {
  const skill = result.actual.skill || "unknown";
  acc[skill] = (acc[skill] || 0) + 1;
  return acc;
}, {});
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  failed: failed.length,
  bySkill,
  results,
}, null, 2));

if (failed.length) {
  process.exitCode = 1;
}
