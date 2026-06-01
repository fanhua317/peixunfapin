import { escapeHtml } from "./ui.js";

function isListLine(line) {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, "<strong>$1</strong>");
}

function renderList(lines, ordered) {
  const tag = ordered ? "ol" : "ul";
  const marker = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
  const items = lines
    .map((line) => line.replace(marker, "").trim())
    .filter(Boolean)
    .map((line) => `<li>${renderInlineMarkdown(line)}</li>`)
    .join("");
  return items ? `<${tag}>${items}</${tag}>` : "";
}

function renderParagraph(lines) {
  const html = lines
    .map((line) => renderInlineMarkdown(line.trim()))
    .filter(Boolean)
    .join("<br />");
  return html ? `<p>${html}</p>` : "";
}

export function renderMarkdown(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return "";

  const lines = text.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(4, Math.max(3, heading[1].length + 2));
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const list = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        list.push(lines[index]);
        index += 1;
      }
      blocks.push(renderList(list, true));
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const list = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        list.push(lines[index]);
        index += 1;
      }
      blocks.push(renderList(list, false));
      continue;
    }

    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```/.test(lines[index].trim()) &&
      !/^#{1,4}\s+/.test(lines[index].trim()) &&
      !isListLine(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(renderParagraph(paragraph));
  }

  return blocks.filter(Boolean).join("");
}
