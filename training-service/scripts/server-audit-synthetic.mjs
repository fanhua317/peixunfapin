import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  asNumber,
  defaultAuditOutDir,
  ensureDir,
  parseArgs,
  timestampForFile,
  writeJsonArtifact,
} from "./server-audit/common.mjs";

const args = parseArgs();
const outDir = args.out || path.join(defaultAuditOutDir, "synthetic-corpus");
const small = asNumber(args.small, 100);
const medium = asNumber(args.medium, 1000);
const large = asNumber(args.large, 5000);
const sizes = [
  { name: "small", count: small },
  { name: "medium", count: medium },
  { name: "large", count: large },
];

function modelName(index) {
  const series = ["YE3", "MS", "YBX3", "VM", "QB", "WZB", "CPM", "SCM"][index % 8];
  return `${series}${100 + index}`;
}

function markdownDoc(index) {
  const model = modelName(index);
  return `# ${model} 企业培训资料

## 产品定位
${model} 适合水泵、风机、输送设备和一般工业配套场景。销售培训应说明适用工况、可靠性、能效和售后响应。

## 选型参数
- 型号：${model}
- 功率范围：${(0.37 + (index % 20) * 0.75).toFixed(2)} kW
- 防护等级：IP${index % 2 ? "44" : "55"}
- 绝缘等级：${index % 3 ? "F" : "B"}

## 培训要点
员工需要掌握铭牌识别、客户需求确认、安装方式、常见故障和保修边界。遇到资料未覆盖的参数时不得编造。
`;
}

function csvDoc(index) {
  const rows = ["model,power_kw,poles,efficiency,scenario"];
  for (let i = 0; i < 12; i += 1) {
    rows.push(`${modelName(index * 12 + i)},${(0.55 + i * 0.75).toFixed(2)},${[2, 4, 6][i % 3]},IE${2 + (i % 3)},${["water pump", "fan", "conveyor"][i % 3]}`);
  }
  return `${rows.join("\n")}\n`;
}

function longDoc(index) {
  const model = modelName(index);
  const paragraph = `${model} 的业务培训材料强调资料来源、型号边界、客户场景和售后流程。系统应在 RAG 检索命中后展开 parent context，避免只给模型半句参数。`;
  return `# ${model} 长文本压力样本\n\n${Array.from({ length: 80 }, () => paragraph).join("\n\n")}\n`;
}

async function writeCorpus(size) {
  const root = path.join(outDir, `${size.name}-${size.count}-${timestampForFile()}`);
  await mkdir(root, { recursive: true });
  const manifest = {
    name: size.name,
    count: size.count,
    root,
    createdAt: new Date().toISOString(),
    files: [],
  };
  for (let index = 0; index < size.count; index += 1) {
    const type = index % 3;
    const ext = type === 1 ? ".csv" : ".md";
    const fileName = `${String(index + 1).padStart(5, "0")}-${modelName(index)}${ext}`;
    const filePath = path.join(root, fileName);
    const content = type === 0 ? markdownDoc(index) : type === 1 ? csvDoc(index) : longDoc(index);
    await writeFile(filePath, content, "utf8");
    manifest.files.push({ path: filePath, bytes: Buffer.byteLength(content), type: type === 1 ? "csv" : type === 2 ? "long-md" : "md" });
  }
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

await ensureDir(outDir);
const corpora = [];
for (const size of sizes) {
  if (size.count <= 0) continue;
  corpora.push(await writeCorpus(size));
  console.log(`${size.name}: generated ${size.count} files`);
}

const result = {
  kind: "juzhou-server-audit-synthetic-corpus",
  createdAt: new Date().toISOString(),
  outDir,
  corpora: corpora.map((corpus) => ({
    name: corpus.name,
    count: corpus.count,
    root: corpus.root,
    bytes: corpus.files.reduce((sum, file) => sum + file.bytes, 0),
    byType: corpus.files.reduce((acc, file) => {
      acc[file.type] = (acc[file.type] || 0) + 1;
      return acc;
    }, {}),
  })),
};

const artifactPath = await writeJsonArtifact(defaultAuditOutDir, "synthetic", result);
console.log(JSON.stringify({ ok: true, path: artifactPath, result }, null, 2));
