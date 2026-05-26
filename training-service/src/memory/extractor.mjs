import { memoryStatusForText, shouldBlockMemoryWrite } from "./policy.mjs";

function evidence(text) {
  return [{ text: String(text || "").trim(), createdAt: new Date().toISOString() }];
}

function candidate(text, fields) {
  return {
    scope: "boss",
    source: "rule",
    confidence: fields.status === "pending" ? 0.62 : 0.9,
    evidence: evidence(text),
    ...fields,
  };
}

function parseQuizCount(text) {
  const value = String(text || "");
  const match = value.match(/(?:默认|以后|下次|培训).*?(\d{1,2})\s*道/) || value.match(/(\d{1,2})\s*道.*?(?:默认|以后|下次|培训)/);
  return match ? Number(match[1]) : null;
}

function parsePassScore(text) {
  const value = String(text || "");
  const match = value.match(/(\d{2,3})\s*分(?:及格|通过|合格)?/) || value.match(/(?:及格|通过|合格).*?(\d{2,3})\s*分/);
  return match ? Number(match[1]) : null;
}

function marketingCandidates(text, status) {
  const value = String(text || "");
  if (!/(软文|营销文章|推广文案|公众号文章|宣传文案|官网文章|朋友圈|B2B|b2b|阿里国际站)/.test(value)) return [];
  const items = [];
  if (/(短一点|简短|朋友圈|300字|五百字|500字)/.test(value)) {
    items.push(candidate(value, {
      type: "preference",
      key: "marketing.length",
      status,
      text: "营销软文默认写短一点，正文约 300-600 字。",
      value: { lengthInstruction: "300-600字", label: "短一点" },
      tags: ["marketing", "length"],
    }));
  } else if (/(长一点|长文|详细|深度|完整|1500|一千五|2000|两千)/.test(value)) {
    items.push(candidate(value, {
      type: "preference",
      key: "marketing.length",
      status,
      text: "营销软文默认写详细长文，正文约 1200-1600 字。",
      value: { lengthInstruction: "1200-1600字", label: "详细长文" },
      tags: ["marketing", "length"],
    }));
  }
  const channel = /朋友圈|私域|微信/.test(value)
    ? "朋友圈/私域"
    : /公众号|推文/.test(value)
      ? "公众号"
      : /阿里|国际站|B2B|b2b|平台/.test(value)
        ? "B2B平台"
        : /官网|网站/.test(value)
          ? "官网"
          : "";
  if (channel) {
    items.push(candidate(value, {
      type: "preference",
      key: "marketing.channel",
      status,
      text: `营销软文默认偏${channel}渠道。`,
      value: { channel },
      tags: ["marketing", "channel"],
    }));
  }
  if (/(客户|采购|转化|官网|专业|克制|自然|口语|销售)/.test(value)) {
    items.push(candidate(value, {
      type: "preference",
      key: "marketing.style",
      status,
      text: `营销软文风格偏好：${value.replace(/\s+/g, " ").slice(0, 80)}。`,
      value: { style: value.replace(/\s+/g, " ").slice(0, 160) },
      tags: ["marketing", "style"],
    }));
  }
  return items;
}

function trainingCandidates(text, status) {
  const value = String(text || "");
  if (!/(培训|考试|题|及格|通过分数|学习)/.test(value)) return [];
  const items = [];
  const quizCount = parseQuizCount(value);
  if (Number.isFinite(quizCount)) {
    items.push(candidate(value, {
      type: "preference",
      key: "training.quizCount",
      status,
      text: `培训默认出 ${quizCount} 道题。`,
      value: { quizCount },
      tags: ["training", "quiz"],
    }));
  }
  const passScore = parsePassScore(value);
  if (Number.isFinite(passScore)) {
    items.push(candidate(value, {
      type: "preference",
      key: "training.passScore",
      status,
      text: `培训默认通过分数为 ${passScore} 分。`,
      value: { passScore },
      tags: ["training", "quiz"],
    }));
  }
  return items;
}

function generalStyleCandidates(text, status) {
  const value = String(text || "");
  if (!/(回答|回复|解释|聊天|输出).*(简洁|详细|中文|自然|直接|口语)/.test(value)) return [];
  return [candidate(value, {
    type: "preference",
    key: "general.responseStyle",
    status,
    text: `普通聊天回复偏好：${value.replace(/\s+/g, " ").slice(0, 120)}。`,
    value: { style: value.replace(/\s+/g, " ").slice(0, 180) },
    tags: ["general", "style"],
  })];
}

function workflowCandidates(text, status) {
  const value = String(text || "");
  if (!/(重新输入|重输).*(不是|不要|不能).*(确认|发布)|确认发布.*短句/.test(value)) return [];
  return [candidate(value, {
    type: "workflow",
    key: "workflow.publishConfirmation",
    status,
    text: "重新输入完整培训安排时应创建新草稿，不能当作确认发布旧草稿。",
    value: { rule: "reinput_creates_new_draft" },
    tags: ["workflow", "intent"],
  })];
}

export function extractMemoryCandidates(text) {
  const value = String(text || "").trim();
  const status = memoryStatusForText(value);
  if (!value || status === "none" || status === "blocked" || shouldBlockMemoryWrite(value)) return [];
  return [
    ...marketingCandidates(value, status),
    ...trainingCandidates(value, status),
    ...generalStyleCandidates(value, status),
    ...workflowCandidates(value, status),
  ];
}
