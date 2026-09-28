import type { ScopePlugin } from "../ScopePlugin.js";
import { BuiltinToolsScopePlugin } from "./builtin/BuiltinToolsScopePlugin.js";
import { UserToolsScopePlugin } from "./usertools/UserToolsScopePlugin.js";
import { SkillsScopePlugin } from "./skills/SkillsScopePlugin.js";
import { McpScopePlugin } from "./mcp/McpScopePlugin.js";
import { SubAgentsScopePlugin } from "./subagents/SubAgentsScopePlugin.js";

/** allInOne 的装配选项：各类能力来源的路径（绝对或相对 scope.cwd） */
export interface AllInOneOptions {
  skillsPaths?: string[];
  toolsPaths?: string[];
  subAgentsPaths?: string[];
  mcpPaths?: string[];
}

/**
 * 标准能力插件工厂 —— 恒返回 5 个标准插件（"全家桶"）。
 *
 * 顺序即优先级（去重时后注册覆盖先注册）：
 *   builtin → user-tools → skills → mcp → subagents
 * 因此用户工具可覆盖同名内置工具（与 v0 一致）。
 *
 * 想裁剪/替换某一类，改用手工逐个 `new XxxScopePlugin(...)` 后 `.use()`。
 */
export function allInOne(options?: AllInOneOptions): ScopePlugin[] {
  return [
    new BuiltinToolsScopePlugin(),
    new UserToolsScopePlugin({ paths: options?.toolsPaths }),
    new SkillsScopePlugin({ paths: options?.skillsPaths }),
    new McpScopePlugin({ paths: options?.mcpPaths }),
    new SubAgentsScopePlugin({ paths: options?.subAgentsPaths }),
  ];
}
