/**
 * 思考档位的**命中判断** —— 宿主里两处 thinking 推导（助手视图 / 会话视图）共用这一份。
 *
 * ## 为什么要有第二个判断
 *
 * `matchesPatch` 回答的是「这份参数**正好是**某一档吗」，而 `hasThinkingKey` 回答的是
 * 「这份参数里**带着**属于这个策略的键吗」。后者是 `custom` 那一格的判据：
 *
 *   · 定义上写了 `reasoning_effort: "ultra"`，而策略表里只有 `low` / `high` → 凑不成任何一档，
 *     但它**显然**是有人手写过的思考参数（不是「没设过」）；
 *   · 定义上只写了 `temperature: 0.7` → 那不是思考参数，这一格仍然是「没设过」
 *     （`following_default`）。
 *
 * 不区分这两件事的表现：状态栏把「你手改过」说成「默认」—— 两者含义正好相反，用户会以为
 * 自己那份没生效，或者再设一次把手写值覆盖掉。
 *
 * 只看**键**不看值：值对不对是模型那边的事，这里只回答「这句参数是不是在说思考」。
 */

import type { ModelParams, ReasoningPatch } from "@ai-zen/agents-sdk";

import type { ThinkingSource } from "../wire/states.js";

/** 一档 → 参数补丁（策略表里 `levels` 那一格） */
export type ThinkingLevels = Record<string, ReasoningPatch>;

/**
 * 这份参数里有没有**属于这个策略**的键（键在任一档的补丁里出现过）。
 *
 * 判据与「换模型时清掉旧档位的键」同一条（`AgentService` 的 `withoutThinkingParams`）：
 * 一个键算不算思考参数，只看它在策略表里出现过没有 —— 不硬编码任何键名。
 */
export function hasThinkingKey(params: ModelParams | undefined, levels: ThinkingLevels): boolean {
  if (params === undefined) return false;
  return Object.values(levels).some((patch) =>
    Object.keys(patch).some((key) => params[key] !== undefined),
  );
}

/**
 * 那一格 `source`：凑成了某一档 → `manual`；没凑成但参数里带着思考键 → `custom`；
 * 其余（没设过）→ `following_default`。`not_adjustable` 不在这里（那是「没有策略表」）。
 */
export function thinkingSourceOf(detected: string | undefined, handWritten: boolean): ThinkingSource {
  if (detected !== undefined) return "manual";
  return handWritten ? "custom" : "following_default";
}
