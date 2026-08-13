import { AgentNS } from "./AgentNS.js";
import { PickRequired } from "./Common.js";
import { ChatCompletionModel } from "./Models/index.js";
import { Rag } from "./Rag.js";
import { Tool } from "./Tool.js";
import type { Agent } from "./Agent.js";
import type { ToolCallContext } from "./ToolCallContext.js";

export interface UnknownToolContext {
  toolCall: AgentNS.ToolCall;
  availableTools: Tool[];
}

export class AgentContext {
  model: ChatCompletionModel;
  model_config: any;
  messages: AgentNS.Message[];
  tools: Tool[];
  rag?: Rag;
  allowJsonParseError: boolean;
  /** 每次内循环开始调用的钩子，可用于刷新工具定义、RAG 等 */
  declare onInnerLoopStart?: () => Promise<void> | void;
  /** 每次内循环结束调用的钩子，可用于后处理 */
  declare onInnerLoopEnd?: () => Promise<void> | void;
  /** 整组内循环（一次 send，含多轮工具调用）开始前调用的钩子 */
  declare onInnerLoopsStart?: () => Promise<void> | void;
  /** 整组内循环（一次 send，含多轮工具调用）结束后调用的钩子 */
  declare onInnerLoopsEnd?: () => Promise<void> | void;
  /**
   * 当 LLM 调用一个未注册的工具时触发。
   * 返回的字符串将作为工具执行结果返回给 LLM。
   * 不设置则使用默认提示。
   */
  declare onUnknownTool?: (ctx: UnknownToolContext) => string | Promise<string>;
  /**
   * 工具调用前钩子（阻塞式）：每个工具调用执行前触发，可**拒绝**单个工具调用。
   * 返回字符串 = 拒绝执行，该字符串（拒绝原因）作为工具结果返回给 LLM；
   * 返回 undefined = 允许执行。
   * 与 Tool.exec(ctx) 收同一个 ToolCallContext 实例（一个类贯穿拦截决策 → 执行）。
   */
  declare onToolCall?: (
    ctx: ToolCallContext,
  ) => string | undefined | Promise<string | undefined>;

  constructor(options: PickRequired<AgentContext, "model">) {
    if (!options.model) throw new Error("AgentContext must have a model");
    this.model = options.model;
    this.model_config = options.model_config ?? {};
    this.messages = options.messages ?? [];
    this.tools = options.tools ?? [];
    this.rag = options.rag;
    this.allowJsonParseError = options.allowJsonParseError ?? true;
    if (options.onInnerLoopStart !== undefined) this.onInnerLoopStart = options.onInnerLoopStart;
    if (options.onInnerLoopEnd !== undefined) this.onInnerLoopEnd = options.onInnerLoopEnd;
    if (options.onInnerLoopsStart !== undefined) this.onInnerLoopsStart = options.onInnerLoopsStart;
    if (options.onInnerLoopsEnd !== undefined) this.onInnerLoopsEnd = options.onInnerLoopsEnd;
    if (options.onUnknownTool !== undefined) this.onUnknownTool = options.onUnknownTool;
    if (options.onToolCall !== undefined) this.onToolCall = options.onToolCall;
  }

  /**
   * Add a message to the message list.
   */
  append(message: AgentNS.Message) {
    this.messages.push(message);
    return this.messages.at(-1)!;
  }
}
