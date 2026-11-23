import type { Agent } from "@ai-zen/agents-core";
import { GET_MCP_TASK_RESULT_TOOL } from "@ai-zen/agents-sdk";
import type { McpTaskNotice, McpTaskNoticePort, SdkAgent } from "@ai-zen/agents-sdk";

import type { LogSink } from "@ai-zen/agents-logger";

/** 投递这一条要用到的两件事，都由装配根从运行时现取 */
export interface McpTaskNoticeDeps {
  /**
   * 这一段此刻活着的 Agent。**只有运行时答得出来**：宿主这一侧不留存活表。
   * `undefined` 就是那段已经不在（被杀、被删会话，或者进程重启后还没人叫醒它）。
   */
  readonly alive: (sessionId: string) => Pick<SdkAgent, "send"> | undefined;
  /** 这个 Agent 属于哪一段会话；被派出去的那个不属于任何一段 */
  readonly sessionOf: (agent: Agent) => string | undefined;
  readonly log: LogSink;
}

/**
 * MCP 任务通知的投递口：任务到了终态，就往发起那次调用的那段会话的 inbox 投一条。
 *
 * 两件事只在这里做：
 *
 * - **投**：`agent.send()` 进队列。落库与推给客户端不在这里 —— 那条路已经有一份（观察者听
 *   `inboxAdded` 写 `inbox` 表、推 `agent.inbox`），再走一遍就是第二条投递路。
 * - **丢**：那段会话已经不在，就把这条通知丢掉并留一行日志。不唤醒、不建行、不留半条 ——
 *   一条服务器推来的通知不该把一段死会话叫起来（`PRD.md` 4.1）。
 *
 * 任务 id 到会话 id 的对应关系不在这里：它活在连接管理器里，进程没了就没了。
 */
export function createMcpTaskNoticePort(deps: McpTaskNoticeDeps): McpTaskNoticePort {
  return {
    sessionOf: (agent) => deps.sessionOf(agent),
    deliver: async (sessionId, notice) => {
      const agent = deps.alive(sessionId);
      if (agent === undefined) {
        deps.log.warn(
          `MCP task "${notice.taskId}" of "${notice.server}" ended, but session "${sessionId}" ` +
            `that started it is gone; the notice is dropped`,
        );
        return false;
      }

      const entry = {
        priority: "low" as const,
        source: { kind: "system" as const, label: `mcp:${notice.server}` },
        content: noticeText(notice),
      };

      try {
        agent.send(entry);
      } catch (error) {
        // 队列已经不收件（这一段正在被收掉）：同样只是一条没有去处的通知，丢掉并留一行
        deps.log.warn(
          `MCP task "${notice.taskId}" of "${notice.server}" could not be delivered to session ` +
            `"${sessionId}"; the notice is dropped`,
          { error },
        );
        return false;
      }
      return true;
    },
  };
}

/**
 * 这条通知在会话里说的那句话。
 *
 * 三件事都得说清：任务 id、终态是什么、结果去哪儿取（工具名与两个参数）。少一件，读这句话的
 * Agent 就会去找一个不存在的地方，或者以为结果会自己回来。
 */
function noticeText(notice: McpTaskNotice): string {
  const where = `{"server":"${notice.server}","task_id":"${notice.taskId}"}`;
  const detail = notice.statusMessage === undefined ? "" : `: ${notice.statusMessage}`;

  switch (notice.status) {
    case "completed":
      return (
        `MCP task "${notice.taskId}" on server "${notice.server}" completed. ` +
        `Its result does not come back by itself: fetch it with ${GET_MCP_TASK_RESULT_TOOL} ` +
        `and the arguments ${where}.`
      );
    case "failed":
      return (
        `MCP task "${notice.taskId}" on server "${notice.server}" failed${detail}. ` +
        `What it ended with can be read with ${GET_MCP_TASK_RESULT_TOOL} and the arguments ${where}.`
      );
    case "cancelled":
      return (
        `MCP task "${notice.taskId}" on server "${notice.server}" was cancelled${detail}. ` +
        `Nothing more will happen on the server side; ${GET_MCP_TASK_RESULT_TOOL} with ${where} ` +
        `answers what it left behind.`
      );
  }
}
