import { AgentNS } from "../AgentNS.js";
import { PickRequired } from "../Common.js";
import { Tool } from "../Tool.js";
import { FunctionCallContext } from "../FunctionCallContext.js";

export class CallbackTool implements Tool {
  type: "function";
  function: AgentNS.FunctionDefine;
  callback?: (this: FunctionCallContext, parsed_args: any) => any;

  constructor(options: PickRequired<CallbackTool, "function" | "callback">) {
    if (!options.function) throw new Error("CallbackTool must have a function");
    this.type = options.type ?? "function";
    this.function = options.function;
    this.callback = options.callback;
  }

  async exec(ctx: FunctionCallContext) {
    let result;

    // If the tool has a callback function
    if (this.callback) {
      // Execute the callback function
      result = await this.callback.call(ctx, ctx.parsed_args);
    }

    // If the result is already a string, return it as is. Otherwise, serialize it using JSON.stringify().
    // Note that even if the result is undefined, it is a valid value and still needs to be serialized before returning
    if (typeof result !== "string") {
      result = JSON.stringify(result);
    }

    // Return the result
    return result;
  }
}
