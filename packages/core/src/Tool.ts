import { AgentNS } from "./AgentNS.js";
import { ToolCallContext } from "./ToolCallContext.js";

/**
 * 工具抽象基类。
 *
 * 工具定义（`type` / `function`）由子类通过类体或构造函数自行赋值，基类不在构造函数里强制传入。
 *
 * `exec` 的返回值是给模型的内容：文本结果给 string；要返回图片、文件这类内容时给内容块数组（如
 * `[{ type: "image_url", image_url: { url } }]`）。
 */
export abstract class Tool implements AgentNS.ToolDefine {
  type: "function" = "function";
  declare function: AgentNS.FunctionDefine;

  abstract exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent>;
}
