import { AgentNS } from "../AgentNS.js";
import { PickRequired } from "../Common.js";
import { Tool } from "../Tool.js";
import { ToolCallContext } from "../ToolCallContext.js";

export class CallbackTool extends Tool {
  callback?: (parsedArgs: any, ctx: ToolCallContext) => any;

  constructor(options: PickRequired<CallbackTool, "function" | "callback">) {
    super();
    this.function = options.function;
    this.type = options.type ?? "function";
    this.callback = options.callback;
  }

  async exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent> {
    let result;

    if (this.callback) {
      // 回调拿到解析后的参数与完整 ctx：要 agent / signal / 那条工具调用都不必另存闭包
      result = await this.callback(ctx.parsedArgs, ctx);
    }

    if (typeof result === "string") return result;
    if (Array.isArray(result)) return result as AgentNS.MessageContentSection[];
    return JSON.stringify(result) ?? "";
  }
}
