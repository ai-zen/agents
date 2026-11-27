import { AgentNS } from "./AgentNS.js";

/**
 * 「被中断的 assistant 消息」如何处置。只管内容与思考，不管工具调用。
 *
 * - `drop`：不保留（默认）。真删，内存与库里都消失；被删的交给调用方，由它报 `messageRemoved`
 * - `keep`：保留已经输出的部分。把消息恢复为 `Completed`，使其进入历史
 */
export type AbortedMessageStrategy = "drop" | "keep";

function hasText(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function hasContent(m: AgentNS.Message): boolean {
  const content = m.content;
  if (typeof content === "string") return hasText(content);
  if (Array.isArray(content)) return content.length > 0;
  return false;
}

function hasToolCalls(m: AgentNS.Message): boolean {
  return (m.tool_calls?.length ?? 0) > 0 || m.function_call != null;
}

/**
 * 处置「被中断的 assistant 消息」：用户按下中断时已经输出的那半截思考与回答，还要不要留在
 * 上下文里。
 *
 * 只处理 `role === assistant && status === Aborted` 的消息，且需同时满足：
 * - 不带工具调用（带了就交给 `reconcileAbortedToolRounds`，此处跳过）；
 * - 未被 `omit`（已被工具轮次策略判定出列的，不复活）；
 * - `keep` 时确有内容：`content` 或 `reasoning_content` 至少一个非空白。一个字都没输出就中断的
 *   仍然不留：空 assistant 消息对模型无信息量，部分服务端还会直接报错。
 *
 * 为什么 `drop` 是真删而不是打一个 `omit` 标记：`omit` 的语义是「压缩之后失效」，东西还在，
 * 只是不再发给模型；`drop` 的意思是它没发生过，内存与库里都该消失。两者混用之后，宿主丢掉
 * 一条之后分不清该删库还是该留行。
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
      if (!hasContent(m) && !hasText(m.reasoning_content)) continue;
      // 只有 `Completed` 的消息才进 `formatHistory`
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
