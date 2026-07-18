import { Tool } from "@ai-zen/agents-core";
import { BUILTIN_TOOLS } from "../implements/builtin/index.js";
import { createGenerateImageTool } from "../implements/builtin/generateImage.js";
import type { AppConfig } from "../../types/index.js";

/**
 * 发现内置工具。直接返回 BUILTIN_TOOLS 实例。
 * 如果配置了 defaultImageModel，额外包含 generateImage 工具。
 * 与 discoverUserTools 保持对称：都返回 Tool[]。
 */
export function discoverBuiltinTools(config: AppConfig): Tool[] {
  const tools = [...BUILTIN_TOOLS];

  if (config.defaultImageModel) {
    const existingNames = new Set(tools.map((t) => t.function.name));
    if (!existingNames.has("generateImage")) {
      tools.push(createGenerateImageTool(config));
    }
  }

  return tools;
}
