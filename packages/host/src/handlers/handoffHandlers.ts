/**
 * `handoff.*` 两个方法的接线（PRD F-D3 / F-D4 / F-D5 / F-D6 / F-D7 / D18 / D19）。
 *
 * ## `handoff.start` 只回「已经开始」
 *
 * 交接要跑一阵（写文档、换记忆、旧记忆成另一段会话），而这个方法是一个 RPC —— 它有回执、
 * 要尽快返回。所以它不等那一趟跑完：文档路径、有没有降级、成功 / 取消 / 失败，全部走
 * **通知**（`NoticeService`，PRD 4.9）与 `session.changed` 的 `memory_replaced` 告知，
 * 界面要知道「现在正在交接」就读 `session.state.handoff`。
 *
 * ## 接线层只转发
 *
 * 唯一的判据在 `ChatRunner.canHandoffNow` 那一处：**这段会话能不能立刻接手一批**（`no_agent` /
 * `working` / `output_paused` / `handoff_in_progress`），拒的时候回 `busy`，`detail.reason` 就是
 * 那一个词。本域因此不碰中断口，也不向接线层要 `runner`。
 */

import type { HandlerTable } from "../net/WsHub.js";
import type { HandoffDocumentService } from "../services/HandoffDocumentService.js";

export interface HandoffHandlerDeps {
  /** 只要本域用到的那两个方法（结构上 `HandoffDocumentService` 满足，用例可以给替身） */
  handoff: Pick<HandoffDocumentService, "start" | "listDocuments">;
}

/** 本域注册的方法 */
export type HandoffHandlers = Pick<HandlerTable, "handoff.start" | "handoff.listDocuments">;

export function createHandoffHandlers(deps: HandoffHandlerDeps): HandoffHandlers {
  return {
    "handoff.start": async (context) =>
      await deps.handoff.start(context.params, context.connection.language),
    "handoff.listDocuments": async (context) => await deps.handoff.listDocuments(context.params),
  };
}
