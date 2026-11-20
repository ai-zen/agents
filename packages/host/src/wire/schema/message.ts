/**
 * `message.*` 的入参形状 —— **唯一真相**。
 *
 * 目前只有一条（`message.list`）。口径与 `session.ts` 那份逐条相同（理由见那个文件的头注释）：
 * 这一层只回答「形状对不对」，类型由 `z.infer` 推，失败文案用既有的 reason 词。
 *
 * 与 `session.ts` 那条明确的边界：这里只放 `message.*` 的方法入参；`session.send` /
 * `session.transient` 里嵌套的那个 `MessageInput`（内容段 + 素材引用）**不在**这里，它在
 * `session.ts` 里导出（`messageInputSchema`）—— 因为它同时是 `session.*` 的入参形状，放在那条
 * 方法旁边，别处要用从哪儿 import 都一样。
 */

import { z } from "zod";

import { sessionIdSchema } from "./session.js";

/**
 * 对象入参的失败文案：`not_an_object`（与 `WsHub` 的 `asRecord`、`session.ts` 同一词）。
 */
const OBJECT_ERROR = { error: "not_an_object" } as const;

/**
 * `message.list` 入参（PLAN A12 / PRD L5 / F-I7 / F-C6）。
 *
 * 四格可选参数里，`after` / `around` / `toolCallId` 在服务层是**「没给」与「空白」同一个意思**
 * （`MessageService` 的 `idParam`：`trim()` 之后为空就当没给 —— 于是 `after: ""` 等价于不传，
 * 返回全部）。所以这三格只校类型，不设非空下限：那不是形状问题，是取法规矩，服务层已经定下
 * 了口径，校验层不替它改判。
 *
 * `includeHidden` 只认布尔：这一格决定 `hidden` 的消息出不出网（会话创建时那条 cwd 消息、交接
 * 摘要），`1` / `"true"` 这种值原来会被当成 `false`（服务层读 `=== true`），正是要收掉的。
 *
 * 取法本身（`after` 从这条**含它**开始、`around` 以它为中心取一窗、两者同给只认 `around`、
 * `toolCallId` 决定读哪一段消息）都写在契约那份的 `MessageListParams` 上，这里不重复。
 */
export const messageListParams = z.object(
  {
    sessionId: sessionIdSchema,
    after: z.string("not_a_string").optional(),
    toolCallId: z.string("not_a_string").optional(),
    /** 定位取窗（PRD F-C6：客户端把搜索命中的那条摆到眼前） */
    around: z.string("not_a_string").optional(),
    /** 连 `hidden` 的消息一起返回（默认 false） */
    includeHidden: z.boolean("not_boolean").optional(),
  },
  OBJECT_ERROR,
);
