/**
 * 方法名 → 入参形状（JSON-RPC 边界的唯一真相）。
 *
 * 一张表，两个用途：
 *   1. **运行期**：`WsHub.invoke` 在方法名确认之后、任何业务代码之前查一次表，查到了就
 *      `safeParse` —— 全仓只有这一处执行入参校验。表里没有的方法（还没迁的 61 个）原样透传，
 *      所以迁移是一域一域来的，不需要一次改完。
 *   2. **类型**：`wire/methods.ts` 里那几份 `XxxParams` 是 `z.infer<typeof xxxParams>` 的推导
 *      结果 —— 契约面与校验面是同一份定义。
 *
 * 一域一文件（`session.ts` / 后面的 `agent.ts`、`config.ts` …），这里只做汇总与再导出：谁要
 * 引用某个域里的可复用形状（比如 `sessionIdSchema`），从哪个文件来都一样。
 */

import type { z } from "zod";

import type { MethodName } from "../methods.js";
import { agentDeleteParams, sessionPauseParams, sessionStartParams } from "./session.js";

export * from "./session.js";

/**
 * 已经迁到 schema 上的方法（每迁一域，这里长几行、`schema.test.ts` 里的 `PENDING` 缩几行）。
 *
 * `Partial` 是这套做法的要紧处：没有 schema 的方法在边界上原样透传，服务层继续按老样子
 * 自己判 —— 于是「迁了一半」是一个稳定状态，而不是必须一次改完的大爆炸。
 */
export const PARAM_SCHEMAS: Partial<Record<MethodName, z.ZodType>> = {
  "session.start": sessionStartParams,
  "session.pause": sessionPauseParams,
  "agent.delete": agentDeleteParams,
};
