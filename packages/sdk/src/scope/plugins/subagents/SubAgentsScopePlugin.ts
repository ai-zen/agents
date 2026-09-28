import type { Tool } from "@ai-zen/agents-core";
import { isAbsolute, join } from "node:path";
import type { AgentDefinition } from "../../../types/index.js";
import { discoverSubAgents } from "./discover.js";
import { createSubAgentTool } from "./subAgentTools.js";
import type { Scope, FilterOutput } from "../../Scope.js";
import type { ScopeCandidates, ScopePlugin } from "../../ScopePlugin.js";

/**
 * SubAgent 插件 —— 发现 `sub-agents/*.json`，将含 function 的定义注册为工具。
 *
 * 产物为 `AgentToolLazy`（延迟构建，避免工具列表构建阶段的递归创建）。
 */
export class SubAgentsScopePlugin implements ScopePlugin {
  static readonly ID = "subagents";
  readonly id = SubAgentsScopePlugin.ID;

  private readonly paths: string[];
  private subagents: AgentDefinition[] = [];

  constructor(options?: { paths?: string[] }) {
    this.paths = options?.paths ?? [];
  }

  async discover(scope: Scope): Promise<void> {
    const dirs = this.paths.map((p) => (isAbsolute(p) ? p : join(scope.cwd, p)));
    this.subagents = await discoverSubAgents(dirs);
  }

  candidates(): ScopeCandidates {
    return {
      subagents: this.subagents
        .filter((d) => d.function)
        .map((d) => d.function!.name),
    };
  }

  instantiate(scope: Scope, filtered: FilterOutput): Tool[] {
    const allow = new Set(filtered.subagents);
    return this.subagents
      .filter((d) => d.function && allow.has(d.function.name))
      .map((d) => createSubAgentTool(d, scope));
  }
}
