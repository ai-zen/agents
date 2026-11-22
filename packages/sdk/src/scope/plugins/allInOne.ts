import type { ScopePlugin } from "../ScopePlugin.js";
import type { LogSink } from "../../shared/logger.js";
import { BuiltinToolsScopePlugin } from "./builtin/BuiltinToolsScopePlugin.js";
import { UserToolsScopePlugin } from "./usertools/UserToolsScopePlugin.js";
import { SkillsScopePlugin } from "./skills/SkillsScopePlugin.js";
import { McpScopePlugin } from "./mcp/McpScopePlugin.js";
import type { McpTaskNoticePort } from "./mcp/mcpTaskNotice.js";
import { SubAgentsScopePlugin } from "./subagents/SubAgentsScopePlugin.js";

/** allInOne 的装配选项：各类能力来源的路径（绝对或相对 scope.cwd） */
export interface AllInOneOptions {
  skillsPaths?: string[];
  toolsPaths?: string[];
  subAgentsPaths?: string[];
  mcpPaths?: string[];
  /**
   * 日志口（可选）：四个会读盘的插件（用户工具 / Skill / MCP / subagent）把它们发现的
   * 「这个文件读不出来」报到这里；不传则一律不记（库缺省沉默）。
   */
  logger?: LogSink;
  /**
   * MCP 任务通知的投递口（可选）：由宿主实现。不给时任务状态只当没收到，
   * `call_mcp_tool` 的任务参数照旧可用。
   */
  mcpTaskNotice?: McpTaskNoticePort;
}

/**
 * 标准能力插件工厂 —— 恒返回 5 个标准插件（"全家桶"）。
 *
 * 顺序即优先级（去重时后注册覆盖先注册，见 `Scope.instantiate`）：
 *   builtin → user-tools → skills → mcp → subagents
 * 因此用户工具可覆盖同名内置工具。
 *
 * 想裁剪/替换某一类，改用手工逐个 `new XxxScopePlugin(...)` 后 `.use()`。
 */
export function allInOne(options?: AllInOneOptions): ScopePlugin[] {
  return [
    new BuiltinToolsScopePlugin(),
    new UserToolsScopePlugin({ paths: options?.toolsPaths, logger: options?.logger }),
    new SkillsScopePlugin({ paths: options?.skillsPaths, logger: options?.logger }),
    new McpScopePlugin({
      paths: options?.mcpPaths,
      logger: options?.logger,
      taskNotice: options?.mcpTaskNotice,
    }),
    new SubAgentsScopePlugin({ paths: options?.subAgentsPaths, logger: options?.logger }),
  ];
}
