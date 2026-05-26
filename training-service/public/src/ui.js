export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderStageProgress({ label, detail = "", progress = 18, active = true } = {}) {
  const value = Math.max(6, Math.min(100, Number(progress) || 18));
  return `<div class="stage-progress ${active ? "active" : ""}" role="status" aria-live="polite">
    <div class="stage-progress-head">
      <strong>${escapeHtml(label || "正在处理")}</strong>
      ${detail ? `<span>${escapeHtml(detail)}</span>` : ""}
    </div>
    <div class="stage-progress-bar"><span style="width:${value}%"></span></div>
  </div>`;
}

export function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

export function cleanLearningText(value, maxLength = 220) {
  const text = String(value || "")
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
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function isUsefulLearningText(value) {
  const text = cleanLearningText(value, 500);
  return text.length >= 8 && !/(来源文件|页数|页码|未能从|OCR|抽取|复制文本|导入|扫描件)/i.test(text);
}

export function splitLearningText(value, limit = 4) {
  return [...new Set((cleanLearningText(value, 1200).match(/[^。！？；;.!?]+[。！？；;.!?]?/g) || [])
    .map((part) => cleanLearningText(part, 130))
    .filter(isUsefulLearningText))]
    .slice(0, limit);
}

export function cleanLearningList(values, limit = 8) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  return [...new Set(list
    .flatMap((value) => splitLearningText(value, 2))
    .filter(isUsefulLearningText))]
    .slice(0, limit);
}

export function inferLearningHeading(heading, points, index) {
  const current = cleanLearningText(heading, 80);
  if (current && !/^学习模块\s*\d+$/i.test(current)) return current;
  const text = points.join(" ");
  if (/定子|转子|绕组|铁芯|铸铝/.test(text)) return "电机结构与核心部件";
  if (/功率|电压|电流|转速|效率|功率因数|防护|绝缘|参数|铭牌/.test(text)) return "关键参数与铭牌识读";
  if (/启动|变频|运行|转差|转矩|调速|温升/.test(text)) return "运行特性与使用条件";
  if (/选型|客户|销售|拒绝|话术|沟通|应用/.test(text)) return "客户沟通与销售应用";
  if (/维护|检查|故障|安全|安装|保养/.test(text)) return "安装维护与安全要点";
  return `学习模块 ${index + 1}`;
}

export function renderStudyGuide(value) {
  const lines = String(value || "")
    .split(/\n+/)
    .flatMap((line) => splitLearningText(line, 3))
    .filter(isUsefulLearningText)
    .slice(0, 6);
  return lines.length ? `<div class="study-guide">${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>` : "";
}

export function cleanAnswerDisplayText(value) {
  return String(value || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderAnswerContent(result) {
  const keyPointList = Array.isArray(result.keyPoints) ? result.keyPoints : result.keyPoints ? [result.keyPoints] : [];
  const caveatList = Array.isArray(result.caveats) ? result.caveats : result.caveats ? [result.caveats] : [];
  const keyPoints = keyPointList.map((point) => `<li>${escapeHtml(cleanLearningText(point, 180))}</li>`).join("");
  const caveats = caveatList.map((item) => `<li>${escapeHtml(cleanLearningText(item, 180))}</li>`).join("");
  const badge = result.generatedBy
    ? `<span class="badge success">${escapeHtml(result.generatedBy)}${result.thinking ? ` / ${escapeHtml(result.thinking)}` : ""}${result.model ? ` / ${escapeHtml(result.model)}` : ""}</span>`
    : "";
  return `<div class="answer-main">
    <div class="task-head">
      <strong>资料回答</strong>
      ${badge}
    </div>
    <p>${escapeHtml(cleanAnswerDisplayText(result.answer || "未找到答案。")).replaceAll("\n", "<br />")}</p>
    ${keyPoints ? `<div class="task-section-title">关键要点</div><ul class="compact-list">${keyPoints}</ul>` : ""}
    ${caveats ? `<div class="task-section-title">注意事项</div><ul class="compact-list">${caveats}</ul>` : ""}
  </div>`;
}

export function renderQualitySummary(quality) {
  if (!quality) return "";
  const warningItems = (quality.warnings || []).slice(0, 4).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const vectorStatus = quality.vectorIndex?.status || "";
  const mode = vectorStatus === "ready"
    ? "混合检索可用"
    : ["partial", "empty"].includes(vectorStatus)
      ? "混合检索待完善"
      : ["unavailable", "missing_collection"].includes(vectorStatus)
        ? "关键词检索模式"
        : "资料质量检查";
  const lowValueMetric = Number(quality.lowValueChunks || 0) > 0
    ? `<span>低价值 ${escapeHtml(quality.lowValueChunks)}</span>`
    : "";
  return `<div class="quality-box ${quality.warnings?.length ? "warn" : "ok"}">
    <div class="quality-head">
      <strong>资料质量 ${escapeHtml(quality.qualityScore ?? "-")} 分</strong>
      <span>${escapeHtml(mode)}</span>
    </div>
    <div class="quality-metrics">
      <span>文档 ${escapeHtml(quality.documents)}</span>
      <span>有效片段 ${escapeHtml(quality.usableChunks)}/${escapeHtml(quality.chunks)}</span>
      <span>OCR 占位 ${escapeHtml(quality.ocrPlaceholderChunks)}</span>
      <span>短文本 ${escapeHtml(quality.shortTextChunks)}</span>
      ${lowValueMetric}
    </div>
    ${warningItems ? `<ul class="compact-list">${warningItems}</ul>` : `<p class="muted">资料状态良好，可以用于学习和出题。</p>`}
  </div>`;
}
