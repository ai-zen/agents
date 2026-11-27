import type { Agent } from "@ai-zen/agents-core";
import { GET_MCP_TASK_RESULT_TOOL } from "@ai-zen/agents-sdk";
import type { McpTaskNotice, McpTaskNoticePort, SdkAgent } from "@ai-zen/agents-sdk";

import type { LogSink } from "@ai-zen/agents-logger";

/** 投递这一条要用到的两件事，都由装配根从运行时现取 */
export interface McpTaskNoticeDeps {
  /**
   * 这一段此刻活着的 Agent。只有运行时答得出来：宿主这一侧不留存活表。
   * `undefined` 就是那段已经不在（被杀、被删会话，或者进程重启后还没有被唤醒）。
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
 * - 投：`agent.send()` 进队列。落库与推给客户端不在这里 —— 那条路已经有一份（观察者听
 *   `inboxAdded` 写 `inbox` 表、推 `agent.inbox`），再走一遍就是第二条投递路。
 * - 丢：那段会话已经不在，就把这条通知丢掉并留一行日志。不唤醒、不建行、不留半条 ——
 *   一条服务器推来的通知不该把一段死会话叫起来。
 *
 * 任务 id 到会话 id 的对应关系不在这里：它活在 SDK 的任务会话里，进程没了就没了。
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
        // 高：这条通知说的是「等待的那个任务已有结论」，而等它的一方常常正在轮询
        //（`sleep` / `get_mcp_task_result`）。取低就永远等不到 —— 内循环只在工具边界取 high
        //（`Agent.landHigh`），那一批不结束，这条就一直不被看见。与 `deliverAsyncResult` 同一个理由。
        priority: "high" as const,
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

/** 那一句话本身。用词对齐 `call_mcp_tool` 交回句柄时说的那几句：任务、id、去哪儿取 */
function noticeText(notice: McpTaskNotice): string {
  const head = `MCP task ${notice.taskId} on "${notice.server}" ${notice.status}`;
  const reason = notice.statusMessage === undefined ? "" : `: ${notice.statusMessage}`;
  if (notice.status !== "completed") return `${head}${reason}.`;

  return (
    `${head}${reason}. ` +
    `Get the result with ${GET_MCP_TASK_RESULT_TOOL} and the arguments ` +
    `{"server":"${notice.server}","task_id":"${notice.taskId}"}.`
  );
}
