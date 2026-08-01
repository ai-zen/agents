import type { Tool } from "@ai-zen/agents-core";
import type { AppConfig, AgentDefinition, AgentPermissions, McpServerConfig, ToolEnv } from "../types/index.js";
import type { SkillInfo } from "../capabilities/discovery/skills.js";
import { McpConnectionManager } from "./McpConnectionManager.js";
import { PermissionEvaluator } from "../capabilities/PermissionEvaluator.js";
import { createLoadSkillTool, createCallSkillSubAgentTool } from "../capabilities/implements/skillTools.js";
import { createLoadMcpTool, createCallMcpTool, createReadMcpResourceTool } from "../capabilities/implements/mcpTools.js";
import { createSubAgentTool } from "../capabilities/implements/subAgentTools.js";
import { discoverBuiltinTools } from "../capabilities/discovery/builtin.js";
import { discoverSubAgents } from "../capabilities/discovery/subagents.js";
import { discoverSkills } from "../capabilities/discovery/skills.js";
import { discoverMcpServers } from "../capabilities/discovery/mcp.js";
import { discoverUserTools } from "../capabilities/discovery/usertools.js";


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

/**
 * Provider — 全局上下文实例 + 能力注册表。
 *
 * Provider 是 SDK 的全局单例（按需创建），持有：
 *   - 应用配置（端点、模型等）
 *   - 文件系统路径（Agent 目录、Skill 目录等）
 *   - 全局能力注册表（内置工具、用户工具、SubAgent、Skill、MCP）
 *   - MCP 连接管理器
 *
 * 创建方式：
 * ```ts
 * // 推荐：一步完成构造 + 能力发现
 * const provider = await Provider.create({ ... });
 *
 * // 仅构造（能力需后续加载）
 * const provider = new Provider({ ... });
 * await provider.init();
 * ```
 *
 * 设计原则：
 *   - Provider 实例一旦创建不可变（路径、配置等不变），refresh 时重新发现能力
 *   - 各层不直接 import 散装函数，而是通过 Provider 实例获取
 */
export class Provider {
  /** 应用配置（端点、模型等） */
  readonly config: AppConfig;

  /** 当前工作目录 — 相对路径解析基准，也是 ToolEnv.cwd 的来源 */
  readonly cwd: string;

  /** 工具环境 — 实例化内置工具时注入 */
  readonly env: ToolEnv;

  // ---- 路径 ----
  readonly agentsDir: string;
  readonly subAgentsPaths: string[];
  readonly skillsPaths: string[];
  readonly toolsPaths: string[];
  readonly mcpPaths: string[];

  // ---- 全局候选集（发现一次，全局复用）----
  builtinTools: Tool[];
  userTools: Tool[];
  subagents: AgentDefinition[];
  /** 完整 SkillInfo，含 subAgent 标记，可据此区分枚举 */
  skills: SkillInfo[];
  /** 完整 MCP 服务器配置 */
  mcps: McpServerConfig[];

  // ---- MCP ----
  readonly mcpManager: McpConnectionManager | undefined;

  constructor(options: {
    config: AppConfig;
    agentsDir: string;
    subAgentsPaths?: string[];
    skillsPaths?: string[];
    toolsPaths?: string[];
    mcpPaths?: string[];
    /** 当前工作目录，默认 process.cwd() */
    cwd?: string;
  }) {
    this.config = options.config;
    this.cwd = options.cwd ?? process.cwd();
    this.env = { cwd: this.cwd, config: this.config };
    this.agentsDir = options.agentsDir;
    this.subAgentsPaths = options.subAgentsPaths ?? [];
    this.skillsPaths = options.skillsPaths ?? [];
    this.toolsPaths = options.toolsPaths ?? [];
    this.mcpPaths = options.mcpPaths ?? [];

    this.builtinTools = [];
    this.userTools = [];
    this.subagents = [];
    this.skills = [];
    this.mcps = [];

    this.mcpManager = this.mcpPaths.length > 0 ? new McpConnectionManager() : undefined;
  }

  /**
   * 异步创建 Provider，一步完成构造 + 全局能力发现。
   */
  static async create(options: {
    config: AppConfig;
    agentsDir: string;
    subAgentsPaths?: string[];
    skillsPaths?: string[];
    toolsPaths?: string[];
    mcpPaths?: string[];
    /** 当前工作目录，默认 process.cwd() */
    cwd?: string;
  }): Promise<Provider> {
    const provider = new Provider(options);
    await provider.init();
    return provider;
  }

  /**
   * 初始化：执行全局能力发现。
   */
  async init(): Promise<void> {
    await this.refresh();
  }

