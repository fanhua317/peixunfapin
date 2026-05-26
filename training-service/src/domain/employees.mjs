import { includesAny } from "./common.mjs";

export function searchEmployees(state, query) {
  const normalized = String(query || "").trim();
  if (!normalized) return state.employees.filter((employee) => employee.status === "active");
  if (/(全部|所有|全员|全体|员工|人员|大家)/.test(normalized)) {
    return state.employees.filter((employee) => employee.status === "active");
  }

  return state.employees.filter((employee) => {
    const aliases = employee.aliases || [];
    return (
      employee.status === "active" &&
      (includesAny(normalized, [employee.name, employee.department, employee.role, ...aliases]) ||
        includesAny(`${employee.name} ${employee.department} ${employee.role} ${aliases.join(" ")}`, [normalized]))
    );
  });
}
