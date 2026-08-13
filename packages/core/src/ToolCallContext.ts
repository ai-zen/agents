import type { Agent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import type { Tool } from "./Tool.js";

/**
 * 工具调用上下文 —— 一个类贯穿「拦截决策 → 执行」。
 *
 * 同一个实例既传给 onToolCall 钩子（执行前拦截决策），也传给 Tool.exec(ctx)（真正执行）。
 *
 * - tool_call：统一形状的工具调用（tool_calls 格式；旧版 function_call 已包装为无 id 的 tool_call）
 * - function_call：兼容字段，等价于 tool_call.function（旧工具实现仍可使用）
 * - parsed_args / parse_error：由 tool_call.function.arguments JSON 解析而来
 * - signal：工具执行的中止信号（abort 时触发；工具实现可监听以真正中断执行）
 */
export class ToolCallContext {
  /** 当前 agent（可读权限、上下文、模型等；子 Agent 工具可借此访问父 Agent） */
  agent: Agent;

  /**
   * 统一形状的工具调用（含 name + 参数）。
   * tool_calls 格式：`{ id?, type?, function: { name, arguments } }`；
   * 旧版 function_call 已包装为无 id / type 的 `{ function }` 形状。
   */
  tool_call: AgentNS.ToolCall;

  /** 匹配到的已注册工具（未注册则为 undefined，将走 onUnknownTool / 默认未知提示） */
  tool?: Tool;

  /**
   * 兼容字段：等价于 tool_call.function（旧版 function_call 形状）。
   * 旧工具实现（如 callback 里访问 this.function_call.name）仍可直接使用。
   */
  function_call: AgentNS.FunctionCall;

  /**
   * 已解析的工具参数（由 tool_call.function.arguments JSON 解析而来）。
   * 解析失败且 allowJsonParseError=true 时为 undefined（此时 parse_error 有值）；
   * 参数为空/非法且 allowJsonParseError=false 时构造函数直接抛错。
   */
  parsed_args: any;

  /**
   * 本次工具调用对应的工具结果消息。
   * 工具执行结果 / 拒绝原因 / 参数解析错误等都会写入其中，最终作为 Tool 结果回给 LLM。
   */
  result_message: AgentNS.Message;

  /**
   * 是否阻止下一轮对话。
   * 通常通过 preventDefault() 置为 true（如工具需要等待用户确认的场景）。
   */
  is_prevent_default = false;

  /**
   * 参数 JSON 解析错误信息。
   * 仅当 allowJsonParseError=true 且解析失败时存在；此时 parsed_args 为 undefined，
   * 错误信息会作为工具结果返回给 LLM 让其修正参数。
   */
  parse_error?: string;

  /**
   * 工具执行的中止信号。
   * abort() 会中止对应任务 → 触发此 signal → 工具实现可监听 signal 以真正中断执行。
   */
  signal?: AbortSignal;

  constructor(options: {
    agent: Agent;
    tool_call: AgentNS.ToolCall;
    tool?: Tool;
    result_message: AgentNS.Message;
    allowJsonParseError?: boolean;
    signal?: AbortSignal;
  }) {
    this.agent = options.agent;
    this.tool_call = options.tool_call;
    this.tool = options.tool;
    this.function_call = options.tool_call.function ?? {};
    this.result_message = options.result_message;
    this.signal = options.signal;

    if (this.function_call.arguments) {
      try {
        this.parsed_args = JSON.parse(this.function_call.arguments);
      } catch (e: any) {
        if (options.allowJsonParseError) {
          this.parsed_args = undefined;
          this.parse_error = e.message;
        } else {
          throw e;
        }
      }
    }
  }

  /**
   * 标记阻止下一轮对话。
   * 通常用于工具需要等待用户确认等「先暂停对话」的场景。
   */
  preventDefault() {
    this.is_prevent_default = true;
  }
}

/**
 * @deprecated 向下兼容别名：统一重构后已改名为 ToolCallContext。
 * 旧代码仍可 `import { FunctionCallContext }`，它等价于 ToolCallContext（同一个类），
 * 支持 `new FunctionCallContext(...)` / `instanceof FunctionCallContext` / 类型注解。
 * 新代码请直接使用 ToolCallContext。
 */
export const FunctionCallContext = ToolCallContext;
export type FunctionCallContext = ToolCallContext;
