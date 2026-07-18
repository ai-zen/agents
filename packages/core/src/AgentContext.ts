import { AgentNS } from "./AgentNS.js";
import { PickRequired } from "./Common.js";
import { ChatCompletionModel } from "./Models/index.js";
import { Rag } from "./Rag.js";
import { Tool } from "./Tool.js";

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
  }

  /**
   * Add a message to the message list.
   */
  append(message: AgentNS.Message) {
    this.messages.push(message);
    return this.messages.at(-1)!;
  }
}
