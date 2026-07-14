import { Tool } from "@ai-zen/agents-core";
import { BUILTIN_TOOLS } from "../implements/builtin";

/**
 * 发现内置工具。直接返回 BUILTIN_TOOLS 实例。
 * 与 discoverUserTools 保持对称：都返回 Tool[]。
 */
export function discoverBuiltinTools(): Tool[] {
  return [...BUILTIN_TOOLS];
}
