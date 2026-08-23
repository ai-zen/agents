import OpenAI from "openai";
import { AgentNS } from "./AgentNS.js";
import { PickRequired } from "./Common.js";
import { Tool } from "./Tool.js";

export interface UnknownToolContext {
  toolCall: AgentNS.ToolCall;
  availableTools: Tool[];
}

/**
 * AgentContext — 所有 Agent 的基类，持有核心配置。
 *
 * 构造签名：`{ client, model, modelConfig?, messages?, tools?, allowJsonParseError? }`
 * - `client`：openai 官方 SDK 实例（提供与 LLM API 的连接）
 * - `model`：发送给 API 的模型名
 * - `modelConfig`：模型参数（temperature 等），透传给 API；可含厂商特有字段（如 DeepSeek `thinking`）
 *
 * 扩展方式：通过 `Agent.use(plugin)` 注册插件，不再提供 onXxx 构造钩子。
 */
export class AgentContext {
  /** openai 官方 SDK 客户端 */
  client: OpenAI;
  /** 发送给 API 的模型名 */
  model: string;
  /** 模型参数，透传给 API（含厂商特有字段） */
  modelConfig: Record<string, unknown>;
  messages: AgentNS.Message[];
  tools: Tool[];
  allowJsonParseError: boolean;

  constructor(options: PickRequired<AgentContext, "client" | "model">) {
    if (!options.client) throw new Error("AgentContext must have a client");
    if (!options.model) throw new Error("AgentContext must have a model");
    this.client = options.client;
    this.model = options.model;
    this.modelConfig = options.modelConfig ?? {};
    this.messages = options.messages ?? [];
    this.tools = options.tools ?? [];
    this.allowJsonParseError = options.allowJsonParseError ?? true;
  }

  /**
   * Add a message to the message list.
   */
  append(message: AgentNS.Message) {
    this.messages.push(message);
    return this.messages.at(-1)!;
  }
}
