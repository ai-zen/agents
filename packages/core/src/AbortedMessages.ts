import { AgentNS } from "./AgentNS.js";

/**
 * 「被中断的 assistant 消息」如何处置 —— 只管**内容与思考**，不管工具调用。
 *
 * - `drop`：不保留（默认，保持既有行为）—— 被中断的 assistant 不进下一轮上下文
 * - `keep`：保留已经输出的部分 —— 把消息恢复为 `Completed`，让它进入历史
 */
export type AbortedMessageStrategy = "drop" | "keep";

/** 是否有实际文本（空串 / 纯空白视为没有） */
function hasText(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** 是否有内容：字符串看非空白，多模态内容块数组看非空 */
function hasContent(m: AgentNS.Message): boolean {
  const content = m.content;
  if (typeof content === "string") return hasText(content);
  if (Array.isArray(content)) return content.length > 0;
  return false;
}

/** 是否带工具调用（`tool_calls` 或旧版 `function_call`） */
function hasToolCalls(m: AgentNS.Message): boolean {
  return (m.tool_calls?.length ?? 0) > 0 || m.function_call != null;
}

/**
 * 处置「被中断的 assistant 消息」——决定用户按下中断键时，屏幕上已经出现的那半截
 * 思考与回答，还要不要留在上下文里。
 *
 * ## 为什么需要
 *
 * `abort()` 只把在途消息标成 `Aborted`，而 `formatHistory()` 只放行
 * `status == undefined | Completed` 的消息。于是默认结果是：**已输出的思考与内容
 * 全部丢失** —— 下一轮请求里模型完全不知道自己说过什么，用户看到的半句话变成了
 * 界面上的孤儿。表现就是「中断后接着问，AI 像失忆一样重新开始」。
 *
 * 工具调用轮次不归本函数管：那条路径由 `reconcileAbortedToolRounds()` 处理
 * （服务端要求「N 个 tool_calls 必须有 N 条结果」，必须整轮进出）。两个函数配合，
 * 才能既保住内容、又不破坏工具配对约束。
 *
 * ## 判定
 *
 * 仅处理 `role === assistant && status === Aborted` 的消息，且需同时满足：
 * - **不带工具调用**（带了就交给 `reconcileAbortedToolRounds`，此处跳过）；
 * - **未被 `omit`**（已被工具轮次策略判定出列的，不复活）；
 * - **确有内容**：`content` 或 `reasoning_content` 至少一个非空白。一个字都没输出
 *   就中断的，仍然丢弃 —— 空 assistant 消息对模型无信息量，部分服务端还会直接报错。
 *
 * 幂等，可重复调用。
 *
 * ## 注意
 *
 * `keep` 会把 `reasoning_content` 一并回传给服务端。多数厂商接受该字段，但个别
 * 厂商对思维链回传有额外约束；如需规避，可在调用前自行清空 `reasoning_content`。
 */
export function reconcileAbortedMessages(
  messages: AgentNS.Message[],
  strategy: AbortedMessageStrategy = "drop",
): void {
  // drop 即既有行为：Aborted 消息由 formatHistory 自然过滤，无需任何改动
  if (strategy === "drop") return;

  for (const m of messages) {
    if (m.role !== AgentNS.Role.Assistant) continue;
    if (m.status !== AgentNS.MessageStatus.Aborted) continue;
    // 工具轮次归 reconcileAbortedToolRounds 管，避免把「有调用无结果」的半截轮次
    // 复活成非法历史
    if (hasToolCalls(m)) continue;
    // 已被判出列的不复活
    if (m.omit) continue;
    // 一个字都没输出就中断：不留空消息
    if (!hasContent(m) && !hasText(m.reasoning_content)) continue;

    // 恢复为 Completed → 进入 formatHistory，模型下一轮能看到自己说过的话
    m.status = AgentNS.MessageStatus.Completed;
  }
}
