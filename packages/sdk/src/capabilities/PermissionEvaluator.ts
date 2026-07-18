import type { AgentPermissions, PermissionPolicy } from "../types/index.js";

export interface CandidateSets {
  tools: string[];
  skills: string[];
  mcps: string[];
  subagents: string[];
}

const DENY_ALL: PermissionPolicy = { deny: ["*"] };

function matchPermission(name: string, policy: PermissionPolicy): boolean {
  if ("allow" in policy) {
    return policy.allow.some((p) => p === "*" || p === name);
  }
  return !policy.deny.some((p) => p === "*" || p === name);
}

/**
 * 权限评估器 — 按四维度权限过滤候选集。
 */
export class PermissionEvaluator {
  private permissions?: AgentPermissions;

  constructor(permissions?: AgentPermissions) {
    this.permissions = permissions;
  }

  filter(candidates: CandidateSets): CandidateSets {
    if (!this.permissions) {
      return { tools: [], skills: [], mcps: [], subagents: [] };
    }

    return {
      tools: this.filterDimension(candidates.tools, this.permissions.tools),
      skills: this.filterDimension(candidates.skills, this.permissions.skills),
      mcps: this.filterDimension(candidates.mcps, this.permissions.mcps),
      subagents: this.filterDimension(candidates.subagents, this.permissions.subagents),
    };
  }

  isAllowed(name: string, dimension: keyof CandidateSets): boolean {
    if (!this.permissions) return false;
    const policy = this.permissions[dimension as keyof AgentPermissions];
    if (!policy) return false;
    return matchPermission(name, policy);
  }

  static match(name: string, policy: PermissionPolicy): boolean {
    return matchPermission(name, policy);
  }

  private filterDimension(names: string[], policy?: PermissionPolicy): string[] {
    if (!policy) {
      policy = DENY_ALL;
    }
    this.validatePolicy(policy);
    return names.filter((name) => matchPermission(name, policy!));
  }

  private validatePolicy(policy: PermissionPolicy): void {
    if ("allow" in policy && "deny" in policy) {
      throw new Error("权限维度不能同时配置 allow 和 deny");
    }
  }
}
