import { AgentNS } from "./AgentNS.js";
import { PickRequired } from "./Common.js";
import { ToolCallContext } from "./ToolCallContext.js";

export abstract class Tool implements AgentNS.ToolDefine {
  type: "function";
  function: AgentNS.FunctionDefine;

  constructor(options: PickRequired<Tool, "function">) {
    if (!options.function) throw new Error("Tool must have a function");
    this.type = options.type ?? "function";
    this.function = options.function;
  }

  abstract exec(ctx: ToolCallContext): Promise<string>;
}
