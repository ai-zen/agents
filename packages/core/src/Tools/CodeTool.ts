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

  async exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent> {
    let result;

    // If the tool has code
    if (this.code) {
      // Construct a new parameter object based on the function parameters definition
      // Make sure that the parameter object does not have any missing keys, as missing keys may cause "x is not defined" errors during execution
      const wideArgs = Object.fromEntries(
        Object.keys(this.function.parameters.properties!).map((key) => [
          key,
          ctx.parsedArgs[key],
        ])
      );

      // Create a new function and execute it
      const fun = new Function(...Object.keys(wideArgs), this.code);
      result = await fun.call(ctx, ...Object.values(wideArgs));
    }

    // string 原样返回；内容块数组透传；其余值 JSON 序列化（undefined 归一为空串）。
    if (typeof result === "string") return result;
    if (Array.isArray(result)) return result as AgentNS.MessageContentSection[];
    return JSON.stringify(result) ?? "";
  }
}
