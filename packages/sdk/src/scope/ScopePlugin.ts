import type { Tool } from "@ai-zen/agents-core";
import type { AgentDefinition } from "../types/index.js";
import type { Scope, FilterOutput } from "./Scope.js";

/**
 * 插件向四维权限体系贡献的候选名称（任意子集）。
 */
export interface ScopeCandidates {
  tools?: string[];
  skills?: string[];
  mcps?: string[];
  subagents?: string[];
}

/**
 * ScopePlugin — 能力插件契约（v1 核心扩展点）。
 *
 * 一个插件**自持一类能力**的完整生命周期：自己发现、自己持有发现结果、
 * 自己声明候选名、自己按过滤结果实例化工具、自己负责释放。
 * `Scope` 只做编排，不感知任何具体能力的发现状态。
 *
 * 与 `AgentPlugin`（core，挂在 Agent 运行时 send/loop/toolcall）不同，
 * `ScopePlugin` 挂在**能力装配管线**（discover/filter/instantiate）。二者互不相关。
 *
 * 生命周期与三阶段管线的对应：
 *   discover     —— 阶段 1 · 发现
 *   candidates   —— 阶段 2 · 候选（供权限过滤）
 *   instantiate  —— 阶段 3 · 实例化
 *   dispose      —— 释放
 */
export interface ScopePlugin {
  /** 唯一标识，如 "builtin" / "user-tools" / "skills" / "mcp" / "subagents" */
  readonly id: string;

  /**
   * 阶段 1 · 发现：扫描来源、刷新自身状态（每次内部重新扫描，不跨 refresh 累积）。
   * 相对路径应在此基于 `scope.cwd` 解析。
   */
  discover?(scope: Scope, options: { silent?: boolean }): Promise<void> | void;

  /**
   * 阶段 2 · 候选：返回本插件向四维贡献的候选名。
   * 可结合 `definition` 做可用性判断（如内置工具的 isAvailable）。同步返回。
   */
  candidates(scope: Scope, definition: AgentDefinition): ScopeCandidates;

  /**
   * 阶段 3 · 实例化：按过滤后的允许名产出 Tool 实例。
   * `filtered` 为 `Scope.filter()` 的产物（四维允许名）。
   */
  instantiate(scope: Scope, filtered: FilterOutput): Tool[];

  /** 可选 · 释放：逆序于注册顺序调用。如 MCP 断开所有连接。 */
  dispose?(): Promise<void> | void;
}
