import { summarizeToolResult } from "../tools/registry.mjs";

export function memorySummary(memoryContext = {}) {
  return {
    enabled: memoryContext.enabled === true,
    sessionId: memoryContext.sessionId || "",
    recentMessages: memoryContext.recentMessages?.length || 0,
    longTerm: memoryContext.longTerm?.length || 0,
    used: memoryContext.used?.map((memory) => ({ id: memory.id, key: memory.key, type: memory.type })) || [],
  };
}

export function decisionSummary(decision = {}) {
  const value = decision || {};
  return {
    intent: value.intent || "",
    skill: value.skill || "",
    confidence: Number(value.confidence) || 0,
    source: value.source || "",
    reason: value.reason || "",
    needsConfirmation: value.needsConfirmation === true,
    alternatives: (value.alternatives || []).map((item) => ({
      skill: item.skill || item.intent || "",
      confidence: Number(item.confidence) || 0,
    })),
  };
}

export function stateSummary(value = {}) {
  return {
    knowledgeBases: value.knowledgeBases?.length || 0,
    tasks: value.tasks?.length || 0,
    employees: value.employees?.length || 0,
  };
}

export function memoryInstructionSummary(result) {
  return {
    matched: Boolean(result),
    action: result?.action || "",
  };
}

export function memoryWriteSummary(result) {
  return {
    action: result?.action || "",
    saved: result?.memory?.saved?.length || 0,
    candidates: result?.memory?.candidates?.length || 0,
  };
}

export function confirmationSummary({ confirmedSkill, confirmationToken }) {
  return (result) => ({
    confirmedSkill,
    tokenPresent: Boolean(confirmationToken),
    verified: result?.ok === true,
    reason: result?.reason || "",
  });
}

export function toolExecutionSummary(skill, input) {
  return (result) => ({
    skill,
    input,
    result: summarizeToolResult(skill, result),
  });
}
