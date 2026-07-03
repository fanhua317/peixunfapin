import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "juzhou-marketing-uniq-"));

process.env.TRAINING_STORAGE = "json";
process.env.TRAINING_DATA_DIR = tempDir;
process.env.TRAINING_HYBRID_RETRIEVAL = "0";
process.env.TRAINING_LLM_PROVIDER = "marketing-uniqueness-mock";
process.env.TRAINING_LLM_API_KEY = "marketing-uniqueness-key";
process.env.TRAINING_LLM_MODEL = "marketing-uniqueness-model";
process.env.TRAINING_LLM_TIMEOUT_MS = "5000";
process.env.TRAINING_MARKETING_UNIQUENESS_ENABLED = "1";
process.env.TRAINING_MARKETING_REWRITE_ATTEMPTS = "2";
process.env.TRAINING_MARKETING_HISTORY_LIMIT = "50";
process.env.TRAINING_MARKETING_HISTORY_DAYS = "3";
process.env.TRAINING_MARKETING_INTERNAL_REPEAT_MAX = "0.18";
process.env.TRAINING_MARKETING_BATCH_SIMILARITY_MAX = "0.42";
process.env.TRAINING_MARKETING_HISTORY_SIMILARITY_MAX = "0.50";
process.env.TRAINING_MARKETING_TITLE_SIMILARITY_MAX = "0.65";
process.env.TRAINING_MARKETING_AI_STYLE_ENABLED = "1";
process.env.TRAINING_MARKETING_AI_SCORE_MAX = "35";
process.env.TRAINING_MARKETING_AI_STYLE_TOP_ISSUES = "8";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function repeatedArticle(title, angle) {
  const body = [
    "在当今竞争激烈的市场环境下，YINJIA CM2 pump helps customers handle clean-water transfer with stable pressure and practical maintenance.",
    "在当今竞争激烈的市场环境下，YINJIA CM2 pump helps customers handle clean-water transfer with stable pressure and practical maintenance.",
    "With excellent performance, the pump supports household boosting, garden irrigation, and light commercial water supply based on local product material.",
  ].join("\n\n");
  return {
    title,
    angle,
    summary: "YINJIA CM2 pump provides stable clean-water transfer value for customer-facing marketing.",
    article: body,
    sellingPoints: ["Stable clean-water transfer", "Practical maintenance", "Customer-facing application scenes"],
    sourceRefs: ["pump.md :: CM2"],
    webSourceRefs: ["web:1 Pump market background"],
    warnings: [],
  };
}

function diversifiedArticles() {
  return [
    {
      title: "CM2 pump for practical home water transfer",
      angle: "应用场景型",
      summary: "Focuses on clean-water transfer scenes where CM2 can help customers explain use cases clearly.",
      article: [
        "Home users often care less about abstract specifications and more about where a pump fits. CM2 can be positioned around clean-water transfer, household boosting, and garden irrigation because the local material describes these application boundaries.",
        "For a sales conversation, the useful angle is matching the pump to stable daily water movement, then explaining installation and maintenance in concrete terms.",
      ].join("\n\n"),
      sellingPoints: ["Clean-water transfer positioning", "Household and garden scenes", "Grounded in local CM2 material"],
      sourceRefs: ["pump.md :: CM2"],
      webSourceRefs: ["web:1 Pump market background"],
      warnings: [],
    },
    {
      title: "A buyer checklist for CM2 pump selection",
      angle: "采购决策型",
      summary: "Turns the CM2 product material into a buyer-oriented checklist for matching scenarios and service needs.",
      article: [
        "A procurement article should guide the buyer through scene, water type, pressure expectations, and maintenance access before discussing the product. CM2 is suitable for clean-water transfer, household boosting, garden irrigation, and light commercial water supply according to the local source.",
        "This structure helps a sales team avoid broad claims while still making the buying logic easy to follow.",
      ].join("\n\n"),
      sellingPoints: ["Buyer checklist structure", "Scenario-first explanation", "Avoids unsupported performance claims"],
      sourceRefs: ["pump.md :: CM2"],
      webSourceRefs: ["web:1 Pump market background"],
      warnings: [],
    },
    {
      title: "CM2 pump value through serviceable design",
      angle: "维护成本型",
      summary: "Explains CM2 value from maintenance clarity and long-term customer communication instead of repeating scene copy.",
      article: [
        "For distributors, repeat sales often depend on whether a product is easy to explain after delivery. CM2 can be introduced through its clean-water application range and practical maintenance communication, keeping the claims inside the local knowledge base.",
        "The article can close by encouraging customers to confirm water quality, usage scene, and service expectations before final selection.",
      ].join("\n\n"),
      sellingPoints: ["Maintenance communication", "Distributor-friendly explanation", "Fact-safe closing guidance"],
      sourceRefs: ["pump.md :: CM2"],
      webSourceRefs: ["web:1 Pump market background"],
      warnings: [],
    },
  ];
}

