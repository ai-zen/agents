/**
 * `handoff.*` 的入参形状 —— **唯一真相**。
 *
 * 两条方法：`handoff.start`（开始一次交接，回执只说「开始了」）与 `handoff.listDocuments`
 * （列出项目里已有的交接文档）。三条口径与 `session.ts` 同一套：类型由 `z.infer` 推、执行点
 * 只有 `WsHub.parseParams` 一处、失败文案用既有的 reason 词，不出网 Zod 的英文句子（PRD D8）。
 *
 * `mode` / `then` 是**闭环枚举**，所以归形状：`HandoffDocumentService.start` 里那两个
 * `isHandoffMode` / `isHandoffThen` 判的就是它们，认不出的取值现在报
 * `invalid_params` + `field` / `value` / `allowed`（**没有** `reason`）。这里统一给 `bad_value`
 * —— 客户端拿 `field` 找输入框、拿 `reason` 分类，两样都在。
 *
 * 词表沿用同波那几份的分工：`empty` = 必填且不能空（两个 id 格子）、`bad_value` = 闭环枚举。
 */

import { z } from "zod";

import { sessionIdSchema } from "./session.js";

/** 对象入参的失败文案：`not_an_object`（与 `WsHub` 的 `asRecord`、`session.ts` 同一个词） */
const OBJECT_ERROR = { error: "not_an_object" } as const;

// ---------------------------------------------------------------------------
// 可复用的形状
// ---------------------------------------------------------------------------

/**
 * 交接执行者：`self` = 自交接（这段会话自己的 agent 写），`summary` = 独立交接（另起一个
 * 一次性 agent 拿记忆副本写，跑完即散）。
 *
 * 认不出的取值报 `bad_value`：这是闭环枚举，没有「服务层再判一次」的余地。
 */
export const handoffModeSchema = z.enum(["self", "summary"], "bad_value");

/** 交接之后做什么：只产出文档（`document_only`），还是顺带开一段新会话（`new_session`）。 */
export const handoffThenSchema = z.enum(["document_only", "new_session"], "bad_value");

// ---------------------------------------------------------------------------
// handoff.*
// ---------------------------------------------------------------------------

/**
 * `handoff.start` 入参（PRD F-D3 / F-D4 / F-D5 / F-D7）：哪段会话、谁来写、之后接什么。
 *
 * 三格与 `HandoffStartParams` 逐一对齐，都是必填。
 *
 * 这里**没有** `questionId`（理由写在契约那份上：题的状态只由 `QuestionService.answer` 一处写）。
 * 「能不能现在交接」（在跑 / 暂停中 / 已经有一次在交接）也不在这里 —— 那是服务层的
 * `busy` / `handoff_in_progress`，形状层只管这三格在不在、是什么类型。
 */
export const handoffStartParams = z.object(
  {
    sessionId: sessionIdSchema,
    mode: handoffModeSchema,
    then: handoffThenSchema,
  },
  OBJECT_ERROR,
);

/**
 * `handoff.listDocuments` 入参（PRD F-D6：文档写进项目，可反复打磨同一份）。
 *
 * 只有一格：哪个工作区。空串按「参数不对」处理（`empty`）—— 项目 id 与会话 id 同形（都是
 * 宿主分配的 UUID），所以直接复用 `sessionIdSchema`，不重写第二套（`schema/workspace.ts`
 * 与 `completion.ts` 的做法一样）。
 */
export const handoffListDocumentsParams = z.object(
  {
    workspaceId: sessionIdSchema,
  },
  OBJECT_ERROR,
);
