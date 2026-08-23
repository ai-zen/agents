import { AgentNS } from "./AgentNS.js";
import { ToolCallContext } from "./ToolCallContext.js";

/**
 * Tool — 工具抽象基类。
 *
 * 工具定义（function / type）由子类通过类体或构造函数自行赋值，
 * 基类不通过构造函数强制传入。子类必须实现 exec(ctx)。
 *
 * exec 返回类型为 `AgentNS.MessageContent`（string 或内容块数组）：
 * 文本结果返回 string；需要向模型返回图片/文件等内容时，
 * 返回内容块数组（如 `[{ type: "image_url", image_url: { url } }]`）。
 */
export abstract class Tool implements AgentNS.ToolDefine {
  type: "function" = "function";
  /** 工具定义。由子类赋值（类体字段或构造内 this.function = ...）。 */
  declare function: AgentNS.FunctionDefine;

  abstract exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent>;
}
