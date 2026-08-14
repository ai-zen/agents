import { AgentNS } from "../AgentNS.js";
import { PickRequired } from "../Common.js";
import { Tool } from "../Tool.js";
import { ToolCallContext } from "../ToolCallContext.js";

/**
 * @deprecated 已废弃。
 *
 * CodeTool 通过字符串代码（new Function）定义工具逻辑，存在以下问题：
 *   - 字符串代码缺少类型安全与静态检查，难以维护；
 *   - 依赖函数签名与参数定义的隐式对应，易出错；
 *   - 与 CallbackTool / AgentTool 等类型安全的方式不一致。
 *
 * 建议改用 CallbackTool（闭包回调，类型安全）或自定义 Tool 子类。
 * 为保持向后兼容，本类暂不删除，仅做废弃标记。
 */
export class CodeTool implements Tool {
  type: "function";
  function: AgentNS.FunctionDefine;
  code?: string;

  constructor(options: PickRequired<CodeTool, "function" | "code">) {
    if (!options.function) throw new Error("CodeTool must have a function");
    this.type = options.type ?? "function";
    this.function = options.function;
    this.code = options.code;
  }

  async exec(ctx: ToolCallContext) {
    let result;

    // If the tool has code
    if (this.code) {
      // Construct a new parameter object based on the function parameters definition
      // Make sure that the parameter object does not have any missing keys, as missing keys may cause "x is not defined" errors during execution
      const wideArgs = Object.fromEntries(
        Object.keys(this.function.parameters.properties!).map((key) => [
          key,
          ctx.parsed_args[key],
        ])
      );

      // Create a new function and execute it
      const fun = new Function(...Object.keys(wideArgs), this.code);
      result = await fun.call(ctx, ...Object.values(wideArgs));
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
