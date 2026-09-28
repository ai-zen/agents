import type { Tool } from "@ai-zen/agents-core";
import type { AppConfig, AgentDefinition } from "../../../types/index.js";
import { discoverBuiltinTools } from "./discover.js";
import type { Scope, FilterOutput } from "../../Scope.js";
import type { ScopeCandidates, ScopePlugin } from "../../ScopePlugin.js";

/**
 * 内置工具插件 —— 20 个内置工具类（BUILTIN_TOOL_CLASSES）。
 *
 * 发现层零过滤；可用性由各工具 `isAvailable(config, definition)` 自陈，
 * 在本插件 `candidates()` 阶段按声明剔除（如 GenerateImageTool 依赖 defaultImageModel、
 * ViewImageTool 仅视觉模型可用）。
 */
export class BuiltinToolsScopePlugin implements ScopePlugin {
  static readonly ID = "builtin";
  readonly id = BuiltinToolsScopePlugin.ID;

  /** 发现结果自持（每次 discover 重新实例化） */
  private tools: Tool[] = [];

  discover(scope: Scope): void {
    this.tools = discoverBuiltinTools(scope.env);
  }

  candidates(scope: Scope, definition: AgentDefinition): ScopeCandidates {
    const tools = this.tools
      .filter((t) => {
        const isAvailable = (
          t as
            | { isAvailable?: (config: AppConfig, def: AgentDefinition) => boolean }
            | undefined
        )?.isAvailable;
        return isAvailable ? isAvailable(scope.config, definition) : true;
      })
      .map((t) => t.function.name);
    return { tools };
  }

  instantiate(_scope: Scope, filtered: FilterOutput): Tool[] {
    const allow = new Set(filtered.tools);
    return this.tools.filter((t) => allow.has(t.function.name));
  }
}
