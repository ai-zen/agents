import type { Session } from "../session/types.js";
import type { searchTable } from "./table.js";
import type { MessageSearchScope, SearchHit } from "./types.js";

export interface SearchDeps {
  readonly search: ReturnType<typeof searchTable>;
}

export class SearchService {
  constructor(private readonly deps: SearchDeps) {}

  /**
   * 空关键词不查：`LIKE '%%'` 会把全库带回来，而空串进 FTS 是一条语法错误 —— 两种都不是
   * 「什么都没搜」该有的结果。
   */
  async messages(keyword: string, scope: MessageSearchScope, limit: number): Promise<SearchHit[]> {
    const trimmed = keyword.trim();
    return trimmed === "" ? [] : this.deps.search.messages(trimmed, scope, limit);
  }

  async sessions(
    keyword: string,
    workspaceId: string | undefined,
    limit: number,
  ): Promise<Session[]> {
    const trimmed = keyword.trim();
    return trimmed === "" ? [] : this.deps.search.sessions(trimmed, workspaceId, limit);
  }
}
