/**
 * `message.*`：历史（PRD L5 / A12 / F-I7）。
 *
 * 取法（含自身最新内容、id 不存在就全量）已经在 `MessageService` 里定死，这里只转发。
 */

import type { HandlerTable } from "../net/index.js";
import type { MessageService } from "../services/MessageService.js";

export interface MessageHandlerDeps {
  messages: MessageService;
}

export function createMessageHandlers(deps: MessageHandlerDeps): HandlerTable {
  return {
    "message.list": async (context) => await deps.messages.list(context.params),
  };
}
