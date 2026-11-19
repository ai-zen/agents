import type { Tool } from "@ai-zen/agents-core";
import type { AppConfig, AgentDefinition, ToolEnv, ToolEnvDeps } from "../types/index.js";
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
  exclude?: ExcludeOptions;
}

/**
 * 取配置的端口 —— `Scope` 不再收一份配置快照，而是收「怎么拿到当下这一份」。
 *
 * 配置的本质是磁盘上那几个 json：改完之后该由下一次 `refresh()` 现读读到，
 * 而不是把整个 Scope 拆掉重建（拆掉会连带别的能力一起重来，且正在跑的那一次请求
 * 会被抽掉能力）。端口可以是同步的（测试里给一份常量），也可以是异步的
 * （宿主给 `ConfigManager.read()`）。
 */
export type ScopeConfigSource = () => AppConfig | Promise<AppConfig>;

/**
 * Scope — 全局上下文 + 能力装配编排容器。
 *
 * Scope 是 SDK 的唯一入口对象，持有：
 *   - 应用配置（端点、模型等）
 *   - 当前工作目录 cwd（相对路径解析基准，ToolEnv.cwd 的来源）
 *   - Agent 定义目录 agentsDir（createAgent 用）
 *   - 一组 ScopePlugin（能力插件）
 *
 * 装配方式（插件必须显式注入，Scope 不装任何默认插件）：
 * ```ts
 * const scope = new Scope({ getConfig, cwd, agentsDir })
 *   .use(...allInOne({ skillsPaths, toolsPaths, subAgentsPaths, mcpPaths }));
 * await scope.init();
 * ```
 *
 * 设计原则：
 *   - Scope 只做编排：三阶段管线骨架（发现 → 过滤 → 实例化）+ 生命周期
 *   - 能力来源（内置/用户工具、Skill、MCP、SubAgent）全部疏散到 ScopePlugin，各自自持
 *   - config 随 `refresh()` 更新（每次现读端口），cwd / agentsDir 创建之后不变
 */
export class Scope {
  /** 取配置的端口：每次 `refresh()` 都问它要一份 */
  private readonly getConfig: ScopeConfigSource;

  /**
   * 当下这一份配置。
   *
   * 只有一个字段、一个来源：`scope.config` 与 `scope.env.config` 读的都是它，
   * 于是「按新配置算出来的东西」与「工具 exec 时看到的配置」不会分叉。
   */
  private current?: AppConfig;

  /** 当前工作目录 — 相对路径解析基准，也是 ToolEnv.cwd 的来源 */
  readonly cwd: string;

  /** 工具环境 — 插件实例化内置工具时注入（`config` 是活的，见构造函数的注释） */
  readonly env: ToolEnv;

  /** Agent 定义目录（createAgent 用） */
  readonly agentsDir: string;

  /** 已注册的插件 */
  private _plugins: ScopePlugin[] = [];

  /** 是否已 init（init 之后禁止再 use） */
  private _initialized = false;

  constructor(options: {
    /** 取配置的端口：配置改了不必重建 Scope，下一次 `refresh()` 就会读到新的那一份 */
    getConfig: ScopeConfigSource;
    agentsDir: string;
    cwd?: string;
    /** 出网/外部依赖的注入点（缺省全部走真实 OpenAI SDK），会透传到 ToolEnv.deps */
    deps?: ToolEnvDeps;
  }) {
    this.getConfig = options.getConfig;
    this.cwd = options.cwd ?? process.cwd();
    this.agentsDir = options.agentsDir;

    // 端口给的是现成的一份（同步）时，构造完就能读 config；给的是 Promise 时
    // 留到 init() / refresh() 填 —— 那时候读之前先等一次即可。
    const seeded = options.getConfig();
    if (!isPromiseLike(seeded)) this.current = seeded;

    const scope = this;
    this.env = {
      cwd: this.cwd,
      // 活的 config：工具在 exec 时读到的永远是「当下这一份」，refresh 之后就是新的。
      // 不在这里另存一份，否则 env.config 与 scope.config 会分叉。
      get config(): AppConfig {
        return scope.config;
      },
      ...(options.deps ? { deps: options.deps } : {}),
    };
  }

  /**
   * 应用配置（端点、模型等）。
   *
   * 同步读，读到的是**当下**那一份：`refresh()` 之后就是磁盘上的新配置。
   * 配置端口是异步的且还没 `init()` 过时抛错（那时确实还没有「当下这一份」）。
   */
  get config(): AppConfig {
    if (this.current === undefined) {
      throw new Error(
        "Scope.config is not loaded yet: the config port is async, await init() / refresh() first",
      );
    }
    return this.current;
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
      throw new Error("Scope.use() must be called before init()");
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
   * 初始化：取一次配置 + 执行首次全局能力发现（遍历插件 discover()），随后锁定插件注册。
   */
  async init(): Promise<void> {
    await this.refresh();
    this._initialized = true;
  }

  /**
   * 重新取配置 + 重新执行全局发现（遍历插件 discover()）。
   *
   * 顺序不能反：插件发现可能要用新配置算路径 / 开关（如内置工具的可用性、
   * MCP 的连接对账），所以先把 `current` 换掉，再让插件看世界。
   */
  async refresh(options?: { silent?: boolean }): Promise<void> {
    const opts = { silent: options?.silent ?? false };
    this.current = await this.getConfig();
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

/** 端口返回值是不是 Promise（同步端口因此可以省掉一次 await 的语义差别） */
function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
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
