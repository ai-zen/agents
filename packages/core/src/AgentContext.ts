import OpenAI from "openai";
import { AgentNS } from "./AgentNS.js";
import { PickRequired } from "./Common.js";
import { Tool } from "./Tool.js";
import {
  DEFAULT_ABORTED_TOOL_ROUND_REASON,
  type AbortedToolRoundStrategy,
} from "./AbortedToolRounds.js";
import { type AbortedMessageStrategy } from "./AbortedMessages.js";
import { generateMessageId } from "./Message.js";

/**
 * 「模型调了个不存在的工具」的上下文（`onUnknownTool` 钩子的入参）。
 *
 * `toolCall` 是**原始的那一次调用**（不是 `ToolCallContext`：那一份的存在前提是
 * 「匹配到了一个工具实现」，而这里恰恰是没有）。`availableTools` 是**这个 agent 当时
 * 全部可用的工具**，给全了才够用：插件要靠它判断「某个工具在不在」（例如
 * `call_mcp_tool` 是否被权限禁掉），从而决定怎么引导模型。
 *
 * 为什么不给 `agent` 让插件自己去 `agent.tools` 里取：这个钩子要读的就这两样，
 * 「可用工具」在派发那一刻就是**已知答案**，让每个插件各取一次只会多出一条「忘了取」的路径。
 */
export interface UnknownToolContext {
  /** 模型调用的那一次工具调用（`function.name` 就是它要的、却不存在的工具名） */
  toolCall: AgentNS.ToolCall;
  /** 当时全部可用的工具（与 `agent.tools` 同源，派发时取值） */
  availableTools: Tool[];
}

/**
 * AgentContext — 所有 Agent 的基类，只放**构造期**就定下来的配置。可变的运行状态全在 `Agent`
 * 里；扩展方式是插件（`Agent.use`）与钩子（`CORE.md` §11）。
 */
export class AgentContext {
  /**
   * 身份，从外面给。core 只拿它写错误消息与日志，**不参与任何逻辑**。
   */
  id: string;
  client: OpenAI;
  model: string;
  /** 展开进请求体；可含厂商特有字段（如 DeepSeek `thinking`），故是开放形状而不是固定字段 */
  modelConfig: Record<string, unknown>;
  messages: AgentNS.Message[];
  tools: Tool[];
  /** 工具轮次被中断（或结果不完整）时的归一策略，默认 `fill`（`drop` 整轮丢弃 / `fill` 整轮补齐） */
  abortedToolRoundStrategy: AbortedToolRoundStrategy;
  /** `fill` 策略下，未完成工具结果的填充原因 */
  abortedToolRoundReason: string;
  /**
   * 被中断的 assistant 消息（已输出的内容 / 思考）是否保留，默认 `drop`。
   * 只管**不带工具调用**的消息；工具轮次由 `abortedToolRoundStrategy` 决定。
   */
  abortedMessageStrategy: AbortedMessageStrategy;
  /**
   * 寿命：常驻还是只用一次（语义见 `AgentNS.AgentLifetime`）。
   *
   * 默认 `resident` —— 它是能力更大的那个；想要「跑完即终结」需要显式声明。
   */
  lifetime: AgentNS.AgentLifetime;
  /**
   * 造消息 id 的唯一来源。AgentDefinition 占位、投递时没给 id 的 InboxEntry，都问它。
   *
   * 从外面注入的好处：宿主想让 id 与自己的库对齐（或测试里要可预测），
   * 不必改 core；core 也不需要知道 id 长什么样。
   */
  newMessageId: () => string;

  constructor(options: PickRequired<AgentContext, "client" | "model">) {
    if (!options.client) throw new Error("AgentContext must have a client");
    if (!options.model) throw new Error("AgentContext must have a model");
    this.client = options.client;
    this.model = options.model;
    this.lifetime = options.lifetime ?? "resident";
    this.newMessageId = options.newMessageId ?? generateMessageId;
    this.id = options.id ?? this.newMessageId();
    this.modelConfig = options.modelConfig ?? {};
    this.messages = options.messages ?? [];
    this.tools = options.tools ?? [];
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
