import { AgentNS } from "../AgentNS.js";
import { PickRequired } from "../Common.js";
import { Tool } from "../Tool.js";
import { ToolCallContext } from "../ToolCallContext.js";

export class CallbackTool extends Tool {
  callback?: (parsed_args: any, ctx: ToolCallContext) => any;

  constructor(options: PickRequired<CallbackTool, "function" | "callback">) {
    super();
    this.function = options.function;
    this.type = options.type ?? "function";
    this.callback = options.callback;
  }

  async exec(ctx: ToolCallContext) {
    let result;

    // If the tool has a callback function
    if (this.callback) {
      // Execute the callback function, passing parsed args and the full ctx explicitly.
      result = await this.callback(ctx.parsed_args, ctx);
    }

    // If the result is already a string, return it as is. Otherwise, serialize it using JSON.stringify().
    // Note that even if the result is undefined, it is a valid value and still needs to be serialized before returning
    if (typeof result !== "string") {
      result = JSON.stringify(result) ?? "";
    }

    // Return the result
    return result;
  }
}
