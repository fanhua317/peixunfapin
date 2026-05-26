import { classifyTrainingIntent } from "../src/ai/index.mjs";

process.env.TRAINING_LLM_INTENT_ROUTER = "0";

const state = {
  knowledgeBases: [
    {
      id: "kb-motor",
      name: "电机基础资料库",
      aliases: ["电机", "电机基础培训"],
      status: "ready",
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
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  failed: failed.length,
  results,
}, null, 2));

if (failed.length) {
  process.exitCode = 1;
}
