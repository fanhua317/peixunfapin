import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AIDetector = require("../vendor/avoid-ai-writing/patterns.cjs");

const DEFAULT_AI_SCORE_MAX = Number(process.env.TRAINING_MARKETING_AI_SCORE_MAX || 35);
const DEFAULT_TOP_ISSUES = Number(process.env.TRAINING_MARKETING_AI_STYLE_TOP_ISSUES || 8);

const SEVERITY_RANK = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const AI_WRITING_STYLE_SOURCE = {
  name: "conorbronsdon/avoid-ai-writing",
  url: "https://github.com/conorbronsdon/avoid-ai-writing",
  commit: "6e1369dad98e61b165928f3849f225e11855cdaf",
  license: "MIT",
};

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function compactText(value, limit = 90) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

export function aiWritingStyleDisabled() {
  return ["0", "false", "off", "no"].includes(String(process.env.TRAINING_MARKETING_AI_STYLE_ENABLED || "1").toLowerCase());
}

export function aiWritingStyleThresholds(overrides = {}) {
  return {
    aiWritingScoreMax: numberValue(overrides.aiWritingScoreMax, DEFAULT_AI_SCORE_MAX),
    aiWritingTopIssues: Math.max(1, Math.min(20, numberValue(overrides.aiWritingTopIssues, DEFAULT_TOP_ISSUES))),
  };
}

export function aiWritingStylePromptGuidance() {
  return [
    "Avoid AI-writing tells: broad 'in today's...' openings, 'delve/leverage/robust/seamless' filler, significance inflation, vague attributions, and generic future-looking closers.",
    "Prefer direct product-language: concrete use scenes, plain verbs, varied paragraph length, specific transitions, and no chatbot artifacts such as 'Certainly', 'Let's dive in', or 'I hope this helps'.",
    "If a claim is not supported by the local knowledge base or selected web sources, cut it instead of polishing it.",
  ].join(" ");
}

function articleText(article = {}) {
  return `${article.title || ""}\n${article.summary || ""}\n${article.article || ""}`;
}

function issueLabel(issue = {}) {
  return AIDetector.TYPE_LABELS?.[issue.type] || issue.type || "AI writing pattern";
}

function issueSeverity(issue = {}) {
  return issue.severity || "low";
}

function summarizeTopIssues(issues = [], limit = DEFAULT_TOP_ISSUES) {
  const grouped = new Map();
  for (const issue of Array.isArray(issues) ? issues : []) {
    const type = issue.type || "unknown";
    const current = grouped.get(type) || {
      type,
      label: issueLabel(issue),
      severity: issueSeverity(issue),
      severityLabel: AIDetector.SEVERITY_LABELS?.[issueSeverity(issue)] || "",
      count: 0,
      samples: [],
    };
    current.count += 1;
    if ((SEVERITY_RANK[issueSeverity(issue)] ?? 9) < (SEVERITY_RANK[current.severity] ?? 9)) {
      current.severity = issueSeverity(issue);
      current.severityLabel = AIDetector.SEVERITY_LABELS?.[current.severity] || "";
    }
    const sample = compactText(issue.text, 80);
    if (sample && current.samples.length < 3 && !current.samples.includes(sample)) current.samples.push(sample);
    grouped.set(type, current);
  }
  return [...grouped.values()]
    .sort((left, right) => {
      const severity = (SEVERITY_RANK[left.severity] ?? 9) - (SEVERITY_RANK[right.severity] ?? 9);
      if (severity) return severity;
      return right.count - left.count;
    })
    .slice(0, Math.max(1, limit));
}

export function analyzeMarketingArticleStyle(article = {}, thresholdOverrides = {}) {
  const thresholds = aiWritingStyleThresholds(thresholdOverrides);
  if (aiWritingStyleDisabled()) {
    return {
      enabled: false,
      status: "disabled",
      aiWritingScore: 0,
      aiWritingScoreMax: thresholds.aiWritingScoreMax,
      label: "disabled",
      classification: "",
      confidence: "",
      issueCount: 0,
      topIssues: [],
      warning: "",
    };
  }

  try {
    const result = AIDetector.analyzeText(articleText(article), { contextMode: "marketing" }) || {};
    const score = clampScore(result.score);
    const topIssues = summarizeTopIssues(result.issues, thresholds.aiWritingTopIssues);
    return {
      enabled: true,
      status: score > thresholds.aiWritingScoreMax ? "needs_rewrite" : "ok",
      aiWritingScore: score,
      aiWritingScoreMax: thresholds.aiWritingScoreMax,
      label: result.label || "",
      classification: result.document_classification || result.classification || "",
      confidence: result.confidence_category || result.confidence || "",
      issueCount: Array.isArray(result.issues) ? result.issues.length : 0,
      topIssues,
      warning: "",
    };
  } catch (error) {
    return {
      enabled: true,
      status: "warning",
      aiWritingScore: 0,
      aiWritingScoreMax: thresholds.aiWritingScoreMax,
      label: "detector failed",
      classification: "",
      confidence: "",
      issueCount: 0,
      topIssues: [],
      warning: `ai_writing_detector_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
