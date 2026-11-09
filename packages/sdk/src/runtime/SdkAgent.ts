import type OpenAI from "openai";
import { Agent } from "@ai-zen/agents-core";
import type {
  AbortedMessageStrategy,
  AbortedToolRoundStrategy,
  AgentNS,
  Tool,
} from "@ai-zen/agents-core";
import type { AgentDefinition } from "../types/index.js";
import type { Scope } from "../scope/Scope.js";
import type { ModelLevel } from "./resolveModel.js";

// 插件机制已提升到 core：重新导出，SDK 现有 import 来源保持可用
export type { AgentPlugin, SendContext } from "@ai-zen/agents-core";

/**
 * SDK Agent — 继承 Core Agent，携带 SDK 层额外信息。
 *
 * Core Agent 不感知权限、文件系统等业务逻辑；
 * SdkAgent 在 Core Agent 基础上增加了 SDK 层需要的元数据：
 *   - scope：全局 Scope 实例
 *   - definition：Agent 定义（含权限 permissions）。**模型解析生效之后的那一份**：
 *     会话级覆盖会写进它的 `modelId`（见 `createAgent`），于是「读哪个字段都不会跑偏」；
 *   - modelLevel：这个模型是从哪一级解析出来的（会话 / Agent 定义 / 全局兜底）。
 *     值是 `resolveModel` 的副产品，客户端用它把「当前生效档」标在 `/model` 选择器上。
 *
 * 插件能力（use / init / send 钩子分发）继承自 Core Agent，此处不再重复实现。
 * 未知工具的 MCP 智能提示由独立插件 `UnknownToolHintPlugin` 提供（调用方显式 use）。
 * 权限统一从 `definition.permissions` 读取，不再单独持有。
 */
export class SdkAgent extends Agent {
  /** 全局 Scope 实例 */
  readonly scope: Scope;
  /** Agent 定义（模型解析生效之后的那一份：`modelId` 是**实际在用**的模型） */
  readonly definition: AgentDefinition;
  /** 生效模型来自哪一级（三级解析的结果，见 `resolveModel`） */
  readonly modelLevel: ModelLevel;

  constructor(params: {
    scope: Scope;
    definition: AgentDefinition;
    modelLevel: ModelLevel;
    client: OpenAI;
    model: string;
    modelConfig?: Record<string, unknown>;
    messages?: AgentNS.Message[];
    tools?: Tool[];
    allowJsonParseError?: boolean;
    /** 工具轮次被中断时的归一策略（core 默认 `fill`） */
    abortedToolRoundStrategy?: AbortedToolRoundStrategy;
    /** `fill` 策略下未完成工具结果的填充原因 */
    abortedToolRoundReason?: string;
    /** 被中断的 assistant（内容/思考）是否保留（core 默认 `drop`） */
    abortedMessageStrategy?: AbortedMessageStrategy;
  }) {
    super({
      client: params.client,
      model: params.model,
      modelConfig: params.modelConfig,
      messages: params.messages,
      tools: params.tools,
      allowJsonParseError: params.allowJsonParseError,
      abortedToolRoundStrategy: params.abortedToolRoundStrategy,
      abortedToolRoundReason: params.abortedToolRoundReason,
      abortedMessageStrategy: params.abortedMessageStrategy,
    });
    this.scope = params.scope;
    this.definition = params.definition;
    this.modelLevel = params.modelLevel;
  }
}
