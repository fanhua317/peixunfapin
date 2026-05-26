const DEFAULT_SHORT_TEXT_CHARS = Number(process.env.TRAINING_SHORT_CHUNK_CHARS || 80);

const OCR_PLACEHOLDER_RE = /(OCR|扫描件|图片型\s*PDF|未抽取|无法抽取|未能.*PDF.*文本|no\s+text\s+extracted)/i;
const LOW_VALUE_RE = /^(?:来源文件|页数|页码|第\s*\d+\s*页|目录|contents|封面|结束|谢谢|感谢)[\s#\-:：，。、]*$/i;
const COMPANY_BOILERPLATE_RE = /(?:FUJIAN\s+NEW\s+YINJIA\s+PUMP\s+CO\.?,?\s*LTD\.?|A\s+TRUSTED\s+BRAND|YOUR\s+RELIABLE\s+PARTNER|YINJIA|银嘉)/gi;
const TRAINING_SIGNAL_RE = /(电机|三相|异步|定子|转子|绕组|铁芯|铸铝|导条|端环|铁损|断条|功率|电压|电流|频率|效率|能效|机座|级数|型号|YE\d|Y2|IE\d|客户|销售|售后|工艺|质量|品质|检测|参数|范围|标准|负载|专利|ZL\d+|motor|rotor|stator|power|efficiency|frame|pole)/i;

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

export function normalizeInformativeText(value) {
  return normalizeTrainingText(value)
    .replace(COMPANY_BOILERPLATE_RE, " ")
    .replace(/^[\s\d]+(?=\d+(?:\.\d+)+\s*[\u3400-\u9fffA-Za-z])/g, "")
    .replace(/^[\s\d]+(?=[\u3400-\u9fffA-Za-z]{3,})/g, "")
    .replace(/[●◆■□▪]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isOcrPlaceholderChunk(chunk) {
  return OCR_PLACEHOLDER_RE.test(String(chunk?.content || ""));
}

export function isEmptyChunk(chunk) {
  return normalizeInformativeText(chunk?.content).length === 0;
}

export function isLowValueTrainingChunk(chunk) {
  if (isOcrPlaceholderChunk(chunk)) return false;
  const text = normalizeInformativeText(chunk?.content || chunk?.searchText);
  if (!text) return true;
  if (LOW_VALUE_RE.test(text)) return true;
  if (!TRAINING_SIGNAL_RE.test(text) && text.length < 36 && !/[。！？；;,.，：:]/.test(text)) return true;
  return false;
}

export function isShortTextChunk(chunk, threshold = DEFAULT_SHORT_TEXT_CHARS) {
  if (chunk?.parentId && ["table_row", "model_spec"].includes(String(chunk?.childType || ""))) return false;
  const text = normalizeInformativeText(chunk?.content);
  return text.length > 0 && text.length < threshold && !isLowValueTrainingChunk(chunk) && !isOcrPlaceholderChunk(chunk);
}

export function hasMissingSource(chunk) {
  return !String(chunk?.sourceRef || "").trim();
}

export function isUsableTrainingChunk(chunk) {
  const text = normalizeInformativeText(chunk?.content || chunk?.searchText);
  if (!text || text.length < 12) return false;
  if (isOcrPlaceholderChunk(chunk)) return false;
  if (isLowValueTrainingChunk(chunk)) return false;
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
  const text = normalizeInformativeText(chunk?.content);
  return [...new Set((text.match(/[^。！？；;.!?]+[。！？；;.!?]?/g) || [])
    .map((sentence) => cleanQuestionText(sentence, 90))
    .filter((sentence) => sentence.length >= 8 && !LOW_VALUE_RE.test(sentence)))]
    .slice(0, limit);
}

export function getKnowledgeBaseQuality(state, knowledgeBaseId, vectorIndex = {}) {
  const knowledgeBase = state.knowledgeBases.find((kb) => kb.id === knowledgeBaseId) || null;
  const documents = state.documents.filter((document) => document.knowledgeBaseId === knowledgeBaseId);
  const chunks = state.chunks.filter((chunk) => chunk.knowledgeBaseId === knowledgeBaseId);
  const parents = (state.chunkParents || []).filter((parent) => parent.knowledgeBaseId === knowledgeBaseId);
  const ocrPlaceholderChunks = chunks.filter(isOcrPlaceholderChunk);
  const emptyChunks = chunks.filter(isEmptyChunk);
  const lowValueChunks = chunks.filter(isLowValueTrainingChunk);
  const shortTextChunks = chunks.filter((chunk) => isShortTextChunk(chunk));
  const missingSourceChunks = chunks.filter(hasMissingSource);
  const usableChunks = chunks.filter(isUsableTrainingChunk);
  const parentIds = new Set(parents.map((parent) => String(parent.id)));
  const orphanChildChunks = chunks.filter((chunk) => chunk.parentId && !parentIds.has(String(chunk.parentId)));
  const tableRowParents = parents.filter((parent) => parent.parentType === "table_row");
  const longestChildChars = chunks.reduce((max, chunk) => Math.max(max, String(chunk.content || "").length), 0);
  const vectorStatus = vectorIndex.status || "unknown";
  const indexedChunks = Number.isFinite(vectorIndex.indexedChunks) ? vectorIndex.indexedChunks : null;
  const missingVectorChunks = Number.isFinite(vectorIndex.missingVectorChunks) ? vectorIndex.missingVectorChunks : null;
  const warnings = [];

  if (!knowledgeBase) warnings.push("知识库不存在。");
  if (!documents.length) warnings.push("知识库没有文档。");
  if (!chunks.length) warnings.push("知识库没有可检索片段。");
  if (!parents.length) warnings.push("知识库尚未生成 parent-child 语义父块。");
  if (orphanChildChunks.length) warnings.push(`${orphanChildChunks.length} 个子片段找不到对应父块。`);
  if (longestChildChars > 1200) warnings.push(`最长子片段 ${longestChildChars} 字符，建议重新按业务语义切片。`);
  if (ocrPlaceholderChunks.length) warnings.push(`${ocrPlaceholderChunks.length} 个片段是图片型 PDF/OCR 占位，需要补充识别文本。`);
  if (shortTextChunks.length) warnings.push(`${shortTextChunks.length} 个片段文本过短，可能影响学习内容和出题质量。`);
  if (lowValueChunks.length) warnings.push(`${lowValueChunks.length} 个片段偏向页眉、目录或标题，已从答疑和出题候选中排除。`);
  if (missingSourceChunks.length) warnings.push(`${missingSourceChunks.length} 个片段缺少来源引用。`);
  if (usableChunks.length < Math.min(5, chunks.length || 5)) warnings.push("可用于答疑和出题的有效片段偏少。");
  if (vectorStatus === "unavailable") warnings.push("Qdrant 或本地向量索引不可用，当前会使用关键词检索。");
  if (vectorStatus === "missing_collection") warnings.push("Qdrant collection 尚未建立，当前会使用关键词检索。");
  if (missingVectorChunks && missingVectorChunks > 0) warnings.push(`${missingVectorChunks} 个有效片段尚未写入向量索引。`);

  const qualityScore = Math.max(0, Math.min(100, Math.round(
    (chunks.length ? (usableChunks.length / chunks.length) * 55 : 0)
      + (parents.length ? 15 : 0)
      + (orphanChildChunks.length ? 0 : 5)
      + (missingSourceChunks.length ? 0 : 10)
      + (ocrPlaceholderChunks.length ? 0 : 5)
      + (vectorStatus === "ready" ? 10 : 0),
  )));

  return {
    knowledgeBase: knowledgeBase ? { id: knowledgeBase.id, name: knowledgeBase.name } : null,
    documents: documents.length,
    chunkParents: parents.length,
    chunks: chunks.length,
    usableChunks: usableChunks.length,
    orphanChildChunks: orphanChildChunks.length,
    tableRowParents: tableRowParents.length,
    longestChildChars,
    ocrPlaceholderChunks: ocrPlaceholderChunks.length,
    shortTextChunks: shortTextChunks.length,
    lowValueChunks: lowValueChunks.length,
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
      lowValue: lowValueChunks.slice(0, 5).map((chunk) => chunk.sourceRef || chunk.id),
      missingSource: missingSourceChunks.slice(0, 5).map((chunk) => chunk.id),
      orphanChildren: orphanChildChunks.slice(0, 5).map((chunk) => chunk.id),
    },
  };
}
