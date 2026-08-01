import type { Tool } from "@ai-zen/agents-core";
import { BUILTIN_TOOL_CLASSES } from "../implements/builtin/index.js";
import { GenerateImageTool } from "../implements/builtin/GenerateImageTool.js";
import type { ToolEnv } from "../../types/index.js";

/**
 * 发现内置工具：用 ToolEnv 实例化全部内置工具类。
 *
 * generateImage 依赖图片模型配置（defaultImageModel），未配置时不注册，
 * 因此不进入 BUILTIN_TOOL_CLASSES 静态注册表，在此按条件实例化。
 */
export function discoverBuiltinTools(env: ToolEnv): Tool[] {
  const tools: Tool[] = BUILTIN_TOOL_CLASSES.map((Cls) => new Cls(env));

  if (env.config.defaultImageModel) {
    const existingNames = new Set(tools.map((t) => t.function.name));
    if (!existingNames.has("generateImage")) {
      tools.push(new GenerateImageTool(env));
    }
  }

  return tools;
}
