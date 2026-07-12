const SKILL_RECURSIVE_TOOLS = ["call_skill_sub_agent", "load_skill"];

/**
 * SubAgent 候选集安全预过滤：剔除自身和调用者，防止递归/反向调用。
 * 预过滤不受权限配置影响。
 */
export function prefilterSubAgents(
  candidates: string[],
  selfName?: string,
  callerName?: string,
): string[] {
  const exclude = new Set([selfName, callerName].filter(Boolean) as string[]);
  if (exclude.size === 0) return candidates;
  return candidates.filter((name) => !exclude.has(name));
}

/**
 * Skill 子 Agent 工具候选集安全预过滤：剔除可能引发递归的工具。
 * 预过滤不受权限配置影响。
 */
export function prefilterSkillTools(candidates: string[]): string[] {
  return candidates.filter((name) => !SKILL_RECURSIVE_TOOLS.includes(name));
}
