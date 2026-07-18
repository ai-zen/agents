import type { AgentPermissions, PermissionPolicy } from "../types/index.js";
import { matchPermission } from "./permission.js";

export interface CandidateSets {
  tools: string[];
  skills: string[];
  mcps: string[];
  subagents: string[];
}

const DENY_ALL: PermissionPolicy = { deny: ["*"] };

/**
 * 按四维度权限过滤候选集。
 * - permissions 缺失 → 全部拒绝
 * - 某维度缺失 → 该维度 deny: ['*']
 * - 某维度同时配了 allow 和 deny → 抛出异常
 */
export function filterByPermissions(
  permissions: AgentPermissions | undefined,
  candidates: CandidateSets,
): CandidateSets {
  if (!permissions) {
    return { tools: [], skills: [], mcps: [], subagents: [] };
  }

  return {
    tools: filterDimension(candidates.tools, permissions.tools),
    skills: filterDimension(candidates.skills, permissions.skills),
    mcps: filterDimension(candidates.mcps, permissions.mcps),
    subagents: filterDimension(candidates.subagents, permissions.subagents),
  };
}

function filterDimension(names: string[], policy?: PermissionPolicy): string[] {
  if (!policy) {
    policy = DENY_ALL;
  }

  validatePolicy(policy);

  return names.filter((name) => matchPermission(name, policy!));
}

function validatePolicy(policy: PermissionPolicy): void {
  if ("allow" in policy && "deny" in policy) {
    throw new Error("权限维度不能同时配置 allow 和 deny");
  }
}
