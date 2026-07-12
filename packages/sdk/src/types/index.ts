/** 单维度权限策略：allow 或 deny 互斥 */
export type PermissionPolicy =
  | { allow: string[] }
  | { deny: string[] };

/** Agent 四维度权限 */
export interface AgentPermissions {
  tools?: PermissionPolicy;
  skills?: PermissionPolicy;
  mcps?: PermissionPolicy;
  subagents?: PermissionPolicy;
}
