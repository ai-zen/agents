import { Agent, type ChatCompletionModel } from "@ai-zen/agents-core";
import type { AgentNS, Tool } from "@ai-zen/agents-core";
import type { AgentDefinition, AgentPermissions } from "../types";
import type { Capabilities } from "../capabilities/capabilities";
import type { Runtime } from "./runtime";

/**
 * SDK Agent — 继承 Core Agent，携带 SDK 层额外信息。
 *
 * Core Agent 不做复杂逻辑（不感知权限、不感知文件系统），
 * SdkAgent 在 Core Agent 基础上增加了 SDK 层需要的元数据，
 * 并通过 runtime 字段访问全局上下文。
 *
 * 携带：
 *   - runtime：全局 Runtime 实例
 *   - definition：Agent 原始定义
 *   - permissions：Agent 权限，供 call_skill_sub_agent 等回调读取
 *   - caps：Capabilities 全局注册表，供 refreshTools 刷新工具列表
 */
export class SdkAgent extends Agent {
  /** 全局 Runtime 实例 */
  readonly runtime: Runtime;
  /** Agent 原始定义 */
  readonly definition: AgentDefinition;
  /** Agent 权限 */
  readonly permissions?: AgentPermissions;
  /** Capabilities 全局注册表，用于运行时刷新工具列表 */
  readonly caps?: Capabilities;

  constructor(params: {
    runtime: Runtime;
    definition: AgentDefinition;
    model: ChatCompletionModel;
    model_config?: Record<string, unknown>;
    messages?: AgentNS.Message[];
    tools?: Tool[];
    permissions?: AgentPermissions;
    caps?: Capabilities;
    rag?: any;
    allowJsonParseError?: boolean;
    onBeforeSend?: () => void;
  }) {
    super({
      model: params.model,
      model_config: params.model_config,
      messages: params.messages,
      tools: params.tools,
      rag: params.rag,
      allowJsonParseError: params.allowJsonParseError,
      onBeforeSend: params.onBeforeSend,
    });
    this.runtime = params.runtime;
    this.definition = params.definition;
    this.permissions = params.permissions;
    this.caps = params.caps;
  }
}
