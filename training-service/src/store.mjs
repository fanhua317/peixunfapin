import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(__dirname, "..");

export const dataDir = process.env.TRAINING_DATA_DIR
  ? path.resolve(process.env.TRAINING_DATA_DIR)
  : "D:\\OpenClawData\\training-index";

const statePath = path.join(dataDir, "state.json");

const nowIso = () => new Date().toISOString();

const defaultState = () => ({
  meta: {
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
  knowledgeBases: [
    {
      id: "kb-a-product",
      name: "A 产品基础资料库",
      aliases: ["A产品", "A 产品", "A 产品培训", "A 产品基础培训"],
      description: "用于演示的 A 产品基础培训资料库。",
      version: "demo-1",
      status: "ready",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  ],
  documents: [
    {
      id: "doc-a-product-guide",
      knowledgeBaseId: "kb-a-product",
      title: "A 产品基础说明",
      sourcePath: "demo/a-product-guide.md",
      sourceType: "markdown",
      status: "ready",
    },
  ],
  chunks: [
    {
      id: "chunk-a-product-1",
      knowledgeBaseId: "kb-a-product",
      documentId: "doc-a-product-guide",
      content: "A 产品面向销售场景，核心优势包括部署快、学习成本低、售后响应稳定。销售介绍时应优先强调客户痛点、产品差异点和售后服务承诺。",
      sourceRef: "A 产品基础说明 / 核心优势",
      metadata: { section: "核心优势" },
    },
    {
      id: "chunk-a-product-2",
      knowledgeBaseId: "kb-a-product",
      documentId: "doc-a-product-guide",
      content: "A 产品标准培训建议包含产品定位、主要功能、常见问题、销售话术和售后政策。员工完成学习后应能回答客户关于价格、交付周期和售后范围的问题。",
      sourceRef: "A 产品基础说明 / 培训范围",
      metadata: { section: "培训范围" },
    },
    {
      id: "chunk-a-product-3",
      knowledgeBaseId: "kb-a-product",
      documentId: "doc-a-product-guide",
      content: "考试建议以选择题和判断题为主，重点覆盖产品优势、适用客户、销售注意事项和售后流程。通过分数建议为 80 分。",
      sourceRef: "A 产品基础说明 / 考试建议",
      metadata: { section: "考试建议" },
    },
  ],
  chunkParents: [],
  employees: [
    {
      id: "emp-wang-xiaoming",
      name: "王小明",
      aliases: ["小明"],
      department: "销售部",
      role: "销售新人",
      status: "active",
    },
    {
      id: "emp-li-xiaohong",
      name: "李小红",
      aliases: ["小红"],
      department: "销售部",
      role: "销售新人",
      status: "active",
    },
    {
      id: "emp-zhang-san",
      name: "张三",
      aliases: [],
      department: "售后部",
      role: "售后专员",
      status: "active",
    },
    {
      id: "emp-zoey",
      name: "zoey",
      aliases: ["Zoey"],
      department: "未分组",
      role: "员工",
      status: "active",
    },
  ],
  tasks: [],
  invites: [],
  quizzes: [],
  attempts: [],
  contentDrafts: [],
  events: [],
});

export async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

export async function loadState() {
  await ensureDataDir();
  try {
    const raw = await readFile(statePath, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
    const state = defaultState();
    await saveState(state);
    return state;
  }
}

function normalizeState(state) {
  const value = state && typeof state === "object" ? state : defaultState();
  value.knowledgeBases = Array.isArray(value.knowledgeBases) ? value.knowledgeBases : [];
  value.documents = Array.isArray(value.documents) ? value.documents : [];
  value.chunks = Array.isArray(value.chunks) ? value.chunks : [];
  value.chunkParents = Array.isArray(value.chunkParents) ? value.chunkParents : [];
  value.employees = Array.isArray(value.employees) ? value.employees : [];
  value.tasks = Array.isArray(value.tasks) ? value.tasks : [];
  value.invites = Array.isArray(value.invites) ? value.invites : [];
  value.quizzes = Array.isArray(value.quizzes) ? value.quizzes : [];
  value.attempts = Array.isArray(value.attempts) ? value.attempts : [];
  value.contentDrafts = Array.isArray(value.contentDrafts) ? value.contentDrafts : [];
  value.events = Array.isArray(value.events) ? value.events : [];
  return value;
}

export async function saveState(state) {
  await ensureDataDir();
  state.meta = {
    ...(state.meta || {}),
    version: 1,
    updatedAt: nowIso(),
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function mutateState(mutator) {
  const state = await loadState();
  const result = await mutator(state);
  await saveState(state);
  return result;
}

export function appendEvent(state, type, payload = {}) {
  state.events.push({
    id: makeId("evt"),
    type,
    payload,
    createdAt: nowIso(),
  });
}

export function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function isoNow() {
  return nowIso();
}
