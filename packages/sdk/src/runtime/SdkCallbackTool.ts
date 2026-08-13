import path from "node:path";
import { Tool, ToolCallContext } from "@ai-zen/agents-core";
import type { AgentNS } from "@ai-zen/agents-core";
import type { ToolEnv } from "../types/index.js";

/**
 * SdkCallbackTool — SDK 内置工具基类。
 *
 * 环境（ToolEnv）在构造时注入，工具逻辑在子类的 call() 中实现，
 * 不再依赖全局 process.cwd()，也不需要在运行时反查 Agent 上下文。
 *
 * 设计原则：
 *   - 一个工具一个类，文件名 = 类名（PascalCase）
 *   - 依赖环境（cwd、config）通过构造参数显式注入
 *   - 相对路径统一用 resolve() 解析到 env.cwd
 */
export abstract class SdkCallbackTool extends Tool {
  /** 注入的工具环境 */
  readonly env: ToolEnv;

  constructor(options: { function: AgentNS.FunctionDefine; env: ToolEnv }) {
    super({ function: options.function });
    this.env = options.env;
  }

  /** 工具核心逻辑（由子类实现，参数为 parsed_args） */
  abstract call(input: unknown): unknown | Promise<unknown>;

  /** 桥接 core 的 Tool.exec：解析参数 → call → 序列化 */
  async exec(ctx: ToolCallContext): Promise<string> {
    const result = await this.call(ctx.parsed_args);
    if (typeof result === "string") return result;
    // JSON.stringify(undefined) 返回 undefined（非字符串），会破坏 Promise<string> 契约
    return JSON.stringify(result) ?? "";
  }

  /** 将相对路径解析到 env.cwd，绝对路径原样返回 */
  resolve(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.env.cwd, p);
  }
}
