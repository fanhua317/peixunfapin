export function containsSensitiveMemoryText(text) {
  const value = String(text || "");
  return (
    /\bsk-[A-Za-z0-9_-]{10,}\b/.test(value) ||
    /\b(?:api[_\s-]?key|token|secret|password|passwd|pwd)\b/i.test(value) ||
    /(密钥|密码|令牌|手机号|电话|微信|身份证|银行卡|住址|联系方式)/.test(value) ||
    /(成绩|分数|评价|绩效).{0,12}(王|李|张|刘|陈|赵|周|吴|孙|员工|同事|小明|小红)/.test(value)
  );
}

export function isHighRiskInstruction(text) {
  const value = String(text || "");
  return /(删除|删掉|清空|清除|移除|作废|撤销).*(培训记录|培训任务|任务记录|学习记录|考试记录|记忆|偏好|全部|所有)/.test(value);
}

export function hasExplicitMemorySignal(text) {
  return /(记住|以后|后续|下次|默认|以后默认|下次默认|我的偏好|我习惯|我喜欢|请记住)/.test(String(text || ""));
}

export function hasImplicitPreferenceSignal(text) {
  return /(我喜欢|我习惯|我希望|我更喜欢|最好|偏向|偏好|倾向于)/.test(String(text || ""));
}

export function shouldBlockMemoryWrite(text) {
  return containsSensitiveMemoryText(text) || isHighRiskInstruction(text);
}

export function classifyMemoryCommand(text) {
  const value = String(text || "").trim();
  if (/(查看|列出|看看|显示).*(记忆|偏好)|^(记忆|偏好)$/.test(value)) return { type: "list" };
  if (/(清空|删除|忘掉|移除).*(全部|所有|所有的)?(记忆|偏好)/.test(value)) return { type: "clear" };
  if (/(不要记住|别记住|不用记住|忽略这条记忆|取消记忆)/.test(value)) return { type: "ignore" };
  return null;
}

export function isMemoryOnlyInstruction(text) {
  const value = String(text || "");
  if (!hasExplicitMemorySignal(value) && !hasImplicitPreferenceSignal(value)) return false;
  if (/(写一篇|生成一篇|发布|安排|创建|新建|布置|分配|指派|查询|查看|查一下|删除|清空).*(培训|软文|营销文章|任务|记录|考试|学习|题)/.test(value)) {
    return false;
  }
  return true;
}

export function memoryStatusForText(text) {
  if (shouldBlockMemoryWrite(text)) return "blocked";
  if (/(记住|以后|后续|下次|默认|以后默认|下次默认|请记住)/.test(String(text || ""))) return "active";
  if (hasImplicitPreferenceSignal(text)) return "pending";
  return "none";
}
