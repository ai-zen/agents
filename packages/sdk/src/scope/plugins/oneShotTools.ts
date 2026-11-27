/**
 * 一次性 Agent 手上不该有的那些工具 —— 名单与摘法都只有这一份。
 *
 * ## 为什么一次性 Agent 一件都不能有
 *
 * 一次性 Agent（`lifetime: "one-shot"`）的寿命在调用栈里：`runOnce()` 一返回它就 `stop()`
 * 并关收（`core/src/Agent.ts`）。于是这两类工具在它手上都只有必错的路：
 *
 * - PeerSession 那三件（`post_message` / `create_session` / `read_session_status`）：
 *   它不属于任何一段会话 —— 没有可以署名的身份（发话要写「来自哪一段会话」），也开不出有人
 *   认领的新会话（`create_session` 必回 `depth_exceeded`）；
 * - `async_exec` / `async_timeout`：结果在将来某个时刻由 inbox 投回来，那时它的调用栈
 *   已经退了 —— `send` 抛 `closed`，那条结果就此丢掉并记一行日志；更早一步，`onStop` 上的
 *   清点会把还没结束的后台命令直接 `kill()`（见 `builtin/asyncTasks.ts` 的 `supervise`）。
 *    也就是说「起了个后台任务，回头再收结果」在子 Agent 身上不是不可靠，是必然不成立。
 *
 * ## 三处造一次性 Agent 的地方都要过这一道
 *
 * 名单原先各写各的：`createAgent` 与 `subAgentTools` 各拼一份，技能 subagent（`skillTools`）
 * 干脆一份都没拼 —— 它直接继承父 Agent 的工具列表，于是 `async_*` 就这么漏进了那个一次性
 * Agent 的手里。现在名单只有这一处，三处都从这里取：
 *
 * - `runtime/createAgent.ts`（`lifetime: "one-shot"`）与 `subagents/subAgentTools.ts`：把
 *   {@link ONE_SHOT_WITHHELD_TOOL_NAMES} 交给 `scope.filter` 的 `exclude`（按名字剔，定义文件
 *   里写 `allow: ["*"]` 也照样剔得掉）；
 * - `skills/skillTools.ts`：它是继承父的工具实例（不走 filter），用
 *   {@link withoutOneShotWithheld} 按名字摘。
 */

import { ASYNC_TASK_TOOL_NAMES } from "./builtin/asyncTasks.js";
import { PEER_SESSION_TOOL_NAMES } from "./peers/peerSessionTools.js";

/** 一次性 Agent 手上不该有的工具名（判据见文件头） */
export const ONE_SHOT_WITHHELD_TOOL_NAMES: readonly string[] = [
  ...PEER_SESSION_TOOL_NAMES,
  ...ASYNC_TASK_TOOL_NAMES,
];

/**
 * 从一份已经装配好的工具里摘掉 {@link ONE_SHOT_WITHHELD_TOOL_NAMES}（按名字，保持原顺序）。
 *
 * 给那些「拿父 Agent 的工具实例、不过 `scope.filter`」的路用（技能 subagent）。走 filter 的
 * 那两处不需要它 —— 那边是同一份名单、另一条通道。
 */
export function withoutOneShotWithheld<T extends { function: { name: string } }>(
  tools: readonly T[],
): T[] {
  const withheld = new Set<string>(ONE_SHOT_WITHHELD_TOOL_NAMES);
  return tools.filter((tool) => !withheld.has(tool.function.name));
}
