export function domainError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

export function includesAny(source, values) {
  const text = String(source || "").toLowerCase();
  return values.some((value) => value && text.includes(String(value).toLowerCase()));
}

export function parseNumberBefore(text, keywords, defaultValue) {
  for (const keyword of keywords) {
    const pattern = new RegExp(`(\\d+)\\s*(?:道|个|条)?\\s*${keyword}`);
    const match = String(text || "").match(pattern);
    if (match) return Number(match[1]);
  }
  const generic = String(text || "").match(/(\\d+)\\s*道/);
  return generic ? Number(generic[1]) : defaultValue;
}

export function parsePassScore(text, defaultValue = 80) {
  const match = String(text || "").match(/(\\d+)\\s*分(?:及格|通过|合格)/);
  return match ? Number(match[1]) : defaultValue;
}

export function parseDeadline(text) {
  const value = String(text || "");
  const now = new Date();
  if (value.includes("明天")) {
    const deadline = new Date(now);
    deadline.setDate(deadline.getDate() + 1);
    const hourMatch = value.match(/明天.*?(上午|下午|晚上)?\s*(\d{1,2})\s*点/);
    if (hourMatch) {
      let hour = Number(hourMatch[2]);
      if ((hourMatch[1] === "下午" || hourMatch[1] === "晚上") && hour < 12) hour += 12;
      deadline.setHours(hour, 0, 0, 0);
    } else {
      deadline.setHours(18, 0, 0, 0);
    }
    return deadline.toISOString();
  }
  if (value.includes("本周五")) {
    const deadline = new Date(now);
    const day = deadline.getDay() || 7;
    deadline.setDate(deadline.getDate() + (5 - day));
    deadline.setHours(18, 0, 0, 0);
    return deadline.toISOString();
  }
  const dateMatch = value.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (dateMatch) {
    const deadline = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), 18, 0, 0, 0);
    return deadline.toISOString();
  }
  const defaultDeadline = new Date(now);
  defaultDeadline.setDate(defaultDeadline.getDate() + 7);
  defaultDeadline.setHours(18, 0, 0, 0);
  return defaultDeadline.toISOString();
}

export function parseRequestedAudience(text) {
  const value = String(text || "").trim();
  const actionPattern = "(?:发布|安排|创建|新建|布置|分配|指派|生成|制定|做|建|出|培训|学习|考试|课程)";
  const withPrefix = value.match(new RegExp(`给\\s*([^\\n，。；;,.]+?)\\s*${actionPattern}`));
  const startsWithAction = new RegExp(`^\\s*${actionPattern}`).test(value);
  const leadingAudience = startsWithAction ? null : value.match(new RegExp(`^\\s*([^\\n，。；;,.]+?)\\s*${actionPattern}`));
  const match = withPrefix || leadingAudience;
  const source = match ? match[1] : "";
  return [...new Set(source
    .split(/(?:和|、|，|,|\/|\s+)/)
    .map((name) => name.trim())
    .filter((name) => name && !/^(全部|所有|全员|全体|员工|人员|大家)$/.test(name)))]
    .slice(0, 10);
}

export function isExpiredAt(value, now = new Date()) {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() < now.getTime();
}

export function markInviteExpired(invite, now = new Date()) {
  if (!invite) return false;
  if (invite.status === "expired") return true;
  if (invite.status === "completed") return false;
  if (!isExpiredAt(invite.expiresAt, now)) return false;
  invite.status = "expired";
  return true;
}

export function latestAttempts(attempts) {
  const latest = new Map();
  for (const attempt of attempts) {
    const key = attempt.inviteId || `${attempt.taskId}:${attempt.employeeId || attempt.employeeName}`;
    const current = latest.get(key);
    if (!current || String(attempt.submittedAt || "") > String(current.submittedAt || "")) {
      latest.set(key, attempt);
    }
  }
  return [...latest.values()];
}
