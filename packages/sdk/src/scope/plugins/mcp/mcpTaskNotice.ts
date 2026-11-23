import type { Agent } from "@ai-zen/agents-core";

/** 取任务结果那一条工具的名字：任务通知的正文里要写出它，模型才知道去哪儿取 */
export const GET_MCP_TASK_RESULT_TOOL = "get_mcp_task_result";
/** 取消任务那一条工具的名字 */
export const CANCEL_MCP_TASK_TOOL = "cancel_mcp_task";

/** 任务的终态：到这三格才算结束，才有「结果可以取了」这回事 */
export type McpTaskTerminalStatus = "completed" | "failed" | "cancelled";

/**
 * 一条任务到了终态时要投进 inbox 的事实。
 *
 * 只有事实，没有一句话文案：这段文字会变成会话里的一条消息给人看，而语言与用户可见文案归宿主
 * 那一层（它才知道界面那一侧该用什么语言说话）。
 */
export interface McpTaskNotice {
  /** 服务器名（配置里的那个 id） */
  server: string;
  /** 服务器给的任务 id */
  taskId: string;
  /** 终态 */
  status: McpTaskTerminalStatus;
  /** 服务器随状态给的一句说明（它没给就没有这一格） */
  statusMessage?: string;
}

/**
 * 任务状态通知的投递口。
 *
 * 服务器把一次调用变成任务之后，终态是异步到的；它要落到的地方是发起那次调用的那段会话的 inbox。
 * 这条路上两头都不在 SDK 手里：谁活着、往哪张表写、推给哪个客户端，只有宿主答得出来。所以这里
 * 只留一个形状，由宿主实现，桥接层只认这两个方法：
 *
 * - {@link McpTaskNoticePort.sessionOf}：发起调用的 Agent 属于哪一段会话；
 * - {@link McpTaskNoticePort.deliver}：把一条终态通知投进那段会话。
 */
export interface McpTaskNoticePort {
  /**
   * 这个 Agent 属于哪一段会话；不属于任何一段（被派出去的 subagent、一次性 Agent）时是
   * `undefined` —— 那种调用发起的任务没有会话可以回报。
   */
  sessionOf(agent: Agent): string | undefined;
  /**
   * 把一条终态通知投进那段会话的 inbox。
   *
   * 返回 `false` 表示那段会话已经不在（没有 Agent），这条通知被丢掉了 —— 投递不创建、也不复活
   * 会话，丢不丢、记不记日志都由实现那一侧决定。
   */
  deliver(sessionId: string, notice: McpTaskNotice): Promise<boolean>;
}
