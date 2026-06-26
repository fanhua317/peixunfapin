import { marketingPreferencesFromMemory } from "../memory/index.mjs";
import { searchKnowledgeContexts } from "../rag.mjs";
import { AI_PROFILE } from "./config.mjs";
import { askLlmStructured } from "./llm-json.mjs";
import {
  allowedSourceRefs,
  normalizeSourceRefs,
  renderContext,
  retrievalModeFromChunks,
  selectContextChunksHybrid,
  sourceObjects,
} from "./context.mjs";
import {
  cleanAnswerText,
  cleanTrainingText,
  compactMultiline,
  compactText,
  modelRequiredError,
  uniqueStrings,
} from "./text-utils.mjs";

function requestedWebSearch(instruction) {
  return /(联网|网上|网络|搜索|查一下|查找|检索|最新|外部资料|行业趋势|竞品|市场数据)/.test(String(instruction || ""));
}

function marketingSubjectText(instruction) {
  return String(instruction || "")
    .replace(/联网|网上|网络|搜索|查一下|查找|检索|最新|外部资料|行业趋势|竞品|市场数据/g, " ")
    .replace(/写|生成|做|来|给我|帮我|整理|创作|一篇|关于|基于|根据/g, " ")
    .replace(/软文|营销文章|推广文案|公众号文章|产品介绍|宣传文案|客户文章|宣传稿|营销稿|官网文章|推文|文章|文案/g, " ")
    .replace(/短一点|简短|详细|完整|客户营销|客户|官网|公众号|朋友圈|阿里国际站|B2B|b2b|平台/g, " ")
    .replace(/联网|网上|网络|搜索|查一下|查找|检索|最新|外部资料|行业趋势|竞品|市场数据/g, " ")
    .replace(/写|生成|做|来|出|整理|创作|给我|帮我|一篇|关于|基于|根据/g, " ")
    .replace(/软文|营销文章|推广文案|公众号文章|产品介绍|宣传文案|客户文章|宣传稿|营销稿|官网文章|推文|文章|文案/g, " ")
    .replace(/短一点|简短|详细|完整|客户营销|客户|官网|公众号|朋友圈|阿里国际站|B2B|b2b|平台/g, " ")
    .replace(/[，,。.!！?？:：；;\s]+/g, " ")
    .trim();
}

