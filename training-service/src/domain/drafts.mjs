import { getKnowledgeBaseQuality } from "../quality.mjs";
import { makeId } from "../store.mjs";
import { parseDeadline, parseNumberBefore, parsePassScore, parseRequestedAudience } from "./common.mjs";
import { searchEmployees } from "./employees.mjs";
import { matchKnowledgeBase } from "./knowledge.mjs";

function isGroupAudience(name) {
  return /(全部|所有|全员|全体|员工|人员|大家|部门|部|组|团队|新人|销售|售后|客服|生产|技术|管理)/.test(String(name || ""));
}

function exactEmployeeMatch(state, name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return null;
  return state.employees.find((employee) => {
    if (employee.status !== "active") return false;
    return [employee.name, ...(employee.aliases || [])]
      .map((value) => String(value || "").trim().toLowerCase())
      .includes(normalized);
  }) || null;
}

function draftEmployee(employee) {
  return {
    id: employee.id || null,
    name: employee.name,
    department: employee.department || "自定义",
    role: employee.role || "学习人",
    ...(employee.temporary ? { temporary: true, custom: true } : {}),
  };
}

function customEmployee(name) {
  return draftEmployee({
    id: null,
    name,
    department: "自定义",
    role: "学习人",
    temporary: true,
  });
}

function resolveDraftEmployees(state, text, requestedAudience) {
  if (!requestedAudience.length || requestedAudience.some(isGroupAudience)) {
    return searchEmployees(state, text).map(draftEmployee);
  }
  return requestedAudience.map((name) => {
    const matched = exactEmployeeMatch(state, name);
    return matched ? draftEmployee(matched) : customEmployee(name);
  });
}

export function createTaskDraft(state, instruction, options = {}) {
  const text = String(instruction || "").trim();
  const memoryDefaults = options.memoryDefaults || {};
  const knowledgeBase = matchKnowledgeBase(state, text);
  const requestedAudience = parseRequestedAudience(text);
  const employees = resolveDraftEmployees(state, text, requestedAudience);
  const hasCustomEmployees = employees.some((employee) => employee.temporary === true);
  const quizCount = parseNumberBefore(text, ["选择题", "判断题", "题"], Number(memoryDefaults.quizCount) || 10);
  const passScore = parsePassScore(text, Number(memoryDefaults.passScore) || 80);
  const deadline = parseDeadline(text);
  const titleBase = knowledgeBase ? knowledgeBase.name.replace(/资料库$/, "") : "培训任务";
  const title = knowledgeBase ? (titleBase.endsWith("培训") ? titleBase : `${titleBase}培训`) : titleBase;
  const quality = knowledgeBase ? getKnowledgeBaseQuality(state, knowledgeBase.id) : null;

  return {
    id: makeId("draft"),
    instruction: text,
    title,
    knowledgeBase: knowledgeBase
      ? {
          id: knowledgeBase.id,
          name: knowledgeBase.name,
          description: knowledgeBase.description,
          quality,
        }
      : null,
    employees: employees.map((employee) => ({
      id: employee.id,
      name: employee.name,
      department: employee.department,
      role: employee.role,
      ...(employee.temporary ? { temporary: true, custom: true } : {}),
    })),
    unmatchedEmployees: [],
    deadline,
    quizCount,
    passScore,
    quizType: text.includes("判断") ? "true_false" : "single_choice",
    requiresConfirmation: true,
    confirmationText: `请确认培训任务：${title}，对象 ${employees.length} 人，题目 ${quizCount} 道，通过分数 ${passScore} 分。`,
    warnings: [
      ...(!knowledgeBase ? ["未明确匹配到知识库，将无法发布。"] : []),
      ...(quality?.warnings?.length ? quality.warnings.slice(0, 3) : []),
      ...(employees.length === 0 ? ["请指定学习对象，可以直接输入姓名或分组。"] : []),
      ...(hasCustomEmployees ? ["已按输入创建自定义学习对象，确认后会生成专属学习链接。"] : []),
    ],
  };
}
