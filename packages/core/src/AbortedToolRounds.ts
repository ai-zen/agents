import { AgentNS } from "./AgentNS.js";

/**
 * 「工具调用轮次不完整」的处理策略。
 *
 * - `drop`：整轮丢弃（assistant + 其全部工具结果都不发给模型）
 * - `fill`：保留整轮（恢复 assistant，并给未完成的工具结果补上原因）
 */
export type AbortedToolRoundStrategy = "drop" | "fill";

/** `fill` 策略下，未完成工具结果的默认填充原因 */
export const DEFAULT_ABORTED_TOOL_ROUND_REASON = "用户中断了会话";

/** 是否为「工具结果」消息（tool / function 角色） */
function isToolResult(m: AgentNS.Message): boolean {
  return m.role === AgentNS.Role.Tool || m.role === AgentNS.Role.Function;
}

/** 该消息是否会被 `formatHistory` 纳入（status 未定义或 Completed，且未 omit） */
function isIncluded(m: AgentNS.Message): boolean {
  return (
    (m.status == undefined || m.status === AgentNS.MessageStatus.Completed) &&
    !m.omit
  );
}

/** 工具调用的匹配键：优先 `tool_call_id`，缺失时退化为 `fn:<name>`（兼容 function_call） */
function keyOfCall(id: string | undefined, name: string | undefined): string {
  return id != null ? `id:${id}` : `fn:${name ?? ""}`;
}

/** 工具结果的匹配键（与调用侧规则一致） */
function keyOfResult(m: AgentNS.Message): string {
  return m.tool_call_id != null ? `id:${m.tool_call_id}` : `fn:${m.name ?? ""}`;
}

/**
 * 归一化「被中断的工具调用轮次」——确保每条带 `tool_calls`（或 `function_call`）的
 * assistant 消息与其结果消息**同进同出**，从而满足服务端「N 个 tool_calls 必须有 N 条
 * 结果」的约束。
 *
 * ## 为什么需要
 *
 * `abort()` 会把在途消息**各自**标记为 `Aborted`，而 `formatHistory()` 又**只按 status
 * 独立过滤**——二者都不把一个工具轮次当作整体。于是并行工具执行中被中断时：
 * 带 `tool_calls` 的 assistant 被剔除，而部分已完成的工具结果仍被保留 →
 * 留下没有父调用的 `role:"tool"` 孤儿消息 → 服务端报错（反之亦然，结果数 < 调用数）。
 *
 * ## 范围
 *
 * **仅处理「被中断」（含 `Aborted` 状态）的轮次**。其它状态（如 `allowJsonParseError=false`
 * 时工具报错标记的 `Error`）保持原有语义，不受本函数影响。
 *
 * ## 判定与处理
 *
 * 逐条扫描带调用的 assistant，取其紧随其后的工具结果；**不一致**指：
 * - assistant 会被纳入、但并非全部结果都在（部分被剔除）；或
 * - assistant 不会被纳入、却仍有结果在（孤儿）。
 *
 * 「全在」或「全不在」都视为一致（不处理），因此不会"复活"一个被完整中断的轮次。
 *
 * - `drop`：整轮出列（assistant 与其结果均置 `omit`）
 * - `fill`：整轮入列（恢复 assistant 为 Completed；未完成的结果补原因并置 Completed）
 *
 * 幂等，可重复调用。
 */
export function reconcileAbortedToolRounds(
  messages: AgentNS.Message[],
  strategy: AbortedToolRoundStrategy = "fill",
  reason: string = DEFAULT_ABORTED_TOOL_ROUND_REASON,
): void {
  for (let i = 0; i < messages.length; i++) {
    const assistant = messages[i]!;
    if (assistant.role !== AgentNS.Role.Assistant) continue;

    const toolCalls = assistant.tool_calls ?? [];
    const hasFunctionCall = assistant.function_call != null;
    if (toolCalls.length === 0 && !hasFunctionCall) continue;

    // 紧随其后的工具结果消息（直到遇到非工具消息）
    const results: AgentNS.Message[] = [];
    let j = i + 1;
    while (j < messages.length && isToolResult(messages[j]!)) {
      results.push(messages[j]!);
      j++;
    }

    // 期望的调用清单（按 tool_calls 顺序；function_call 作单条处理）
    const calls = toolCalls.length
      ? toolCalls.map((tc) => ({ id: tc.id, name: tc.function?.name }))
      : [{ id: undefined, name: assistant.function_call?.name }];

    // 结果按匹配键归位（同键取首个；core 保证每个调用都有对应结果）
    const resultByKey = new Map<string, AgentNS.Message>();
    for (const r of results) {
      const k = keyOfResult(r);
      if (!resultByKey.has(k)) resultByKey.set(k, r);
    }

    const present = calls
      .map((c) => resultByKey.get(keyOfCall(c.id, c.name)) ?? null)
      .filter((m): m is AgentNS.Message => m !== null);

    // 仅处理被中断的轮次：assistant 或任一结果处于 Aborted
    const aborted =
      assistant.status === AgentNS.MessageStatus.Aborted ||
      present.some((r) => r.status === AgentNS.MessageStatus.Aborted);
    if (!aborted) continue;

    const assistantIncluded = isIncluded(assistant);
    const anyResultIncluded = present.some(isIncluded);
    const allResultsIncluded =
      present.length === calls.length && present.every(isIncluded);

    const inconsistent =
      (assistantIncluded && !allResultsIncluded) ||
      (!assistantIncluded && anyResultIncluded);
    if (!inconsistent) continue;

    if (strategy === "drop") {
      // 整轮出列：assistant 与其结果都不发给模型
      assistant.omit = true;
      for (const r of present) r.omit = true;
      continue;
    }

    // fill：整轮入列
    assistant.omit = false;
    assistant.status = AgentNS.MessageStatus.Completed;

    for (const r of present) {
      r.omit = false;
      if (r.status !== AgentNS.MessageStatus.Completed) {
        r.status = AgentNS.MessageStatus.Completed;
        if (r.content == null || r.content === "") r.content = reason;
      }
    }
  }
}