function normalizeMarketingSubject(value) {
  return String(value || "")
    .replace(/联网|网上|网络|搜索|查一下|查找|检索|最新|外部资料|行业趋势|竞品|市场数据/g, " ")
    .replace(/写|生成|做|来|给我|帮我|整理|创作|一篇|关于|基于|根据/g, " ")
    .replace(/软文|营销文章|推广文案|公众号文章|产品介绍|宣传文案|客户文章|宣传稿|营销稿|官网文章|推文|文章|文案/g, " ")
    .replace(/短一点|简短|详细|完整|客户营销|客户|官网|公众号|朋友圈|阿里国际站|B2B|b2b|平台/g, " ")
    .replace(/[的了呢吗啊呀把将和与及或、，。！？：；（）()【】《》“”"'\\s]+/g, " ")
    .trim();
}

function kbSearchText(kb = {}) {
  return `${kb.id || ""} ${kb.name || ""} ${kb.description || ""} ${(kb.aliases || []).join(" ")}`.toLowerCase();
}

function isPumpKnowledgeBase(kb) {
  return /(水泵|泵|银嘉|yinjia|pump)/i.test(kbSearchText(kb));
}

function isMotorKnowledgeBase(kb) {
  return /(电机|电动机|motor|wonder)/i.test(kbSearchText(kb));
}

function domainMatchScore(kb, instruction) {
  const text = String(instruction || "");
  let score = 0;
  let matched = false;
  if (/(水泵|泵|银嘉|YINJIA|pump|centrifugal|peripheral|jet|booster|submersible)/i.test(text) && isPumpKnowledgeBase(kb)) {
    score += 8;
    matched = true;
  }
  if (/(电机|电动机|motor|WONDER|YE\d|IE\d)/i.test(text) && isMotorKnowledgeBase(kb)) {
    score += 8;
    matched = true;
  }
  return { score, matched };
}

async function matchMarketingKnowledgeBase(state, instruction) {
  const text = String(instruction || "").toLowerCase();
  const subject = normalizeMarketingSubject(marketingSubjectText(instruction) || instruction);
  const ready = (state.knowledgeBases || []).filter((kb) => kb.status === "ready");
  const scored = [];
  for (const kb of ready) {
    const names = uniqueStrings([
      kb.name,
      String(kb.name || "").replace(/资料库|培训资料库|培训/g, ""),
      ...(kb.aliases || []),
    ]).filter((item) => item.length >= 2);
    let score = 0;
    let explicitNameMatch = false;
    let explicitDomainMatch = false;
    for (const name of names) {
      const normalized = name.toLowerCase();
      if (normalized && text.includes(normalized)) {
        explicitNameMatch = true;
        score += normalized.length >= 4 ? 6 : 3;
      }
    }
    const domain = domainMatchScore(kb, instruction);
    score += domain.score;
    explicitDomainMatch = domain.matched;
    let chunkScore = 0;
    if (subject.length >= 2) {
      const matches = await searchKnowledgeContexts(state, { knowledgeBaseId: kb.id, query: subject, limit: 3 });
      chunkScore = matches.reduce((sum, chunk) => sum + Number(chunk.score || chunk.bm25Score || 0), 0);
      score += chunkScore;
    }
    scored.push({ kb, score, explicitNameMatch, explicitDomainMatch, chunkScore });
  }
  scored.sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best) return null;
  if (best.explicitNameMatch) return best.kb;
  if (best.explicitDomainMatch && best.score >= 8) return best.kb;
  return best.chunkScore >= 0.55 || best.chunkScore >= 4 ? best.kb : null;
}

function articleChannel(instruction, memoryPreferences = {}) {
  const text = String(instruction || "");
  if (/朋友圈|私域|微信/.test(text)) return "朋友圈/私域";
  if (/公众号|推文/.test(text)) return "公众号";
  if (/阿里|国际站|B2B|b2b|平台/.test(text)) return "B2B平台";
  if (/官网|网站/.test(text)) return "官网";
  if (memoryPreferences.channel) return memoryPreferences.channel;
  return "官网/公众号/B2B平台";
}

function articleLengthInstruction(instruction, memoryPreferences = {}) {
  const text = String(instruction || "");
  if (/短一点|简短|朋友圈|300字|五百字|500字/.test(text)) return "300-600字";
  if (/长文|详细|深度|完整|1500|一千五|2000|两千/.test(text)) return "1200-1600字";
  if (memoryPreferences.lengthInstruction) return memoryPreferences.lengthInstruction;
  return "800-1200字";
}

function insufficientMarketingArticle(message, warnings = []) {
  return {
    title: "资料不足，无法生成软文",
    summary: message,
    article: message,
    sellingPoints: [],
    sourceRefs: [],
    warnings,
    generatedBy: "none",
    retrievalMode: "none",
    insufficient: true,
    generatedAt: new Date().toISOString(),
  };
}

export async function generateMarketingArticle(state, { instruction, memoryContext } = {}) {
  const text = String(instruction || "").trim();
  const memoryPreferences = marketingPreferencesFromMemory(text, memoryContext);
  const webSearchDisabled = requestedWebSearch(text);
  const warnings = webSearchDisabled ? ["当前版本未开启联网搜索，已仅基于本地知识库生成。"] : [];
  const knowledgeBase = await matchMarketingKnowledgeBase(state, text);
  if (!knowledgeBase) {
    const prefix = webSearchDisabled ? "当前版本未开启联网搜索，且" : "";
    return insufficientMarketingArticle(`${prefix}本地知识库没有匹配到足够相关的产品资料，无法生成软文。`, warnings);
  }

  const chunks = await selectContextChunksHybrid(state, {
    knowledgeBaseId: knowledgeBase.id,
    query: text,
    limit: 16,
  });
  if (!chunks.length) {
    return insufficientMarketingArticle("本地知识库没有检索到足够相关的资料，无法生成软文。", warnings);
  }

  const sourceRefs = allowedSourceRefs(chunks);
  const profile = AI_PROFILE.marketingArticle;
  const articleSchema = {
    title: "营销文章标题",
    summary: "80-150字摘要",
    article: "完整营销文章正文，按自然段换行",
    sellingPoints: ["3-6个真实卖点"],
    sourceRefs: ["必须来自给定来源列表"],
    warnings: ["资料不足或表达限制"],
  };
  const prompt = `你是工业品营销内容策划。请基于给定资料，为客户营销场景生成一篇真实可信的中文软文。

硬性要求：
- 只允许依据给定资料，不要编造资料外事实，不要假装联网搜索。
- ${webSearchDisabled ? "用户提到了联网搜索，但当前系统没有联网搜索能力；文章只能写本地资料已支持的内容。" : "不要引用互联网、行业报告或未给出的市场数据。"}
- 文章面向客户营销，适合${articleChannel(text, memoryPreferences)}，正文长度${articleLengthInstruction(text, memoryPreferences)}。
- 语言要有销售转化感，但避免夸大、绝对化承诺和虚假排名。
- 写法要像工业品业务人员或内容编辑写给真实客户看的文章：表达具体、克制、自然，不要像通用 AI 模板。
- 避免空泛套话、万能开头、过度排比和口号式结尾，例如“在当今竞争激烈的市场环境下”“凭借卓越性能”“为客户提供优质解决方案”“开启新篇章”等。
- 句长和段落长度要有变化，可以用贴近销售沟通的具体场景表达，但不得为了自然感新增资料外细节。
- ${memoryPreferences.lines.length ? `用户长期偏好：${memoryPreferences.lines.join("；")}。当前输入若有明确要求，必须优先按当前输入。` : "没有可用的用户长期偏好。"}
- sourceRefs 必须从这个列表中选择：${JSON.stringify(sourceRefs)}
- 只能输出 JSON，不要 Markdown 包裹。

输出格式：${JSON.stringify(articleSchema)}

用户需求：${JSON.stringify(text)}
知识库：${JSON.stringify({ id: knowledgeBase.id, name: knowledgeBase.name, description: knowledgeBase.description || "", aliases: knowledgeBase.aliases || [] })}
资料上下文：
${renderContext(chunks)}`;

  try {
    const result = await askLlmStructured({ purpose: `marketing:${knowledgeBase.id}:${Date.now()}`, prompt, profile, repairSchema: articleSchema });
    if (!result.data) throw modelRequiredError("营销软文生成", result.error || "大模型未返回结构化软文");
    const data = result.data || {};
    const article = cleanAnswerText(data.article, 5200);
    if (!article) throw modelRequiredError("营销软文生成", "大模型没有返回可显示正文");
    const normalizedSourceRefs = normalizeSourceRefs(data.sourceRefs, chunks);
    const modelWarnings = Array.isArray(data.warnings) ? data.warnings : [data.warnings].filter(Boolean);
    return {
      title: compactText(data.title || `${knowledgeBase.name}营销软文`, 120),
      summary: compactMultiline(data.summary, 360),
      article: compactMultiline(article, 5200),
      sellingPoints: uniqueStrings(data.sellingPoints).map((item) => cleanTrainingText(item)).filter(Boolean).slice(0, 8),
      sourceRefs: normalizedSourceRefs,
      warnings: uniqueStrings([
        ...warnings,
        ...modelWarnings,
        ...(result.truncated || result.finishReason === "length" ? ["model_output_truncated"] : []),
      ]).slice(0, 8),
      sources: sourceObjects(chunks).filter((source) => normalizedSourceRefs.includes(source.sourceRef)),
      knowledgeBase: {
        id: knowledgeBase.id,
        name: knowledgeBase.name,
      },
      generatedBy: result.source || "openclaw",
      thinking: result.thinking || profile.thinking,
      model: result.model || profile.model,
      sessionPatch: result.sessionPatch,
      runId: result.runId,
      finishReason: result.finishReason || "",
      truncated: result.truncated === true || result.finishReason === "length",
      repaired: result.repaired === true,
      retrievalMode: retrievalModeFromChunks(chunks),
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    throw modelRequiredError("营销软文生成", error);
  }
}
