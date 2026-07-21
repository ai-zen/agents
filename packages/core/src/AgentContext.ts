import { AgentNS } from "./AgentNS.js";
import { PickRequired } from "./Common.js";
import { ChatCompletionModel } from "./Models/index.js";
import { Rag } from "./Rag.js";
import { Tool } from "./Tool.js";

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
  onInnerLoopStart?: () => Promise<void> | void;
  /** 每次内循环结束调用的钩子，可用于后处理 */
  onInnerLoopEnd?: () => Promise<void> | void;
  /**
   * 当 LLM 调用一个未注册的工具时触发。
   * 返回的字符串将作为工具执行结果返回给 LLM。
   * 不设置则使用默认提示。
   */
  onUnknownTool?: (ctx: UnknownToolContext) => string | Promise<string>;

  constructor(options: PickRequired<AgentContext, "model">) {
    if (!options.model) throw new Error("AgentContext must have a model");
    this.model = options.model;
    this.model_config = options.model_config ?? {};
    this.messages = options.messages ?? [];
    this.tools = options.tools ?? [];
    this.rag = options.rag;
    this.allowJsonParseError = options.allowJsonParseError ?? true;
    this.onInnerLoopStart = options.onInnerLoopStart;
    this.onInnerLoopEnd = options.onInnerLoopEnd;
    this.onUnknownTool = options.onUnknownTool;
  }

  /**
   * Add a message to the message list.
   */
  append(message: AgentNS.Message) {
    this.messages.push(message);
    return this.messages.at(-1)!;
  }
}
