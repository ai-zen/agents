/**
 * `completion.*` 的接线壳（F-H5 / D7）：`@` 补全的数据来源。
 *
 * 业务判断在 `services/CompletionService.ts`；这里只转发 + 按连接语言重渲染「未就绪要说话」
 * 的那句说明（D8）。
 */

import type { HandlerTable } from "../net/WsHub.js";
import type { CompletionService } from "../services/CompletionService.js";
import { localizeLocalizedTexts } from "./configHandlers.js";

/** 本文件负责的方法名 */
export type CompletionHandlerName = "completion.files";

/** 本文件产出的 handler 表片段 */
export type CompletionHandlers = Pick<HandlerTable, CompletionHandlerName>;

/** 接线壳的依赖 */
export interface CompletionHandlerDeps {
  completion: CompletionService;
}

/** 造出 `completion.*` 的 handler 表 */
export function createCompletionHandlers(deps: CompletionHandlerDeps): CompletionHandlers {
  return {
    "completion.files": async (context) =>
      localizeLocalizedTexts(
        await deps.completion.files(context.params),
        context.connection.language,
      ),
  };
}
