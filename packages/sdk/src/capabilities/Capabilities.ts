import type { Tool } from "@ai-zen/agents-core";
import type { AgentDefinition, AgentPermissions, McpServerConfig } from "../types/index.js";
import type { SkillInfo } from "./discovery/skills.js";
import type { Provider } from "../runtime/Provider.js";
import { PermissionEvaluator } from "./PermissionEvaluator.js";
import { createLoadSkillTool, createCallSkillSubAgentTool } from "./implements/skillTools.js";
import { createLoadMcpTool, createCallMcpTool, createReadMcpResourceTool } from "./implements/mcpTools.js";
import { createSubAgentTool } from "./implements/subAgentTools.js";
import { discoverBuiltinTools } from "./discovery/builtin.js";
import { discoverSubAgents } from "./discovery/subagents.js";
import { discoverSkills } from "./discovery/skills.js";
import { discoverMcpServers } from "./discovery/mcp.js";
import { discoverUserTools } from "./discovery/usertools.js";

/**
 * 能力过滤系统的公共类型。
 * FilterOutput 由 Capabilities.filter() 产出，由 Capabilities.instantiate() 消费。
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
 * Capabilities — 全局能力注册表。
 *
 * 职责：
 *   1. 全局发现一次（扫描文件系统，收集所有完整候选）
 *   2. 提供 filter(permissions) 按权限过滤
 *   3. 提供 instantiate(filterOutput) 将过滤后的名称实例化为 Tool[]
 *
 * 设计原则：
 *   - 发现结果全局共享，SubAgent 复用同一份候选集
 *   - filter 是纯函数（名称匹配），可被任意 Agent 独立调用
 *   - instantiate 是纯映射（名称→实例），不含业务逻辑
 *   - 通过持有的 Provider 实例获取配置、路径、模型工厂等全局服务
 */
export class Capabilities {
  /** Provider 全局上下文 */
  readonly provider: Provider;

  // ---- 全局候选集（发现一次，全局复用）----
  builtinInstances: Tool[];
  userInstances: Tool[];
  subagentDefs: AgentDefinition[];
  /** 完整 SkillInfo，含 subAgent 标记，可据此区分枚举 */
  skills: SkillInfo[];
  /** 完整 MCP 服务器配置 */
  mcps: McpServerConfig[];

  constructor(provider: Provider) {
    this.provider = provider;

    this.builtinInstances = discoverBuiltinTools(provider.config);
    this.userInstances = discoverUserTools(provider.toolsPaths);
    this.subagentDefs = discoverSubAgents(provider.subAgentsPaths);
    this.skills = discoverSkills(provider.skillsPaths);
    this.mcps = discoverMcpServers(provider.mcpPaths);
  }

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
      ? this.subagentDefs
      : this.subagentDefs.filter(
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
      ...this.builtinInstances.map((t) => t.function.name),
      ...this.userInstances.map((t) => t.function.name),
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
    const provider = this.provider;

    // 1. 内置 + 用户工具
    for (const t of [...this.builtinInstances, ...this.userInstances]) {
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
      result.push(createLoadSkillTool(provider.skillsPaths, filteredSkills));
    }
    // call_skill_sub_agent：只要有支持子 Agent 的 skill 就注册
    const hasSubAgentSkills = filteredSkills.some((s) => s.subAgent);
    if (allowedToolNames.has("call_skill_sub_agent") && hasSubAgentSkills) {
      result.push(createCallSkillSubAgentTool(provider.skillsPaths, filteredSkills, this));
    }

    const mcpManager = provider.getMcpManager();
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
    for (const def of this.subagentDefs) {
      if (!def.function || !allowedSubagentSet.has(def.function.name)) continue;
      result.push(createSubAgentTool(def, this.provider, this));
    }

    // 5. 去重
    return dedupTools(result);
  }

  /**
   * 重新执行全局发现（重新扫描文件系统）。
   */
  refresh(options?: { silent?: boolean }): void {
    const silent = options?.silent ?? false;
    const provider = this.provider;
    this.builtinInstances = discoverBuiltinTools(provider.config);
    this.userInstances = discoverUserTools(provider.toolsPaths, { silent });
    this.subagentDefs = discoverSubAgents(provider.subAgentsPaths);
    this.skills = discoverSkills(provider.skillsPaths, { silent });
    this.mcps = discoverMcpServers(provider.mcpPaths);
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
