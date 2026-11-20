/**
 * `question.*` 的入参形状 —— **唯一真相**。
 *
 * 两条：`list`（这段会话现在有没有一道题）与 `answer`（把题答了）。题**不落库**、只活在
 * 「这一段会话还活着」的这段时间里（`QuestionService` 的文件头讲透了），所以这里也不会有
 * 「按状态筛」「按 id 跨会话查」那类入参 —— 别照着持久化的习惯往这里加字段。
 *
 * 这一层只回答形状：`questionId` 长不长、`value` 空不空。至于「这题还在不在」「值在不在候选里」
 * 都是现场事实（要读内存里的那道题），归服务层 —— 那两处的 reason（`not_found` /
 * `invalid_params` + `options` 清单）原样留在 `QuestionService.answer`。
 */

import { z } from "zod";

import { sessionIdSchema } from "./session.js";

/** `not_an_object`：与 `session.ts` 里那份同一个词 */
const OBJECT_ERROR = { error: "not_an_object" } as const;

// ---------------------------------------------------------------------------
// 可复用的形状
// ---------------------------------------------------------------------------

/**
 * 一道题的 id：非空字符串，两侧空白不算内容。
 *
 * reason 用既有的 `empty`（与 `session.ts` 同一套）：
 * 对客户端来说「类型不对」与「给了个空串」是同一件事 —— 这个字段没给出能用的值。空 id 到了
 * 服务层只会落成 `not_found`（题根本不存在），所以在边界上先按形状拒掉。
 */
export const questionIdSchema = z.string("empty").trim().min(1, "empty");

// ---------------------------------------------------------------------------
// question.*
// ---------------------------------------------------------------------------

/**
 * `question.list` 入参：只有一段会话的 id。
 *
 * `sessionId` 必填且复用 `sessionIdSchema`：题只属于某一段会话，「全库问题列表」这种读法明确
 * 不做（PRD 4.10）；也没有 `state` 过滤 —— 两个状态一起给，客户端自己看那一格。
 */
export const questionListParams = z.object({ sessionId: sessionIdSchema }, OBJECT_ERROR);

/**
 * `question.answer` 入参：答哪道题 + 选了哪个候选值。
 *
 * `value` 只校「非空字符串」（reason 用 `empty`，与 `questionId` 那一格同一套），**不枚举**，
 * 因为候选是**每道题自己带着的**，不是一套全局词表：
 *   - `kind: "handoff"` 才刚好三道（`self` / `summary` / `decline`，交接线的「自交接 /
 *     独立摘要 / 不交接」）；
 *   - `kind: "confirmation"` 的候选取值由发起方给（删助手、删项目那些确认），条数与值是
 *     每题各写各的。
 *
 * 而且「是哪种题」这件事不在入参里也能看出来：判别式是**那道题**的 `kind`，`question.answer`
 * 只带 `questionId` 与 `value`，`kind` 得先按 id 找到题才知道。所以「值必须在候选里」这条
 * 判断留在服务层（它手上有 `question.options`，拒的时候还带 `options` 清单给客户端）——
 * 在这里枚举成 `z.enum(["self", "summary", "decline"])` 会把所有 confirmation 题一起判死。
 */
export const questionAnswerParams = z.object(
  {
    questionId: questionIdSchema,
    /** 候选里的值（`QuestionView.options[].value`），空白串不许 */
    value: z.string("empty").trim().min(1, "empty"),
  },
  OBJECT_ERROR,
);
