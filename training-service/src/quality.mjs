const DEFAULT_SHORT_TEXT_CHARS = Number(process.env.TRAINING_SHORT_CHUNK_CHARS || 80);

const OCR_PLACEHOLDER_RE = /(未能从.*(?:PDF|文件).*抽取|OCR|扫描件|复制文本|未抽取到|无法抽取)/i;
const LOW_VALUE_RE = /^(?:来源文件|页数|页码|第\s*\d+\s*页|[\s#\-:：，。、.])+$/i;

export function normalizeTrainingText(value) {
  return String(value || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[#*_`>]/g, "")
    .replace(/来源文件[:：]\s*[^\s。；;\n]+/g, "")
    .replace(/页数[:：]\s*\d+/g, "")
    .replace(/页码[:：]\s*\d+/g, "")
    .replace(/第\s*\d+\s*页/g, "")
    .replace(/\bhttps?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isOcrPlaceholderChunk(chunk) {
  return OCR_PLACEHOLDER_RE.test(String(chunk?.content || ""));
}

export function isEmptyChunk(chunk) {
  return normalizeTrainingText(chunk?.content).length === 0;
}

export function isShortTextChunk(chunk, threshold = DEFAULT_SHORT_TEXT_CHARS) {
  const text = normalizeTrainingText(chunk?.content);
  return text.length > 0 && text.length < threshold;
}

export function hasMissingSource(chunk) {
  return !String(chunk?.sourceRef || "").trim();
}

export function isUsableTrainingChunk(chunk) {
  const text = normalizeTrainingText(chunk?.content);
  if (!text || text.length < 12) return false;
  if (isOcrPlaceholderChunk(chunk)) return false;
  if (LOW_VALUE_RE.test(text)) return false;
  return true;
}

export function cleanQuestionText(value, maxLength = 72) {
  const text = normalizeTrainingText(value)
    .replace(/^[-•\d.\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function chunkToLearningPoints(chunk, limit = 4) {
  const text = normalizeTrainingText(chunk?.content);
  return [...new Set((text.match(/[^。！？；;.!?]+[。！？；;.!?]?/g) || [])
    .map((sentence) => cleanQuestionText(sentence, 90))
    .filter((sentence) => sentence.length >= 8 && !LOW_VALUE_RE.test(sentence)))]
    .slice(0, limit);
}

export function getKnowledgeBaseQuality(state, knowledgeBaseId, vectorIndex = {}) {
  const knowledgeBase = state.knowledgeBases.find((kb) => kb.id === knowledgeBaseId) || null;
  const documents = state.documents.filter((document) => document.knowledgeBaseId === knowledgeBaseId);
  const chunks = state.chunks.filter((chunk) => chunk.knowledgeBaseId === knowledgeBaseId);
  const ocrPlaceholderChunks = chunks.filter(isOcrPlaceholderChunk);
  const emptyChunks = chunks.filter(isEmptyChunk);
  const shortTextChunks = chunks.filter((chunk) => isShortTextChunk(chunk));
  const missingSourceChunks = chunks.filter(hasMissingSource);
  const usableChunks = chunks.filter(isUsableTrainingChunk);
  const vectorStatus = vectorIndex.status || "unknown";
  const indexedChunks = Number.isFinite(vectorIndex.indexedChunks) ? vectorIndex.indexedChunks : null;
  const missingVectorChunks = Number.isFinite(vectorIndex.missingVectorChunks) ? vectorIndex.missingVectorChunks : null;
  const warnings = [];

  if (!knowledgeBase) warnings.push("知识库不存在。");
  if (!documents.length) warnings.push("知识库没有文档。");
  if (!chunks.length) warnings.push("知识库没有可检索片段。");
  if (ocrPlaceholderChunks.length) warnings.push(`${ocrPlaceholderChunks.length} 个片段是图片型 PDF/OCR 占位，需要补充识别文本。`);
  if (shortTextChunks.length) warnings.push(`${shortTextChunks.length} 个片段文本过短，可能影响学习内容和出题质量。`);
  if (missingSourceChunks.length) warnings.push(`${missingSourceChunks.length} 个片段缺少来源引用。`);
  if (usableChunks.length < Math.min(5, chunks.length || 5)) warnings.push("可用于答疑和出题的有效片段偏少。");
  if (vectorStatus === "unavailable") warnings.push("Qdrant 或 Ollama 不在线，当前会使用关键词检索。");
  if (vectorStatus === "missing_collection") warnings.push("Qdrant collection 尚未建立，当前会使用关键词检索。");
  if (missingVectorChunks && missingVectorChunks > 0) warnings.push(`${missingVectorChunks} 个有效片段尚未写入向量索引。`);

  const qualityScore = Math.max(0, Math.min(100, Math.round(
    (chunks.length ? (usableChunks.length / chunks.length) * 70 : 0)
      + (missingSourceChunks.length ? 0 : 10)
      + (ocrPlaceholderChunks.length ? 0 : 10)
      + (vectorStatus === "ready" ? 10 : 0),
  )));

  return {
    knowledgeBase: knowledgeBase ? { id: knowledgeBase.id, name: knowledgeBase.name } : null,
    documents: documents.length,
    chunks: chunks.length,
    usableChunks: usableChunks.length,
    ocrPlaceholderChunks: ocrPlaceholderChunks.length,
    shortTextChunks: shortTextChunks.length,
    emptyChunks: emptyChunks.length,
    missingSourceChunks: missingSourceChunks.length,
    vectorIndex: {
      status: vectorStatus,
      collection: vectorIndex.collection || process.env.QDRANT_COLLECTION || "training_chunks_bge_m3",
      indexedChunks,
      missingVectorChunks,
      checkedAt: vectorIndex.checkedAt || null,
      message: vectorIndex.message || "",
    },
    qualityScore,
    warnings,
    examples: {
      ocrPlaceholders: ocrPlaceholderChunks.slice(0, 5).map((chunk) => chunk.sourceRef || chunk.id),
      shortText: shortTextChunks.slice(0, 5).map((chunk) => chunk.sourceRef || chunk.id),
      missingSource: missingSourceChunks.slice(0, 5).map((chunk) => chunk.id),
    },
  };
}
