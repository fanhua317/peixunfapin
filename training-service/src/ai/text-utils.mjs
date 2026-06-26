export function compactText(value, maxLength = 1600) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function compactMultiline(value, maxLength = 1600) {
  const text = String(value || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

export function cleanTrainingText(value) {
  return String(value || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s*/gm, "")
    .replace(/来源文件[:：]\s*[^\s。；;\n]+/g, "")
    .replace(/页数[:：]\s*\d+/g, "")
    .replace(/页码[:：]\s*\d+/g, "")
    .replace(/第\s*\d+\s*页/g, "")
    .replace(/\bhttps?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanReadableText(value, maxLength = 260) {
  const text = cleanTrainingText(value)
    .replace(/#+\s*/g, "")
    .replace(/福建新银嘉泵业有限公司/g, "")
    .replace(/FUJIAN NEW YINJIA PUMP CO\.?,?\s*LTD\.?/gi, "")
    .replace(/来源文件[:：][^\n。；;]+/g, "")
    .replace(/页数[:：]\s*\d+/g, "")
    .replace(/页码[:：]\s*\d+/g, "")
    .replace(/第\s*\d+\s*页/g, "")
    .replace(/(?:^|\s)\d{1,3}\s+\d+(?:\.\d+)*\s+(?=[\u4e00-\u9fa5A-Za-z])/g, " ")
    .replace(/(?:^|\s)\d+(?:\.\d+)+\s+(?=[\u4e00-\u9fa5A-Za-z])/g, " ")
    .replace(/^(?:\d+\s+){1,3}(?=[\u4e00-\u9fa5A-Za-z])/g, "")
    .replace(/^[\s#\-*•·]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return compactText(text, maxLength);
}

export function isUsefulTrainingText(value) {
  const text = cleanTrainingText(value);
  return text.length >= 12 && !/(来源文件|页数|页码|未能从|OCR|抽取|复制文本|导入|扫描件)/i.test(text);
}

export function splitTrainingSentences(value, limit = 4) {
  return uniqueStrings((cleanTrainingText(value).match(/[^。！？；;.!?]+[。！？；;.!?]?/g) || [])
    .map((sentence) => compactText(sentence, 120))
    .filter(isUsefulTrainingText))
    .slice(0, limit);
}

export function looseJsonField(text, field) {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*"|\\n\\s*"|\\s*})`);
  const match = String(text || "").match(pattern);
  return match ? match[1].replace(/\\"/g, "\"").replace(/\\\\n/g, "\n").replace(/\\n/g, "\n").trim() : "";
}

export function stripCodeFence(text) {
  return String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

export function cleanAnswerText(value, maxLength = 1800) {
  return compactMultiline(String(value || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s*/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\n{3,}/g, "\n\n"), maxLength);
}

export function modelRequiredError(feature, error) {
  if (error instanceof Error && /需要可用的大模型 API/.test(error.message)) return error;
  const detail = error instanceof Error ? error.message : String(error || "");
  const required = new Error(`${feature}需要可用的大模型 API；请配置 TRAINING_LLM_API_KEY、DEEPSEEK_API_KEY 或 OPENAI_API_KEY 后重试。${detail ? ` 原因：${detail}` : ""}`);
  required.statusCode = 503;
  return required;
}