  // ==================================================================
  // 能力过滤与实例化
  // ==================================================================

  /**
   * 按权限过滤候选集，返回过滤后的名称列表。
   * 纯名称操作（安全预过滤 + 权限过滤），不涉及 Tool 实例化。
   */
  filter(permissions: AgentPermissions, options?: {
    exclude?: ExcludeOptions;
  }): FilterOutput {
    const exclude = options?.exclude ?? {};
    const excludeTools = new Set(exclude.tools ?? []);
    const excludeSkills = new Set(exclude.skills ?? []);
    const excludeMcps = new Set(exclude.mcps ?? []);
    const excludeSubAgents = new Set(exclude.subagents ?? []);

    const safeSubagents = excludeSubAgents.size === 0
      ? this.subagents
      : this.subagents.filter(
          (def) => !excludeSubAgents.has(def.function?.name ?? ""),
        );

    const DYNAMIC_TOOL_NAMES = [
      "load_skill",
      "call_skill_sub_agent",
      "load_mcp",
      "call_mcp_tool",
      "read_mcp_resource",
    ];
    const toolNames = [
      ...this.builtinTools.map((t) => t.function.name),
      ...this.userTools.map((t) => t.function.name),
      ...DYNAMIC_TOOL_NAMES,
    ].filter((name) => !excludeTools.has(name));

    const evaluator = new PermissionEvaluator(permissions);
    const filtered = evaluator.filter({
      tools: toolNames,
      skills: this.skills
        .filter((s) => !excludeSkills.has(s.id))
        .map((s) => s.id),
      mcps: this.mcps
        .filter((m) => !excludeMcps.has(m.id))
        .map((m) => m.id),
      subagents: safeSubagents.map((d) => d.function!.name),
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
  buildTools(permissions: AgentPermissions, options?: {
    exclude?: ExcludeOptions;
  }): Tool[] {
    return this.instantiate(this.filter(permissions, options));
  }

  /**
   * 将过滤后的名称列表实例化为 Tool 数组。
   */
  instantiate(filtered: FilterOutput): Tool[] {
    const result: Tool[] = [];
    const allowedToolNames = new Set(filtered.tools);

    // 1. 内置 + 用户工具
    for (const t of [...this.builtinTools, ...this.userTools]) {
      if (allowedToolNames.has(t.function.name)) {
        result.push(t);
      }
    }

    // 2. 筛选候选项（保留完整信息，传给工具函数自行决定如何构建枚举）
    const allowedSkillSet = new Set(filtered.skills);
    const allowedMcpSet = new Set(filtered.mcps);
    const filteredSkills = this.skills.filter((s) => allowedSkillSet.has(s.id));
    const filteredMcps = this.mcps.filter((m) => allowedMcpSet.has(m.id));

    // 3. 动态工具
    if (allowedToolNames.has("load_skill") && filteredSkills.length > 0) {
      result.push(createLoadSkillTool(this.skillsPaths, filteredSkills));
    }
    // call_skill_sub_agent：只要有支持子 Agent 的 skill 就注册
    const hasSubAgentSkills = filteredSkills.some((s) => s.subAgent);
    if (allowedToolNames.has("call_skill_sub_agent") && hasSubAgentSkills) {
      result.push(createCallSkillSubAgentTool(this.skillsPaths, filteredSkills, this));
    }

    const mcpManager = this.mcpManager;
    if (allowedToolNames.has("load_mcp") && mcpManager && filteredMcps.length > 0) {
      result.push(createLoadMcpTool(mcpManager, filteredMcps));
    }
    if (allowedToolNames.has("call_mcp_tool") && mcpManager) {
      result.push(createCallMcpTool(mcpManager));
    }
    if (allowedToolNames.has("read_mcp_resource") && mcpManager) {
      result.push(createReadMcpResourceTool(mcpManager));
    }

    // 4. SubAgent
    const allowedSubagentSet = new Set(filtered.subagents);
    for (const def of this.subagents) {
      if (!def.function || !allowedSubagentSet.has(def.function.name)) continue;
      result.push(createSubAgentTool(def, this));
    }

    // 5. 去重
    return dedupTools(result);
  }

  /**
   * 重新执行全局发现（重新扫描文件系统）。
   */
  async refresh(options?: { silent?: boolean }): Promise<void> {
    const silent = options?.silent ?? false;
    this.builtinTools = discoverBuiltinTools(this.env);
    this.userTools = await discoverUserTools(this.toolsPaths, { silent });
    this.subagents = await discoverSubAgents(this.subAgentsPaths);
    this.skills = await discoverSkills(this.skillsPaths, { silent });
    this.mcps = await discoverMcpServers(this.mcpPaths);
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
