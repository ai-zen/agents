/**
 * `search.*`：找得到旧对话（PRD F-C6 / D16）。
 *
 * 名称搜与全文搜的取数、分词退化（少于 3 字走 `LIKE`）都在 `SearchService` 里，
 * 这里只转发。
 */

import type { HandlerTable } from "../net/index.js";
import type { SearchService } from "../services/SearchService.js";

export interface SearchHandlerDeps {
  search: SearchService;
}

export function createSearchHandlers(deps: SearchHandlerDeps): HandlerTable {
  return {
    "search.sessions": async (context) => await deps.search.sessions(context.params),
    "search.messages": async (context) => await deps.search.messages(context.params),
  };
}
