import { Tool } from "@ai-zen/agents-core";
import { BUILTIN_TOOLS } from "../implements/builtin";
import { createGenerateImageTool } from "../implements/builtin/generateImage";
import type { AppConfig } from "../../types";

/**
 * 发现内置工具。直接返回 BUILTIN_TOOLS 实例。
 * 如果配置了图片模型，额外包含 generateImage 工具。
 * 与 discoverUserTools 保持对称：都返回 Tool[]。
 */
export function discoverBuiltinTools(config?: AppConfig): Tool[] {
  const tools = [...BUILTIN_TOOLS];

  if (config?.imageModels?.length) {
    // 去重：用户工具或已有内置工具中已存在同名工具时不注入
    const existingNames = new Set(tools.map((t) => t.function.name));
    if (!existingNames.has("generateImage")) {
      tools.push(createGenerateImageTool(config));
    }
  }

  return tools;
}
