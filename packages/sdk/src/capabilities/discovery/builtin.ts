import type { Tool } from "@ai-zen/agents-core";
import { BUILTIN_TOOL_CLASSES } from "../implements/builtin/index.js";
import type { ToolEnv } from "../../types/index.js";

/**
 * 发现内置工具：按静态注册表实例化全部内置工具（无任何过滤）。
 *
 * 工具的可用性由各工具自行声明（SdkCallbackTool.isAvailable，入参含完整 config
 * + 模型信息），在 buildTools/filter 阶段（模型已知）按声明过滤。
 */
export function discoverBuiltinTools(env: ToolEnv): Tool[] {
  return BUILTIN_TOOL_CLASSES.map((Cls) => new Cls(env));
}
