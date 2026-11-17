/**
 * `handoff.*` 两个方法的接线（PRD F-D3 / F-D4 / F-D5 / F-D6 / F-D7 / D18 / D19）。
 *
 * ## `handoff.start` 只回「已经开始」
 *
 * 交接要跑一阵（写文档、换记忆、旧记忆成另一段会话），而这个方法是一个 RPC —— 它有回执、
 * 要尽快返回。所以它不等那一趟跑完：文档路径、有没有降级、成功 / 取消 / 失败，全部走
 * **通知**（`NoticeService`，PRD 4.9）与 `conversation.changed` 的 `memory_replaced` 告知，
 * 界面要知道「现在正在交接」就读 `conversation.state.handoff`。
 *
 * ## 接线层不替它做任何编排
 *
 * 从前这里是「先 `abort()` 掐掉在途，再开始」—— 那条中断语义已经作废（用户判词：非空闲时
 * 不让跑就行了）。现在只有一条判据，而且它在 `ChatRunner.canHandoffNow` 那一处：**这段对话能不能
 * 立刻接手一批**（`no_agent` / `working` / `output_paused` / `handoff_in_progress`），拒的时候
 * 回 `busy`，`detail.reason` 就是那一个词，调用方自己等它行了再来。
 * 于是这里不必碰中断口，本域也就不再向接线层要 `runner`。
 */

import type { HandlerTable } from "../net/WsHub.js";
import type { HandoffDocumentService } from "../services/HandoffDocumentService.js";

export interface HandoffHandlerDeps {
  /** 只要本域用到的那两个方法（结构上 `HandoffDocumentService` 满足，用例可以给替身） */
  handoff: Pick<HandoffDocumentService, "start" | "listDocuments">;
}

/** 本域注册的方法 */
export type HandoffHandlers = Pick<
  HandlerTable,
  "handoff.start" | "handoff.listDocuments"
>;

export function createHandoffHandlers(deps: HandoffHandlerDeps): HandoffHandlers {
  return {
    "handoff.start": async (context) =>
      await deps.handoff.start(context.params, context.connection.language),
    "handoff.listDocuments": async (context) =>
      await deps.handoff.listDocuments(context.params),
  };
}
