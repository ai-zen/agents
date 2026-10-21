import type { Tool } from "@ai-zen/agents-core";
import type { AppConfig, AgentDefinition, ToolEnv } from "../types/index.js";
import { PermissionEvaluator } from "./PermissionEvaluator.js";
import type { ScopePlugin } from "./ScopePlugin.js";

// ---------------------------------------------------------------------------
// 类型导出
// ---------------------------------------------------------------------------

/**
 * 能力过滤系统的公共类型。
 * FilterOutput 由 filter() 产出，由 instantiate() 消费。
 */
export interface FilterOutput {
  tools: string[];
  subagents: string[];
  skills: string[];
  mcps: string[];
}

/**
 * 排除项黑名单（优先级高于 permissions）。
 * 与 permissions 四维对称，用于安全预过滤。
 */
export interface ExcludeOptions {
  tools?: string[];
  skills?: string[];
  mcps?: string[];
  subagents?: string[];
}

/** filter / buildTools 的过滤选项 */
export interface FilterOptions {
  /** 排除项黑名单（优先级高于 permissions） */
  exclude?: ExcludeOptions;
}

/**
 * Scope — 全局上下文 + 能力装配编排容器（v1）。
 *
 * Scope 是 SDK 的唯一入口对象，持有：
 *   - 应用配置（端点、模型等）
 *   - 当前工作目录 cwd（相对路径解析基准，ToolEnv.cwd 的来源）
 *   - Agent 定义目录 agentsDir（createAgent 用）
 *   - 一组 ScopePlugin（能力插件）
 *
 * 装配方式（插件必须显式注入，Scope 不装任何默认插件）：
 * ```ts
 * const scope = new Scope({ config, cwd, agentsDir })
 *   .use(...allInOne({ skillsPaths, toolsPaths, subAgentsPaths, mcpPaths }));
 * await scope.init();
 * ```
 *
 * 设计原则：
 *   - Scope 只做编排：三阶段管线骨架（发现 → 过滤 → 实例化）+ 生命周期
 *   - 能力来源（内置/用户工具、Skill、MCP、SubAgent）全部疏散到 ScopePlugin，各自自持
 *   - Scope 实例一旦创建，config/cwd/agentsDir/env 不变；refresh() 只让插件重新发现
 */
export class Scope {
  /** 应用配置（端点、模型等） */
  readonly config: AppConfig;

  /** 当前工作目录 — 相对路径解析基准，也是 ToolEnv.cwd 的来源 */
  readonly cwd: string;

  /** 工具环境 — 插件实例化内置工具时注入 */
  readonly env: ToolEnv;

  /** Agent 定义目录（createAgent 用） */
  readonly agentsDir: string;

  /** 已注册的插件 */
  private _plugins: ScopePlugin[] = [];

  /** 是否已 init（init 之后禁止再 use） */
  private _initialized = false;

  constructor(options: { config: AppConfig; agentsDir: string; cwd?: string }) {
    this.config = options.config;
    this.cwd = options.cwd ?? process.cwd();
    this.env = { cwd: this.cwd, config: this.config };
    this.agentsDir = options.agentsDir;
  }

  // ==================================================================
  // 插件注册与生命周期
  // ==================================================================

  /** 已注册插件（只读视图） */
  get plugins(): readonly ScopePlugin[] {
    return this._plugins;
  }

  /**
   * 注册能力插件（链式，可变参数）。
   *
   * 支持两种用法：
   *   scope.use(plugin)
   *   scope.use(...allInOne({ ... }))   // 展开批量注册
   *
   * 必须在 init() 之前调用；init() 之后再 use() 会抛错。
   */
  use(...plugins: ScopePlugin[]): this {
    if (this._initialized) {
      throw new Error("Scope.use() 必须在 init() 之前调用");
    }
    for (const plugin of plugins) {
      this._plugins.push(plugin);
    }
    return this;
  }