function articleText(article) {
  return `${article.title}\n${article.summary}\n${article.article}`;
}

const prompts = [];
const temperatures = [];
const OLD_WEB_BACKGROUND_ONLY_PHRASE = ["Web search material is only", "external background"].join(" ");
let callCount = 0;

try {
  const { registerLlmProvider } = await import("../src/llm.mjs");
  registerLlmProvider("marketing-uniqueness-mock", async (prompt, options = {}) => {
    const promptText = String(prompt || "");
    prompts.push(promptText);
    temperatures.push(options.temperature);
    callCount += 1;
    const isRewrite = promptText.includes("Rewrite the marketing article JSON");
    return {
      answer: JSON.stringify({
        articles: isRewrite
          ? diversifiedArticles()
          : [
              repeatedArticle("CM2 pump customer value article", "应用场景型"),
              repeatedArticle("CM2 pump customer value article", "采购决策型"),
              repeatedArticle("CM2 pump customer value article", "技术卖点型"),
            ],
        warnings: [],
      }),
      source: "mock-llm",
      model: options.model || "mock-model",
      finishReason: "stop",
    };
  });

  const {
    evaluateMarketingUniqueness,
    marketingUniquenessThresholds,
  } = await import("../src/ai/article-uniqueness.mjs");
  const { analyzeMarketingArticleStyle } = await import("../src/ai/ai-writing-style.mjs");
  const { appendBossChatMessages, listRecentMarketingArticles } = await import("../src/boss-chat/store.mjs");
  const { generateMarketingArticle } = await import("../src/ai/marketing.mjs");

  const identical = evaluateMarketingUniqueness([
    repeatedArticle("Same", "A"),
    repeatedArticle("Same", "B"),
  ]);
  assert(identical.batchMaxSimilarity > 0.8, `identical articles should be highly similar, got ${identical.batchMaxSimilarity}`);
  assert(identical.overallStatus === "needs_rewrite", "identical articles should need rewrite");

  const distinct = evaluateMarketingUniqueness(diversifiedArticles());
  assert(distinct.batchMaxSimilarity <= marketingUniquenessThresholds().batchSimilarityMax, `distinct articles should pass batch threshold, got ${distinct.batchMaxSimilarity}`);

  const template = evaluateMarketingUniqueness([repeatedArticle("Template", "A")]);
  assert(template.templatePhraseHits > 0, "template phrase should be detected");

  const aiHeavyArticle = {
    title: "AI-heavy industrial article",
    summary: "In today's ever-evolving landscape, this robust solution is a game-changer.",
    article: [
      "In today's ever-evolving landscape, we delve into the intricate tapestry of industrial innovation.",
      "This seamless, robust paradigm showcases a comprehensive framework.",
      "Moreover, it truly is a game-changer. Furthermore, this pivotal moment underscores market transformation.",
    ].join(" "),
  };
  const aiHeavy = analyzeMarketingArticleStyle(aiHeavyArticle);
  assert(aiHeavy.aiWritingScore > 60, `AI-heavy text should score high, got ${aiHeavy.aiWritingScore}`);
  const aiHeavyQuality = evaluateMarketingUniqueness([aiHeavyArticle]);
  assert(aiHeavyQuality.aiWritingScoreMax > 35, `AI writing score should flag AI-heavy prose, got ${aiHeavyQuality.aiWritingScoreMax}`);
  assert(aiHeavyQuality.issues.includes("ai_writing_style"), "AI-heavy prose should include ai_writing_style issue");
  assert(aiHeavyQuality.aiWritingTopIssues?.length > 0, "AI writing style issues should include grouped top issues");

  const plainIndustrial = analyzeMarketingArticleStyle(diversifiedArticles()[0]);
  assert(plainIndustrial.aiWritingScore <= 35, `plain industrial prose should pass AI-style threshold, got ${plainIndustrial.aiWritingScore}`);

  const mixed = evaluateMarketingUniqueness([
    {
      title: "Mixed CM2 pump article",
      summary: "CM2 pump supports clean-water transfer.",
      article: "CM2 pump supports clean-water transfer. CM2泵适用于清水输送。",
    },
    {
      title: "Mixed CM2 pump article copy",
      summary: "CM2 pump supports clean-water transfer.",
      article: "CM2 pump supports clean-water transfer. CM2泵适用于清水输送。",
    },
  ]);
  assert(mixed.batchMaxSimilarity > 0.4, `mixed Chinese/English duplicate should be measurable, got ${mixed.batchMaxSimilarity}`);

  await appendBossChatMessages("recent-marketing-history", [{
    id: "msg-recent",
    role: "assistant",
    action: "marketing_article",
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    payload: {
      action: "marketing_article",
      article: {
        knowledgeBase: { id: "kb-pump", name: "YINJIA pump knowledge base" },
        articles: [{
          title: "Recent CM2 history",
          summary: "Recent history should be used for similarity checks.",
          article: articleText(repeatedArticle("CM2 pump customer value article", "history")),
          sourceRefs: ["pump.md :: CM2"],
        }],
      },
    },
  }, {
    id: "msg-old",
    role: "assistant",
    action: "marketing_article",
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    payload: {
      action: "marketing_article",
      article: {
        knowledgeBase: { id: "kb-pump", name: "YINJIA pump knowledge base" },
        title: "Old history",
        article: "This old article is outside the 3 day comparison window.",
        sourceRefs: ["pump.md :: CM2"],
      },
    },
  }], { title: "history fixture" });

  const history = await listRecentMarketingArticles({ knowledgeBaseId: "kb-pump", days: 3, limit: 50 });
  assert(history.length === 1, `3 day history window should include only recent item, got ${history.length}`);
  assert(history[0].title === "Recent CM2 history", "recent history item should be selected");

  const state = {
    knowledgeBases: [{
      id: "kb-pump",
      name: "YINJIA pump knowledge base",
      aliases: ["YINJIA", "pump", "CM2"],
      description: "YINJIA pump product material",
      status: "ready",
    }],
    documents: [],
    chunkParents: [],
    chunks: [{
      id: "chunk-pump-1",
      knowledgeBaseId: "kb-pump",
      documentId: "doc-pump",
      sourceRef: "pump.md :: CM2",
      heading: "CM2 clean-water pump",
      content: "YINJIA CM2 pump is used for clean-water transfer, household boosting, garden irrigation, and light commercial water supply. Sales copy should stay factual and avoid unsupported performance claims.",
      searchText: "YINJIA CM2 pump clean water transfer household boosting garden irrigation light commercial water supply marketing article",
    }],
  };

  const result = await generateMarketingArticle(state, {
    instruction: "生成三篇 YINJIA CM2 pump 宣传软文",
    articleCount: 3,
    webSearchMode: "off",
    memoryContext: { longTerm: [], recentMessages: [] },
  });

  assert(callCount >= 2, `generation should call mock LLM at least twice after rewrite, got ${callCount}`);
  assert(result.articles?.length === 3, `should return three articles, got ${result.articles?.length}`);
  assert(result.articleCount === 3, `articleCount should be 3, got ${result.articleCount}`);
  assert(result.uniqueness?.rewriteAttempts > 0, "rewrite attempts should be recorded");
  assert(result.uniqueness?.historyWindowDays === 3, `history window should be 3 days, got ${result.uniqueness?.historyWindowDays}`);
  assert(result.uniqueness?.batchMaxSimilarity <= result.uniqueness.thresholds.batchSimilarityMax, `final batch similarity should pass threshold, got ${result.uniqueness?.batchMaxSimilarity}`);
  assert(result.uniqueness?.historyMaxSimilarity <= result.uniqueness.thresholds.historySimilarityMax, `final history similarity should pass threshold, got ${result.uniqueness?.historyMaxSimilarity}`);
  assert(result.uniqueness?.aiWritingScoreMax <= result.uniqueness.thresholds.aiWritingScoreMax, `final AI writing score should pass threshold, got ${result.uniqueness?.aiWritingScoreMax}`);
  assert(result.articles.every((article) => article.uniqueness?.aiWritingScore <= article.uniqueness?.aiWritingScoreMax), "per-article AI writing scores should pass thresholds");
  assert(result.sourceRefs?.includes("pump.md :: CM2"), "top-level source refs should be preserved");
  assert(result.articles.every((article) => article.sourceRefs?.includes("pump.md :: CM2")), "per-article source refs should be preserved");
  assert(prompts[0].includes("Generate 3 factual marketing article"), "first prompt should request three structured articles");
  assert(prompts[0].includes("industrial B2B pump sales engineer"), "first prompt should use B2B pump sales engineer role");
  assert(prompts[0].includes("topic choice, opening angle") && prompts[0].includes("buyer pain points"), "first prompt should let web sources shape article angles");
  assert(prompts[0].includes("Do not open by summarizing the local knowledge-base material"), "first prompt should block local-material-summary openings");
  assert(prompts[0].includes("distinct angle"), "first prompt should enforce different angles");
  assert(prompts[0].includes("Avoid-AI-writing style guardrail"), "first prompt should include avoid-ai-writing style guardrail");
  assert(temperatures.some((value) => value === 0.6), "marketing model calls should use temperature 0.6");
  assert(!prompts.some((prompt) => prompt.includes(OLD_WEB_BACKGROUND_ONLY_PHRASE)), "prompts should not demote web material to background only");
  assert(prompts.some((prompt) => prompt.includes("Rewrite the marketing article JSON")), "rewrite prompt should be sent");
  assert(prompts.some((prompt) => prompt.includes("B2B pump sales engineer") && prompt.includes("industrial export sales editor")), "rewrite prompt should use sales-engineer editor voice");
  assert(prompts.some((prompt) => prompt.includes("buyer objection handling")), "rewrite prompt should improve sales objections and angle");
  assert(prompts.some((prompt) => prompt.includes("Fix avoid-AI-writing issues")), "rewrite prompt should target AI writing style issues");
  assert(prompts.some((prompt) => prompt.includes("Allowed local sourceRefs")), "rewrite prompt should preserve local source refs");

  console.log(JSON.stringify({
    ok: true,
    unitChecks: {
      identicalBatchMaxSimilarity: identical.batchMaxSimilarity,
      distinctBatchMaxSimilarity: distinct.batchMaxSimilarity,
      templatePhraseHits: template.templatePhraseHits,
      mixedBatchMaxSimilarity: mixed.batchMaxSimilarity,
      aiHeavyScore: aiHeavy.aiWritingScore,
      plainIndustrialScore: plainIndustrial.aiWritingScore,
    },
    generation: {
      articleCount: result.articleCount,
      rewriteAttempts: result.uniqueness.rewriteAttempts,
      status: result.uniqueness.overallStatus,
      internalRepeatRatio: result.uniqueness.internalRepeatRatio,
      batchMaxSimilarity: result.uniqueness.batchMaxSimilarity,
      historyMaxSimilarity: result.uniqueness.historyMaxSimilarity,
      aiWritingScoreMax: result.uniqueness.aiWritingScoreMax,
      aiWritingIssueCount: result.uniqueness.aiWritingIssueCount,
      historyWindowDays: result.uniqueness.historyWindowDays,
      sourceCount: result.sourceRefs.length,
      warningCount: result.warnings.length,
    },
  }, null, 2));
} catch (error) {
  console.error(error);
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
