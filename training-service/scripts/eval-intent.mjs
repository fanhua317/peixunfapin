import { classifyTrainingIntent } from "../src/ai/index.mjs";

process.env.TRAINING_LLM_INTENT_ROUTER = "0";

const state = {
  knowledgeBases: [
    {
      id: "kb-motor",
      name: "电机基础资料库",
      aliases: ["电机", "电动机", "电机基础培训", "WONDER"],
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
    name: "translation zh to en",
    message: "翻译成英文：这是一个电机培训系统",
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
  });
  const ok = decision.skill === item.skill
    && decision.needsConfirmation === item.needsConfirmation
    && (!item.source || decision.source === item.source);
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
