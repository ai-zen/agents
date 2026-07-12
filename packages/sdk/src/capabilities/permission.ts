import type { PermissionPolicy } from "../types";

/**
 * 单维度权限匹配。
 * - allow 模式：name 在列表中（含通配符 *）→ true，否则 false
 * - deny 模式：name 在列表中（含通配符 *）→ false，否则 true
 */
export function matchPermission(name: string, policy: PermissionPolicy): boolean {
  if ("allow" in policy) {
    return policy.allow.some((p) => p === "*" || p === name);
  }
  return !policy.deny.some((p) => p === "*" || p === name);
}
