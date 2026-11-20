/**
 * `completion.*` 的入参形状 —— **唯一真相**。
 *
 * 这一域只有一条方法（`completion.files`：`@` 菜单的文件清单，PRD F-H5 / D7）。三条口径与
 * `session.ts` 同一套：类型由 `z.infer` 推、执行点只有 `WsHub.parseParams` 一处、失败文案用
 * 既有的 reason 词，不出网 Zod 的英文句子（PRD D8）。词表沿用同波那几份的分工：
 *   - `empty` = 必填且不能空；`not_a_string` = 只校「是不是字符串」；
 *   - `not_a_number` = 校「是不是有限数字」（`NaN` / `Infinity` 不是 JSON 能表达的数）
 *     取值范围归服务层。
 *
 * ## `workspaceId` 用的是 `sessionIdSchema`
 *
 * 项目 id 与会话 id 同形（都是宿主分配的 UUID，不是文件名），所以直接复用 `session.ts` 的那
 * 一份，不在这里重写第二套字符集 —— `schema/workspace.ts` 的做法一样。`handoff.listDocuments`
 * 也是这一格同一个判法。
 */

import { z } from "zod";

import { sessionIdSchema } from "./session.js";

/** 对象入参的失败文案：`not_an_object`（与 `session.ts` 里那份同一个词） */
const OBJECT_ERROR = { error: "not_an_object" } as const;

// ---------------------------------------------------------------------------
// completion.*
// ---------------------------------------------------------------------------

/**
 * `completion.files` 入参（PRD F-H5 / D7）：哪个工作区、已输入的前缀、最多回几条。
 *
 * 三格逐一对齐 `CompletionFilesParams`：
 *   - `workspaceId` 必填、不能空（复用 `sessionIdSchema`，空值报的就是 `empty`）；
 *   - `prefix` 必填但**可以是空串**：`@` 刚敲下去就是空前缀，那是合法输入（服务层回全量），
 *     所以只校类型（`not_a_string`），不设下限也不 `trim`（`selectEntries` 自己 `trim`，
 *     输入里的空格还可能是搜索词的一部分）；
 *   - `limit` 可缺（`?` → `.optional()`），只校「是不是有限数字」：缺省 20 / 上限 100 / `<= 0` 回
 *     缺省都是 `clampLimit` 已经定下的取值语义，形状层不替它收紧。
 */
export const completionFilesParams = z.object(
  {
    workspaceId: sessionIdSchema,
    prefix: z.string("not_a_string"),
    limit: z.number("not_a_number").finite().optional(),
  },
  OBJECT_ERROR,
);