  /** 按 id 查找插件（供外部代码/其它插件查询插件状态） */
  getPluginById<T extends ScopePlugin>(id: string): T | undefined {
    return this._plugins.find((p) => p.id === id) as T | undefined;
  }

  /**
   * 初始化：执行首次全局能力发现（遍历插件 discover()），随后锁定插件注册。
   */
  async init(): Promise<void> {
    await this.refresh();
    this._initialized = true;
  }

  /**
   * 重新执行全局发现（遍历插件 discover()）。
   */
  async refresh(options?: { silent?: boolean }): Promise<void> {
    const opts = { silent: options?.silent ?? false };
    for (const plugin of this._plugins) {
      await plugin.discover?.(this, opts);
    }
  }

  /**
   * 释放：逆序调用各插件 dispose()（如 MCP 断开所有连接）。与 init() 对称。
   */
  async dispose(): Promise<void> {
    for (let i = this._plugins.length - 1; i >= 0; i--) {
      await this._plugins[i].dispose?.();
    }
  }

  // ==================================================================
  // 能力过滤与实例化
  // ==================================================================

  /**
   * 按权限过滤候选集，返回过滤后的名称列表。
   * 汇总各插件 candidates() → 应用 exclude 安全预过滤 → 四维权限过滤。
   * 纯名称操作，不涉及 Tool 实例化。
   */
  filter(definition: AgentDefinition, options?: FilterOptions): FilterOutput {
    const exclude = options?.exclude ?? {};
    const excludeTools = new Set(exclude.tools ?? []);
    const excludeSkills = new Set(exclude.skills ?? []);
    const excludeMcps = new Set(exclude.mcps ?? []);
    const excludeSubAgents = new Set(exclude.subagents ?? []);

    // 1. 汇总各插件候选（插件已在 candidates 内完成自身可用性判断）
    const tools = new Set<string>();
    const skills = new Set<string>();
    const mcps = new Set<string>();
    const subagents = new Set<string>();
    for (const plugin of this._plugins) {
      const c = plugin.candidates(this, definition);
      c.tools?.forEach((n) => tools.add(n));
      c.skills?.forEach((n) => skills.add(n));
      c.mcps?.forEach((n) => mcps.add(n));
      c.subagents?.forEach((n) => subagents.add(n));
    }

    // 2 + 3. exclude 预过滤 + 四维权限过滤
    const evaluator = new PermissionEvaluator(definition.permissions);
    const filtered = evaluator.filter({
      tools: [...tools].filter((n) => !excludeTools.has(n)),
      skills: [...skills].filter((n) => !excludeSkills.has(n)),
      mcps: [...mcps].filter((n) => !excludeMcps.has(n)),
      subagents: [...subagents].filter((n) => !excludeSubAgents.has(n)),
    });

    return {
      tools: filtered.tools,
      subagents: filtered.subagents,
      skills: filtered.skills,
      mcps: filtered.mcps,
    };
  }

  /**
   * 快捷方法：filter + instantiate 一步完成。
   */
  buildTools(definition: AgentDefinition, options?: FilterOptions): Tool[] {
    return this.instantiate(this.filter(definition, options));
  }

  /**
   * 将过滤后的名称列表实例化为 Tool 数组。
   * 遍历各插件 instantiate()，收集后去重（后注册覆盖先注册）。
   */
  instantiate(filtered: FilterOutput): Tool[] {
    const result: Tool[] = [];
    for (const plugin of this._plugins) {
      result.push(...plugin.instantiate(this, filtered));
    }
    return dedupTools(result);
  }
}

function dedupTools(tools: Tool[]): Tool[] {
  const seen = new Set<string>();
  const result: Tool[] = [];
  for (let i = tools.length - 1; i >= 0; i--) {
    const name = tools[i].function.name;
    if (!seen.has(name)) {
      seen.add(name);
      result.unshift(tools[i]);
    }
  }
  return result;
}
