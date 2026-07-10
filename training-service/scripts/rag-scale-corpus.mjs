import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function pad(value, width = 5) {
  return String(value).padStart(width, "0");
}

function modelFor(index) {
  const series = ["YE3", "YE4", "MS", "YBX3", "VM", "QB", "WZB", "CPM", "SCM", "CM"];
  return `${series[index % series.length]}-${pad(index + 100, 5)}`;
}

function factsFor(index) {
  return {
    model: modelFor(index),
    powerKw: Number((0.37 + (index % 40) * 0.55).toFixed(2)),
    poles: [2, 4, 6, 8][index % 4],
    efficiency: `IE${2 + (index % 4)}`,
    protection: index % 2 ? "IP55" : "IP44",
    scenario: ["water pump", "industrial fan", "conveyor", "irrigation booster"][index % 4],
    evidenceCode: `JZ-EVIDENCE-${pad(index + 1, 6)}`,
  };
}

function parameterDocument(index) {
  const facts = factsFor(index);
  return `# ${facts.model} 企业培训参数卡

## 唯一证据
- 证据编号：${facts.evidenceCode}
- 型号：${facts.model}
- 额定功率：${facts.powerKw} kW
- 极数：${facts.poles}
- 能效等级：${facts.efficiency}
- 防护等级：${facts.protection}
- 典型场景：${facts.scenario}

## 培训边界
员工回答时必须核对型号和证据编号。资料未覆盖的电压、价格、认证和客户案例不得编造。
`;
}

function tableDocument(index) {
  const facts = factsFor(index);
  const rows = Array.from({ length: 10 }, (_, offset) => {
    const item = factsFor(index * 10 + offset);
    return `| ${item.model} | ${item.powerKw} | ${item.poles} | ${item.efficiency} | ${item.protection} | ${item.evidenceCode} |`;
  });
  return `# ${facts.model} 系列选型表

本表的主记录是 ${facts.model}，主记录证据编号为 ${facts.evidenceCode}，用于训练型号、功率、极数和能效的精确检索。

| 型号 | 功率 kW | 极数 | 能效 | 防护 | 证据编号 |
| --- | ---: | ---: | --- | --- | --- |
${rows.join("\n")}

选型必须以表格中的型号与证据编号为准，不能把相邻型号的参数互相替代。
`;
}

function semanticDocument(index) {
  const facts = factsFor(index);
  const paragraph = `${facts.model} 用于 ${facts.scenario} 场景，培训重点是先确认工况，再核对 ${facts.powerKw} kW、${facts.poles} 极、${facts.efficiency} 和 ${facts.protection}。唯一证据编号 ${facts.evidenceCode} 用于避免相似型号混淆。`;
  return `# ${facts.model} 场景化培训材料

## 客户需求确认
${paragraph}

## 安装与维护
${Array.from({ length: 18 }, (_, offset) => `${offset + 1}. ${paragraph} 第 ${offset + 1} 个检查点要求记录资料来源，不得根据经验补写不存在的参数。`).join("\n\n")}

## 拒答原则
如果问题中的型号或证据编号不在当前资料中，应明确说明资料不足。
`;
}

export function scaleDocument(index) {
  if (index % 3 === 0) return parameterDocument(index);
  if (index % 3 === 1) return tableDocument(index);
  return semanticDocument(index);
}

export async function generateScaleCorpus(rootDir, count) {
  const safeCount = Math.max(1, Number(count) || 1);
  await mkdir(rootDir, { recursive: true });
  const manifest = [];
  const batchSize = 100;
  for (let start = 0; start < safeCount; start += batchSize) {
    const batch = [];
    for (let index = start; index < Math.min(start + batchSize, safeCount); index += 1) {
      const facts = factsFor(index);
      const fileName = `${pad(index + 1)}-${facts.model}.md`;
      const content = scaleDocument(index);
      batch.push(writeFile(path.join(rootDir, fileName), content, "utf8"));
      manifest.push({ index, fileName, ...facts, bytes: Buffer.byteLength(content) });
    }
    await Promise.all(batch);
  }
  const payload = {
    kind: "juzhou-rag-scale-corpus",
    version: 1,
    count: safeCount,
    createdAt: new Date().toISOString(),
    files: manifest,
  };
  await writeFile(path.join(rootDir, "manifest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export function buildScaleQueries(count, queryCount = 100) {
  const safeCount = Math.max(1, Number(count) || 1);
  const safeQueryCount = Math.max(1, Number(queryCount) || 100);
  return Array.from({ length: safeQueryCount }, (_, queryIndex) => {
    const index = Math.min(safeCount - 1, Math.floor((queryIndex / safeQueryCount) * safeCount));
    const facts = factsFor(index);
    const variants = [
      `${facts.model} ${facts.evidenceCode} 的额定功率是多少？`,
      `请查 ${facts.model} 的 ${facts.poles} 极、${facts.efficiency} 和防护等级`,
      `哪份资料适合 ${facts.scenario}，并且唯一编号是 ${facts.evidenceCode}？`,
      `Find the training record for ${facts.model}, evidence ${facts.evidenceCode}`,
    ];
    return {
      id: `scale-${safeCount}-${pad(queryIndex + 1, 3)}`,
      index,
      query: variants[queryIndex % variants.length],
      expectedModel: facts.model,
      expectedEvidenceCode: facts.evidenceCode,
      expectedSource: `${pad(index + 1)}-${facts.model}.md`,
    };
  });
}

export { factsFor as scaleFactsFor };
