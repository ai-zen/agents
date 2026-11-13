/**
 * `handoff.*` 两个方法的接线（PRD F-D3 / F-D4 / F-D5 / F-D6 / F-D7 / D18 / D19）。
 *
 * `handoff.start` 的失败形态有两种，客户端要能分开看：
 *   - 用户取消 → 业务码 `handoff_declined`（不是失败，会话回到交接前，F-D7）；
 *   - 真失败 → `internal` + `error.handoffFailed`（带上原因）。
 * 降级不是失败：结果是成功的，`degraded` / `problem` 里说明退到了哪一档。
 */

import type { HandlerTable } from "../net/WsHub.js";
import type { HandoffService } from "../services/HandoffService.js";

export interface HandoffHandlerDeps {
  /** 只要本域用到的那两个方法（结构上 `HandoffService` 满足，用例可以给替身） */
  handoff: Pick<HandoffService, "start" | "listDocuments">;
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
