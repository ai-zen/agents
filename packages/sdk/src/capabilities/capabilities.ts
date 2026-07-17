import type { Tool } from "@ai-zen/agents-core";
import type { AgentDefinition, AgentPermissions } from "../types";
import type { DisclosureItem } from "./disclosure";
import type { Provider } from "../runtime/runtime";
import { buildDisclosureParam } from "./disclosure";
import { filterByPermissions } from "./permissions";
import { createLoadSkillTool, createCallSkillSubAgentTool } from "./implements/skill-tools";
import { createLoadMcpTool, createCallMcpTool, createReadMcpResourceTool } from "./implements/mcp-tools";
import { createSubAgentTool } from "./implements/sub-agents-tools";
import { discoverBuiltinTools } from "./discovery/builtin";
import { discoverSubAgents } from "./discovery/subagents";
import { discoverSkills } from "./discovery/skills";
import { discoverMcpServers } from "./discovery/mcp";
import { discoverUserTools } from "./discovery/usertools";

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

const EMPTY_HINT_SKILL = "（当前没有可用的 Skill，请联系用户添加）";
const EMPTY_HINT_MCP = "（当前没有可用的 MCP 服务器，请联系用户添加）";

/**
 * Capabilities — 全局能力注册表。
 *
 * 职责：
 *   1. 全局发现一次（扫描文件系统，收集所有候选）
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
  skills: DisclosureItem[];
  mcps: DisclosureItem[];

  constructor(provider: Provider) {
    this.provider = provider;

    // 初始化候选集
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
    /** 排除项黑名单（优先级高于 permissions）。 */
    exclude?: ExcludeOptions;
  }): FilterOutput {
    const exclude = options?.exclude ?? {};
    const excludeTools = new Set(exclude.tools ?? []);
    const excludeSkills = new Set(exclude.skills ?? []);
    const excludeMcps = new Set(exclude.mcps ?? []);
    const excludeSubAgents = new Set(exclude.subagents ?? []);

    // 1. 安全预过滤：从 SubAgent 候选集中剔除黑名单中的 agent
    const safeSubagents = excludeSubAgents.size === 0
      ? this.subagentDefs
      : this.subagentDefs.filter(
          (def) => !excludeSubAgents.has(def.function?.name ?? ""),
        );

    // 2. 拼装工具候选名称
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

    // 3. 权限过滤（纯名称匹配）
    const filtered = filterByPermissions(permissions, {
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
   * 适用于一次调用即可的场景，需要分别控制过滤和实例化时请使用 filter() + instantiate()。
   */
  buildTools(permissions: AgentPermissions, options?: {
    exclude?: ExcludeOptions;
  }): Tool[] {
    return this.instantiate(this.filter(permissions, options));
  }

  /**
   * 将过滤后的名称列表实例化为 Tool 数组。
   *
   * @param filtered  filter() 的输出
   * @returns         Tool 实例列表
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

    // 2. 构建枚举披露参数
    const allowedSkillSet = new Set(filtered.skills);
    const allowedMcpSet = new Set(filtered.mcps);
    const filteredSkills = this.skills.filter((s) => allowedSkillSet.has(s.id));
    const filteredMcps = this.mcps.filter((m) => allowedMcpSet.has(m.id));

    const skillDisclosure = buildDisclosureParam(
      filteredSkills,
      "选择一个 Skill",
      EMPTY_HINT_SKILL,
    );
    const mcpDisclosure = buildDisclosureParam(
      filteredMcps,
      "选择一个 MCP 服务器",
      EMPTY_HINT_MCP,
    );

    // 3. 动态工具（按条件注册）
    if (allowedToolNames.has("load_skill") && filteredSkills.length > 0) {
      result.push(createLoadSkillTool(provider.skillsPaths, skillDisclosure));
    }
    if (allowedToolNames.has("call_skill_sub_agent") && filteredSkills.length > 0) {
      result.push(createCallSkillSubAgentTool(provider.skillsPaths, skillDisclosure, this));
    }
    if (allowedToolNames.has("load_mcp") && provider.mcpManager && provider.mcpConfigs && filteredMcps.length > 0) {
      result.push(createLoadMcpTool(provider.mcpManager, provider.mcpConfigs, mcpDisclosure));
    }
    if (allowedToolNames.has("call_mcp_tool") && provider.mcpManager) {
      result.push(createCallMcpTool(provider.mcpManager));
    }
    if (allowedToolNames.has("read_mcp_resource") && provider.mcpManager) {
      result.push(createReadMcpResourceTool(provider.mcpManager));
    }

    // 4. SubAgent → createSubAgentTool（封装 AgentToolLazy）
    const allowedSubagentSet = new Set(filtered.subagents);
    for (const def of this.subagentDefs) {
      if (!def.function || !allowedSubagentSet.has(def.function.name)) continue;
      result.push(createSubAgentTool(def, this.provider, this));
    }

    // 5. 去重（后注册覆盖先注册）
    return dedupTools(result);
  }

  /**
   * 重新执行全局发现（重新扫描文件系统）。
   * 适用于运行时文件系统变更（新增/删除 skill、工具、SubAgent 等）。
   */
  refresh(): void {
    const provider = this.provider;
    this.builtinInstances = discoverBuiltinTools(provider.config);
    this.userInstances = discoverUserTools(provider.toolsPaths);
    this.subagentDefs = discoverSubAgents(provider.subAgentsPaths);
    this.skills = discoverSkills(provider.skillsPaths);
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
