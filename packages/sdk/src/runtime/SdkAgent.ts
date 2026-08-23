import type OpenAI from "openai";
import { Agent } from "@ai-zen/agents-core";
import type { AgentNS, Tool } from "@ai-zen/agents-core";
import type { AgentDefinition } from "../types/index.js";
import type { Provider } from "./Provider.js";

// 插件机制已提升到 core：重新导出，SDK 现有 import 来源保持可用
export type { AgentPlugin, SendContext } from "@ai-zen/agents-core";

/**
 * SDK Agent — 继承 Core Agent，携带 SDK 层额外信息。
 *
 * Core Agent 不感知权限、文件系统等业务逻辑；
 * SdkAgent 在 Core Agent 基础上增加了 SDK 层需要的元数据：
 *   - provider：全局 Provider 实例
 *   - definition：Agent 原始定义（含权限 permissions）
 *
 * 插件能力（use / init / send 钩子分发）继承自 Core Agent，此处不再重复实现。
 * 未知工具的 MCP 智能提示由独立插件 `UnknownToolHintPlugin` 提供（调用方显式 use）。
 * 权限统一从 `definition.permissions` 读取，不再单独持有。
 */
export class SdkAgent extends Agent {
  /** 全局 Provider 实例 */
  readonly provider: Provider;
  /** Agent 原始定义 */
  readonly definition: AgentDefinition;

  constructor(params: {
    provider: Provider;
    definition: AgentDefinition;
    client: OpenAI;
    model: string;
    modelConfig?: Record<string, unknown>;
    messages?: AgentNS.Message[];
    tools?: Tool[];
    allowJsonParseError?: boolean;
  }) {
    super({
      client: params.client,
      model: params.model,
      modelConfig: params.modelConfig,
      messages: params.messages,
      tools: params.tools,
      allowJsonParseError: params.allowJsonParseError,
    });
    this.provider = params.provider;
    this.definition = params.definition;
  }
}
