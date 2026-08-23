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

    // If the tool has a callback function
    if (this.callback) {
      // Execute the callback function, passing parsed args and the full ctx explicitly.
      result = await this.callback(ctx.parsedArgs, ctx);
    }

    // string 原样返回；内容块数组（图片/文件等）直接透传；
    // 其余值（对象/数字等）JSON 序列化后返回（undefined 归一为空串）。
    if (typeof result === "string") return result;
    if (Array.isArray(result)) return result as AgentNS.MessageContentSection[];
    return JSON.stringify(result) ?? "";
  }
}
