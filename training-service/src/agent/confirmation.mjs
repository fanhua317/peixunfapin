import { isConfirmedSkillAllowed } from "../ai/index.mjs";
import { createIntentConfirmationToken, verifyIntentConfirmationToken } from "../intent-confirmation.mjs";
import { getWebSkill } from "../tools/registry.mjs";

function intentLabel(skill) {
  return getWebSkill(skill)?.label || "执行操作";
}

export function intentConfirmPayload(message, decision) {
  const confirmation = createIntentConfirmationToken(message, decision.skill);
  return {
    action: "intent_confirm",
    message,
    decision,
    confirmation: {
      skill: decision.skill,
      token: confirmation.token,
      expiresAt: confirmation.expiresAt,
      title: decision.skill === "delete_training_records" ? "确认删除培训记录？" : `确认${intentLabel(decision.skill)}？`,
      description: decision.skill === "delete_training_records"
        ? "删除会移除匹配的培训任务、学习链接、试卷和答题记录；知识库和员工名单不会删除。"
        : `我理解你想${intentLabel(decision.skill)}。为避免误操作，请确认后再执行。`,
      risk: getWebSkill(decision.skill)?.risk || (decision.skill === "delete_training_records" ? "high" : "normal"),
    },
  };
}

export function validateConfirmedSkill({ confirmedSkill, confirmationToken, message }, status = 400) {
  if (!confirmedSkill) return null;
  if (!isConfirmedSkillAllowed(confirmedSkill)) {
    return { status, error: "unsupported confirmedSkill" };
  }
  const verification = verifyIntentConfirmationToken(confirmationToken, { message, skill: confirmedSkill });
  if (!verification.ok) {
    return {
      status: status === 400 ? 409 : status,
      error: "invalid intent confirmation",
      reason: verification.reason,
    };
  }
  return { ok: true, verification };
}
