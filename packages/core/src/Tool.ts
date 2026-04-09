import { AgentNS } from "./AgentNS.js";
import { PickRequired } from "./Common.js";
import { FunctionCallContext } from "./FunctionCallContext.js";

export abstract class Tool implements AgentNS.ToolDefine {
  type: "function";
  function: AgentNS.FunctionDefine;

  constructor(options: PickRequired<Tool, "function">) {
    if (!options.function) throw new Error("Tool must have a function");
    this.type = options.type ?? "function";
    this.function = options.function;
  }

  abstract exec(ctx: FunctionCallContext): Promise<string>;
}
