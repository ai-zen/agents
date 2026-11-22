import type { Agent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import type { Tool } from "./Tool.js";

/**
 * 工具调用上下文 —— 一个类贯穿「拦截决策 → 执行」。
 *
 * 同一个实例既传给 `onToolStart` 钩子（执行前拦截），也传给 `Tool.exec(ctx)`。
 *
 * 工具从这里停不掉循环：它返回什么，就只是一条 tool 消息回给模型，引擎接着跑
 *（停循环的两条路 —— 钩子拒、用户 `abort` —— 都不在工具手里，`CORE.md` §8）。
 *
 * 参数解析是容错的：参数烂 = 「没给出有效结果」，与「执行挂了」「工具不存在」同一件事 ——
 * 一条 tool 消息回给模型，其他什么都不做。所以只有一种行为：解析失败时 `parsedArgs` 为
 * `undefined`、`parseError` 有值。
 */
export class ToolCallContext {
  /** 当前 agent（可读权限、上下文、模型等；subagent 工具可借此访问父 Agent） */
  agent: Agent;

  /**
   * 统一形状的工具调用：`{ id?, type?, function: { name, arguments } }`。
   *
   * 要读名字 / 参数就读 `tool_call.function` —— 这里没有 `function_call` 兼容字段：
   * 一个概念只有一种形状，两份迟早会漂（而漂的时候两边都看着像是真的）。
   */
  tool_call: AgentNS.ToolCall;

  /** 匹配到的已注册工具（未注册则为 undefined，此时那条 tool 消息里是「未知工具」） */
  tool?: Tool;

  /** 已解析的工具参数；解析失败时为 `undefined`（此时 `parseError` 有值） */
  parsedArgs: any;

  /**
   * 本次工具调用对应的工具结果消息：执行结果 / 拒绝原因 / 参数解析错误都写进它，
   * 最终作为 tool 结果回给 LLM。
   */
  resultMessage: AgentNS.Message;

  /** 参数 JSON 解析错误信息（仅解析失败时存在） */
  parseError?: string;

  /** 工具执行的中止信号：`abort()` 会掐断它，工具实现可监听以真正中断执行 */
  signal?: AbortSignal;

  constructor(options: {
    agent: Agent;
    tool_call: AgentNS.ToolCall;
    tool?: Tool;
    resultMessage: AgentNS.Message;
    signal?: AbortSignal;
  }) {
    this.agent = options.agent;
    this.tool_call = options.tool_call;
    this.tool = options.tool;
    this.resultMessage = options.resultMessage;
    this.signal = options.signal;

    const functionCall = this.tool_call.function;
    if (functionCall?.arguments) {
      try {
        this.parsedArgs = JSON.parse(functionCall.arguments);
      } catch (e: any) {
        this.parsedArgs = undefined;
        this.parseError = e?.message;
      }
    }
  }
}
