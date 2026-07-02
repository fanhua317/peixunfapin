import { aiWritingStyleThresholds, analyzeMarketingArticleStyle } from "./ai-writing-style.mjs";

const DEFAULT_THRESHOLDS = {
  internalRepeatMax: Number(process.env.TRAINING_MARKETING_INTERNAL_REPEAT_MAX || 0.18),
  batchSimilarityMax: Number(process.env.TRAINING_MARKETING_BATCH_SIMILARITY_MAX || 0.42),
  historySimilarityMax: Number(process.env.TRAINING_MARKETING_HISTORY_SIMILARITY_MAX || 0.50),
  titleSimilarityMax: Number(process.env.TRAINING_MARKETING_TITLE_SIMILARITY_MAX || 0.65),
  templatePhraseHitsMax: Number(process.env.TRAINING_MARKETING_TEMPLATE_HITS_MAX || 2),
};

const TEMPLATE_PHRASES = [
  "\u5728\u5f53\u4eca\u7ade\u4e89\u6fc0\u70c8\u7684\u5e02\u573a\u73af\u5883\u4e0b",
  "\u968f\u7740\u5de5\u4e1a\u5316\u8fdb\u7a0b\u7684\u4e0d\u65ad\u63a8\u8fdb",
  "\u51ed\u501f\u5353\u8d8a\u6027\u80fd",
  "\u4e3a\u5ba2\u6237\u63d0\u4f9b\u4f18\u8d28\u89e3\u51b3\u65b9\u6848",
  "\u5f00\u542f\u65b0\u7bc7\u7ae0",
  "\u8d4b\u80fd\u4f01\u4e1a\u53d1\u5c55",
  "\u52a9\u529b\u4ea7\u4e1a\u5347\u7ea7",
  "\u503c\u5f97\u4fe1\u8d56\u7684\u9009\u62e9",
  "in today's competitive market",
  "with excellent performance",
  "provide customers with high-quality solutions",
  "empower business growth",
  "new chapter",
];

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function marketingUniquenessThresholds(overrides = {}) {
  const aiStyle = aiWritingStyleThresholds(overrides);
  return {
    internalRepeatMax: numberValue(overrides.internalRepeatMax, DEFAULT_THRESHOLDS.internalRepeatMax),
    batchSimilarityMax: numberValue(overrides.batchSimilarityMax, DEFAULT_THRESHOLDS.batchSimilarityMax),
    historySimilarityMax: numberValue(overrides.historySimilarityMax, DEFAULT_THRESHOLDS.historySimilarityMax),
    titleSimilarityMax: numberValue(overrides.titleSimilarityMax, DEFAULT_THRESHOLDS.titleSimilarityMax),
    templatePhraseHitsMax: numberValue(overrides.templatePhraseHitsMax, DEFAULT_THRESHOLDS.templatePhraseHitsMax),
    aiWritingScoreMax: aiStyle.aiWritingScoreMax,
    aiWritingTopIssues: aiStyle.aiWritingTopIssues,
  };
}

function clampRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[`*_#[\](){}>"'“”‘’]/g, " ")
    .replace(/[，。！？；：、,.!?;:/\\|+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(value) {
  return String(value || "")
    .split(/[。！？!?；;\n]+/g)
    .map((item) => normalizeText(item))
    .filter((item) => item.length >= 10);
}

function hanChars(value) {
  return [...String(value || "").matchAll(/\p{Script=Han}/gu)].map((match) => match[0]);
}

function latinWords(value) {
  return String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

function sequenceNgrams(items, size, prefix) {
  const grams = [];
  if (!Array.isArray(items) || items.length < size) return grams;
  for (let index = 0; index <= items.length - size; index += 1) {
    grams.push(`${prefix}:${items.slice(index, index + size).join("|")}`);
  }
  return grams;
}

function textNgrams(value) {
  const text = normalizeText(value);
  const chars = hanChars(text);
  const words = latinWords(text);
  return [
    ...sequenceNgrams(chars, 4, "zh4"),
    ...sequenceNgrams(chars, 5, "zh5"),
    ...sequenceNgrams(words, 3, "en3"),
  ];
}

function gramSet(value) {
  return new Set(textNgrams(value));
}

function jaccard(left, right) {
  if (!left.size && !right.size) return 0;
  let intersection = 0;
  const smaller = left.size < right.size ? left : right;
  const larger = left.size < right.size ? right : left;
  for (const item of smaller) {
    if (larger.has(item)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union ? intersection / union : 0;
}

function textSimilarity(left, right) {
  return clampRatio(jaccard(gramSet(left), gramSet(right)));
}

function internalRepeatRatio(article = {}) {
  const text = `${article.title || ""}\n${article.summary || ""}\n${article.article || ""}`;
  const grams = textNgrams(text);
  if (!grams.length) return 0;
  const counts = new Map();
  for (const gram of grams) counts.set(gram, (counts.get(gram) || 0) + 1);
  const repeatedGrams = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const gramRatio = repeatedGrams / grams.length;

  const sentences = splitSentences(text);
  const sentenceCounts = new Map();
  for (const sentence of sentences) sentenceCounts.set(sentence, (sentenceCounts.get(sentence) || 0) + 1);
  const repeatedSentenceChars = [...sentenceCounts.entries()]
    .filter(([, count]) => count > 1)
    .reduce((sum, [sentence, count]) => sum + sentence.length * (count - 1), 0);
  const sentenceChars = sentences.reduce((sum, sentence) => sum + sentence.length, 0);
  const sentenceRatio = sentenceChars ? repeatedSentenceChars / sentenceChars : 0;

  return clampRatio(Math.max(gramRatio, sentenceRatio));
}

function templatePhraseHits(article = {}) {
  const text = normalizeText(`${article.title || ""}\n${article.summary || ""}\n${article.article || ""}`);
  return TEMPLATE_PHRASES
    .filter((phrase) => text.includes(normalizeText(phrase)))
    .map((phrase) => phrase);
}

function publicArticle(article = {}, index = 0) {
  return {
    index,
    title: String(article.title || "").trim(),
    summary: String(article.summary || "").trim(),
    article: String(article.article || "").trim(),
    angle: String(article.angle || "").trim(),
  };
}

function articleText(article = {}) {
  return `${article.title || ""}\n${article.summary || ""}\n${article.article || ""}`;
}

function maxPairwiseSimilarity(articles, selector) {
  let max = 0;
  let pair = [];
  for (let left = 0; left < articles.length; left += 1) {
    for (let right = left + 1; right < articles.length; right += 1) {
      const value = textSimilarity(selector(articles[left]), selector(articles[right]));
      if (value > max) {
        max = value;
        pair = [left, right];
      }
    }
  }
  return { value: clampRatio(max), pair };
}

function maxHistorySimilarity(articles, historyArticles = []) {
  let max = 0;
  let articleIndex = -1;
  let historyIndex = -1;
  for (let left = 0; left < articles.length; left += 1) {
    for (let right = 0; right < historyArticles.length; right += 1) {
      const value = textSimilarity(articleText(articles[left]), articleText(historyArticles[right]));
      if (value > max) {
        max = value;
        articleIndex = left;
        historyIndex = right;
      }
    }
  }
  return {
    value: clampRatio(max),
    articleIndex,
    historyIndex,
    matchedTitle: historyArticles[historyIndex]?.title || "",
    matchedSessionId: historyArticles[historyIndex]?.sessionId || "",
  };
}

function articleMetrics(article, index, thresholds) {
  const templateHits = templatePhraseHits(article);
  const repeatRatio = internalRepeatRatio(article);
  const aiStyle = analyzeMarketingArticleStyle(article, thresholds);
  const issues = [];
  if (repeatRatio > thresholds.internalRepeatMax) issues.push("internal_repeat");
  if (templateHits.length > thresholds.templatePhraseHitsMax) issues.push("template_phrases");
  if (aiStyle.status === "needs_rewrite") issues.push("ai_writing_style");
  return {
    index,
    title: article.title || "",
    angle: article.angle || "",
    internalRepeatRatio: repeatRatio,
    templatePhraseHits: templateHits.length,
    templatePhrases: templateHits.slice(0, 6),
    aiWritingScore: aiStyle.aiWritingScore,
    aiWritingScoreMax: aiStyle.aiWritingScoreMax,
    aiWritingStatus: aiStyle.status,
    aiWritingLabel: aiStyle.label,
    aiWritingClassification: aiStyle.classification,
    aiWritingConfidence: aiStyle.confidence,
    aiWritingIssueCount: aiStyle.issueCount,
    aiWritingTopIssues: aiStyle.topIssues,
    aiWritingWarning: aiStyle.warning,
    status: issues.length ? "needs_rewrite" : "ok",
    issues,
  };
}

function riskScore(metrics, thresholds) {
  const parts = [
    metrics.internalRepeatRatio / Math.max(thresholds.internalRepeatMax, 0.01),
    metrics.batchMaxSimilarity / Math.max(thresholds.batchSimilarityMax, 0.01),
    metrics.historyMaxSimilarity / Math.max(thresholds.historySimilarityMax, 0.01),
    metrics.titleSimilarity / Math.max(thresholds.titleSimilarityMax, 0.01),
    metrics.templatePhraseHits / Math.max(thresholds.templatePhraseHitsMax, 1),
    metrics.aiWritingScoreMax / Math.max(thresholds.aiWritingScoreMax, 1),
  ];
  return parts.reduce((sum, value) => sum + Math.max(0, value), 0);
}

function aggregateAiWritingIssues(articleScores, limit = 8) {
  const grouped = new Map();
  for (const article of articleScores) {
    for (const issue of article.aiWritingTopIssues || []) {
      const current = grouped.get(issue.type) || {
        type: issue.type,
        label: issue.label,
        severity: issue.severity,
        severityLabel: issue.severityLabel,
        count: 0,
        samples: [],
      };
      current.count += Number(issue.count) || 0;
      for (const sample of issue.samples || []) {
        if (sample && current.samples.length < 3 && !current.samples.includes(sample)) current.samples.push(sample);
      }
      grouped.set(issue.type, current);
    }
  }
  return [...grouped.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, Math.max(1, Number(limit) || 8));
}

export function evaluateMarketingUniqueness(articlesInput = [], { historyArticles = [], thresholds: thresholdOverrides = {} } = {}) {
  const thresholds = marketingUniquenessThresholds(thresholdOverrides);
  const articles = (Array.isArray(articlesInput) ? articlesInput : [articlesInput]).map(publicArticle);
  const articleScores = articles.map((article, index) => articleMetrics(article, index, thresholds));
  const batch = maxPairwiseSimilarity(articles, articleText);
  const title = maxPairwiseSimilarity(articles, (article) => article.title || "");
  const history = maxHistorySimilarity(articles, Array.isArray(historyArticles) ? historyArticles : []);
  const maxInternalRepeat = articleScores.reduce((max, item) => Math.max(max, item.internalRepeatRatio), 0);
  const maxTemplateHits = articleScores.reduce((max, item) => Math.max(max, item.templatePhraseHits), 0);
  const maxAiWritingArticle = articleScores.reduce((best, item) => (item.aiWritingScore > (best?.aiWritingScore ?? -1) ? item : best), null);
  const maxAiWritingScore = maxAiWritingArticle?.aiWritingScore || 0;
  const aiWritingWarnings = articleScores.map((item) => item.aiWritingWarning).filter(Boolean);
  const issues = [
    ...(maxInternalRepeat > thresholds.internalRepeatMax ? ["internal_repeat"] : []),
    ...(batch.value > thresholds.batchSimilarityMax ? ["batch_similarity"] : []),
    ...(history.value > thresholds.historySimilarityMax ? ["history_similarity"] : []),
    ...(title.value > thresholds.titleSimilarityMax ? ["title_similarity"] : []),
    ...(maxTemplateHits > thresholds.templatePhraseHitsMax ? ["template_phrases"] : []),
    ...(maxAiWritingScore > thresholds.aiWritingScoreMax ? ["ai_writing_style"] : []),
  ];
  const metrics = {
    internalRepeatRatio: clampRatio(maxInternalRepeat),
    batchMaxSimilarity: clampRatio(batch.value),
    historyMaxSimilarity: clampRatio(history.value),
    templatePhraseHits: maxTemplateHits,
    titleSimilarity: clampRatio(title.value),
    aiWritingScoreMax: maxAiWritingScore,
    aiWritingStatus: maxAiWritingScore > thresholds.aiWritingScoreMax ? "needs_rewrite" : "ok",
    aiWritingLabel: maxAiWritingArticle?.aiWritingLabel || "",
    aiWritingIssueCount: articleScores.reduce((sum, item) => sum + (Number(item.aiWritingIssueCount) || 0), 0),
    aiWritingTopIssues: aggregateAiWritingIssues(articleScores, thresholds.aiWritingTopIssues),
  };
  return {
    enabled: true,
    overallStatus: issues.length ? "needs_rewrite" : "ok",
    issues,
    ...metrics,
    thresholds,
    batchPair: batch.pair,
    titlePair: title.pair,
    historyMatch: {
      articleIndex: history.articleIndex,
      historyIndex: history.historyIndex,
      title: history.matchedTitle,
      sessionId: history.matchedSessionId,
    },
    articles: articleScores,
    warnings: aiWritingWarnings,
    riskScore: riskScore(metrics, thresholds),
  };
}

export function uniquenessDisabled() {
  return ["0", "false", "off", "no"].includes(String(process.env.TRAINING_MARKETING_UNIQUENESS_ENABLED || "1").toLowerCase());
}

export function summarizeUniquenessIssues(uniqueness = {}) {
  const issues = Array.isArray(uniqueness.issues) ? uniqueness.issues : [];
  if (!issues.length) return "No similarity issues detected.";
  const parts = [];
  if (issues.includes("internal_repeat")) parts.push(`internal repeat ${(uniqueness.internalRepeatRatio * 100).toFixed(1)}%`);
  if (issues.includes("batch_similarity")) parts.push(`batch similarity ${(uniqueness.batchMaxSimilarity * 100).toFixed(1)}%`);
  if (issues.includes("history_similarity")) parts.push(`history similarity ${(uniqueness.historyMaxSimilarity * 100).toFixed(1)}%`);
  if (issues.includes("title_similarity")) parts.push(`title similarity ${(uniqueness.titleSimilarity * 100).toFixed(1)}%`);
  if (issues.includes("template_phrases")) parts.push(`template phrase hits ${uniqueness.templatePhraseHits}`);
  if (issues.includes("ai_writing_style")) parts.push(`AI writing score ${uniqueness.aiWritingScoreMax}/${uniqueness.thresholds?.aiWritingScoreMax || 35}`);
  return parts.join("; ");
}
