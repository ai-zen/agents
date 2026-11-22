import type { Tool } from "@ai-zen/agents-core";
import { BUILTIN_TOOL_CLASSES } from "./index.js";
import type { ToolEnv } from "../../../types/index.js";

/**
 * 发现内置工具：按静态注册表实例化全部内置工具（无任何过滤）。
 * 可用性判断落在 `BuiltinToolsScopePlugin.candidates()`，不在这一层。
 */
export function discoverBuiltinTools(env: ToolEnv): Tool[] {
  return BUILTIN_TOOL_CLASSES.map((Cls) => new Cls(env));
}
