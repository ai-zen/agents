import OpenAI from "openai";
import { AgentNS } from "./AgentNS.js";
import { PickRequired } from "./Common.js";
import { Tool } from "./Tool.js";
import {
  DEFAULT_ABORTED_TOOL_ROUND_REASON,
  type AbortedToolRoundStrategy,
} from "./AbortedToolRounds.js";
import { type AbortedMessageStrategy } from "./AbortedMessages.js";

export interface UnknownToolContext {
  toolCall: AgentNS.ToolCall;
  availableTools: Tool[];
}

/**
 * AgentContext — 所有 Agent 的基类，持有核心配置。构造参数就是这些字段本身（`client` 与 `model` 必填）。
 *
 * 扩展方式是插件（`Agent.use(plugin)`）；本类只放配置，不放生命周期钩子。
 */
export class AgentContext {
  client: OpenAI;
  model: string;
  /** 展开进请求体；可含厂商特有字段（如 DeepSeek `thinking`），故是开放形状而不是固定字段 */
  modelConfig: Record<string, unknown>;
  messages: AgentNS.Message[];
  tools: Tool[];
  allowJsonParseError: boolean;
  /** 工具轮次被中断（或结果不完整）时的归一策略，默认 `fill`（`drop` 整轮丢弃 / `fill` 整轮补齐） */
  abortedToolRoundStrategy: AbortedToolRoundStrategy;
  /** `fill` 策略下，未完成工具结果的填充原因 */
  abortedToolRoundReason: string;
  /**
   * 被中断的 assistant 消息（已输出的内容 / 思考）是否保留，默认 `drop`。
   * 只管**不带工具调用**的消息；工具轮次由 `abortedToolRoundStrategy` 决定。
   */
  abortedMessageStrategy: AbortedMessageStrategy;

  constructor(options: PickRequired<AgentContext, "client" | "model">) {
    if (!options.client) throw new Error("AgentContext must have a client");
    if (!options.model) throw new Error("AgentContext must have a model");
    this.client = options.client;
    this.model = options.model;
    this.modelConfig = options.modelConfig ?? {};
    this.messages = options.messages ?? [];
    this.tools = options.tools ?? [];
    this.allowJsonParseError = options.allowJsonParseError ?? true;
    this.abortedToolRoundStrategy = options.abortedToolRoundStrategy ?? "fill";
    this.abortedToolRoundReason =
      options.abortedToolRoundReason ?? DEFAULT_ABORTED_TOOL_ROUND_REASON;
    this.abortedMessageStrategy = options.abortedMessageStrategy ?? "drop";
  }

  append(message: AgentNS.Message) {
    this.messages.push(message);
    return this.messages.at(-1)!;
  }
}
