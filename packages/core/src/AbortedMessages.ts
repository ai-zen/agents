import { AgentNS } from "./AgentNS.js";

/**
 * 「被中断的 assistant 消息」如何处置 —— 只管**内容与思考**，不管工具调用。
 *
 * - `drop`：不保留（默认）—— **真删**，内存与库里都消失（被删的交给调用方，由它报 `messageRemoved`）
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
 * ## 判定
 *
 * 仅处理 `role === assistant && status === Aborted` 的消息，且需同时满足：
 * - **不带工具调用**（带了就交给 `reconcileAbortedToolRounds`，此处跳过）；
 * - **未被 `omit`**（已被工具轮次策略判定出列的，不复活）；
 * - `keep` 时**确有内容**：`content` 或 `reasoning_content` 至少一个非空白 ——
 *   一个字都没输出就中断的，仍然不留（空 assistant 消息对模型无信息量，部分服务端还会
 *   直接报错）。
 *
 * ## 为什么 `drop` 是「真删」而不是打个 `omit` 标记
 *
 * `omit` 的语义是「压缩之后失效」——东西还在，只是不再发给模型。而「丢」的意思是它
 * 没发生过：内存与库里都该消失。两者混用之后，宿主丢掉一条永远也搞不清自己该删库还是
 * 该留行。
 *
 * 幂等，可重复调用。
 *
 * @returns 被删掉的消息（按原顺序）。`keep` 策略下永远是空数组。
 */
export function reconcileAbortedMessages(
  messages: AgentNS.Message[],
  strategy: AbortedMessageStrategy = "drop",
): AgentNS.Message[] {
  const doomed = new Set<AgentNS.Message>();

  for (const m of messages) {
    if (m.role !== AgentNS.Role.Assistant) continue;
    if (m.status !== AgentNS.MessageStatus.Aborted) continue;
    // 工具轮次归 reconcileAbortedToolRounds 管
    if (hasToolCalls(m)) continue;
    // 已被判出列的不复活
    if (m.omit) continue;

    if (strategy === "keep") {
      // 一个字都没输出就中断：不留空消息
      if (!hasContent(m) && !hasText(m.reasoning_content)) continue;
      // 恢复为 Completed → 进入 formatHistory，模型下一次请求能看到自己说过的话
      m.status = AgentNS.MessageStatus.Completed;
      continue;
    }

    doomed.add(m);
  }

  if (doomed.size === 0) return [];

  const removed = messages.filter((m) => doomed.has(m));
  for (let i = messages.length - 1; i >= 0; i--) {
    if (doomed.has(messages[i]!)) messages.splice(i, 1);
  }
  return removed;
}
