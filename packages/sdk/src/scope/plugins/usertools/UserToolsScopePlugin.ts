import type { Tool } from "@ai-zen/agents-core";
import { isAbsolute, join } from "node:path";
import type { AgentDefinition } from "../../../types/index.js";
import type { LogSink } from "../../../shared/logger.js";
import { discoverUserTools } from "./discover.js";
import type { Scope, FilterOutput } from "../../Scope.js";
import type { ScopeCandidates, ScopePlugin } from "../../ScopePlugin.js";

/**
 * 用户工具插件 —— 扫描 `tools/*.js` / `*.mjs` 动态加载。
 *
 * 与内置工具插件分开，以便单独替换/停用其中一类。
 * 路径可为绝对路径或相对路径（相对则按 scope.cwd join）。
 */
export class UserToolsScopePlugin implements ScopePlugin {
  static readonly ID = "user-tools";
  readonly id = UserToolsScopePlugin.ID;

  private readonly paths: string[];
  private tools: Tool[] = [];

  /** 日志口（可选）：某个文件被拒了报一句；不注入就不记 */
  private readonly logger?: LogSink;

  constructor(options?: { paths?: string[]; logger?: LogSink }) {
    this.paths = options?.paths ?? [];
    this.logger = options?.logger;
  }

  async discover(scope: Scope, options?: { silent?: boolean }): Promise<void> {
    const dirs = this.paths.map((p) => (isAbsolute(p) ? p : join(scope.cwd, p)));
    this.tools = await discoverUserTools(dirs, { silent: options?.silent, logger: this.logger });
  }

  candidates(_scope: Scope, _definition: AgentDefinition): ScopeCandidates {
    return { tools: this.tools.map((t) => t.function.name) };
  }

  instantiate(_scope: Scope, filtered: FilterOutput): Tool[] {
    const allow = new Set(filtered.tools);
    return this.tools.filter((t) => allow.has(t.function.name));
  }
}
