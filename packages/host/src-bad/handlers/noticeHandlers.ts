/**
 * `notice.*` 三个方法的接线（PRD L3 / F-I8）。
 *
 * handler 只做两件事：把连接的**语言**递给服务层（D8：语言挂在连接上，文案在读出时渲染），
 * 以及把服务层的返回值原样交回。业务事实全在 `NoticeService` 里，这里不做判断 ——
 * 一层只解释一次，多一层翻译就多一处会漂的地方。
 */

import type { HandlerTable } from "../net/WsHub.js";
import type { NoticeService } from "../services/NoticeService.js";

export interface NoticeHandlerDeps {
  /** 只要本域用到的那三个方法（结构上 `NoticeService` 满足，用例可以给替身） */
  notices: Pick<NoticeService, "list" | "dismiss" | "clear">;
}

/** 本域注册的方法 */
export type NoticeHandlers = Pick<HandlerTable, "notice.list" | "notice.dismiss" | "notice.clear">;

export function createNoticeHandlers(deps: NoticeHandlerDeps): NoticeHandlers {
  return {
    "notice.list": async (context) =>
      await deps.notices.list(context.params, context.connection.language),
    "notice.dismiss": async (context) => await deps.notices.dismiss(context.params),
    "notice.clear": async (context) => await deps.notices.clear(context.params),
  };
}
