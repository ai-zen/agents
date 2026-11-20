/**
 * `search.*` 的入参形状 —— **唯一真相**。
 *
 * 两条方法、两张形状：`search.sessions`（按名字搜会话）与 `search.messages`（按聊天内容全文
 * 搜消息）。三条口径与 `session.ts` 同一套：类型由 `z.infer` 推、执行点只有
 * `WsHub.parseParams` 一处、失败文案用既有的 reason 词，不出网 Zod 的英文句子（PRD D8）。
 *
 * 词表沿用同波那几份的分工：`not_a_string` = 只校「是不是字符串」、`not_a_number` = 校
 * 「是不是有限数字」（`NaN` / `Infinity` 被拒；取值范围与切片归服务层）。本域全是「校类型」的字段，没有必填非空的 id ——
 * 两个 `query` 与 `sessionId` / `workspaceId` 的**空串都是合法输入**：
 *   - `query` 空 = 用户还没敲完，`SearchService` 回「没有命中」而不是「参数不对」；
 *   - `sessionId` 空 = 不按会话收窄（`scopeOf` 用 `length > 0` 判），`workspaceId` 空 = 按空 id
 *     查、回空列表（与 `sessionListParams` 里那一格同一个判法）。
 * 所以这里一处都**不用** `sessionIdSchema`（它要求非空）：套上去会把今天合法的调用打成
 * `invalid_params`，那是改语义而不是收形状。
 *
 * 文本字段（`query`）不 `trim`：`SearchService` 自己 `trim` 一次，这一层不抢它的活。
 */

import { z } from "zod";

/** 对象入参的失败文案：`not_an_object`（与 `session.ts` 里那份同一个词） */
const OBJECT_ERROR = { error: "not_an_object" } as const;

// ---------------------------------------------------------------------------
// search.*
// ---------------------------------------------------------------------------

/**
 * `search.sessions` 入参（PRD F-C6 / D16：按名称搜 + Workspace 过滤）。
 *
 * 逐格对齐 `SearchSessionsParams`：`query` 必填，`workspaceId` 与 `limit` 可缺
 * （`?` → `.optional()`，**不含 `null`**：类型里没有 `| null`）。
 *
 * `limit` 的正负与上限仍由 `clampLimit` 收敛（缺省 20、上限 100），这里只管它是数字。
 */
export const searchSessionsParams = z.object(
  {
    query: z.string("not_a_string"),
    workspaceId: z.string("not_a_string").optional(),
    limit: z.number("not_a_number").finite().optional(),
  },
  OBJECT_ERROR,
);

/**
 * `search.messages` 入参（PRD F-C6 / D16：按聊天内容全文搜）。
 *
 * 逐格对齐 `SearchMessagesParams`：`query` 必填；`workspaceId` / `sessionId` / `limit` /
 * `offset` 都可缺。给了 `sessionId` 就搜这一段会话，否则给了 `workspaceId` 就搜这个项目下的
 * 全部会话，都没给就是不限范围 —— 排序与切片（`offset`）都在服务层。
 */
export const searchMessagesParams = z.object(
  {
    query: z.string("not_a_string"),
    workspaceId: z.string("not_a_string").optional(),
    sessionId: z.string("not_a_string").optional(),
    limit: z.number("not_a_number").finite().optional(),
    offset: z.number("not_a_number").finite().optional(),
  },
  OBJECT_ERROR,
);
