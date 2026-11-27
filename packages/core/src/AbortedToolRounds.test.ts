import { describe, it, expect } from "vitest";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";
import {
  reconcileAbortedToolRounds,
  DEFAULT_ABORTED_TOOL_ROUND_REASON,
} from "./AbortedToolRounds.js";

/** 构造一个带 tool_calls 的 assistant 消息 */
function assistantWithCalls(ids: string[], status = AgentNS.MessageStatus.Completed) {
  return new Message({
    role: AgentNS.Role.Assistant,
    status,
    tool_calls: ids.map((id, index) => ({
      index,
      id,
      type: "function",
      function: { name: `tool_${id}`, arguments: "{}" },
    })),
  });
}

function toolResult(id: string, status: AgentNS.MessageStatus, content = "") {
  return new Message({
    role: AgentNS.Role.Tool,
    tool_call_id: id,
    name: `tool_${id}`,
    content,
    status,
  });
}

const included = (m: AgentNS.Message) =>
  (m.status == undefined || m.status === AgentNS.MessageStatus.Completed) && !m.omit;

describe("reconcileAbortedToolRounds", () => {
  it("fill：assistant 被中断、部分结果完成 → 整轮入列，未完成的补原因", () => {
    const messages: AgentNS.Message[] = [
      Message.System("sys"),
      assistantWithCalls(["a", "b", "c"], AgentNS.MessageStatus.Aborted),
      toolResult("a", AgentNS.MessageStatus.Completed, "A 完成"),
      toolResult("b", AgentNS.MessageStatus.Aborted),
      toolResult("c", AgentNS.MessageStatus.Completed, "C 完成"),
    ];

    reconcileAbortedToolRounds(messages, "fill", "用户中断了会话");

    expect(messages[1]!.status).toBe(AgentNS.MessageStatus.Completed);
    expect(included(messages[1]!)).toBe(true);
    expect(messages[3]!.status).toBe(AgentNS.MessageStatus.Completed);
    expect(messages[3]!.content).toBe("用户中断了会话");
    // 三条结果全部纳入：调用数与结果数相等
    const results = messages.filter((m) => m.role === AgentNS.Role.Tool);
    expect(results).toHaveLength(3);
    expect(results.every(included)).toBe(true);
  });

  it("drop：assistant 被中断、部分结果完成 → 整轮真删", () => {
    const messages: AgentNS.Message[] = [
      Message.System("sys"),
      assistantWithCalls(["a", "b"], AgentNS.MessageStatus.Aborted),
      toolResult("a", AgentNS.MessageStatus.Completed, "A 完成"),
      toolResult("b", AgentNS.MessageStatus.Aborted),
    ];

    const removed = reconcileAbortedToolRounds(messages, "drop");

    // 整轮都没了：不产生孤儿，也不留下半个轮次
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe(AgentNS.Role.System);
    expect(removed).toHaveLength(3);
  });

  it("一致轮次（全在）不受影响", () => {
    const messages: AgentNS.Message[] = [
      Message.System("sys"),
      assistantWithCalls(["a"], AgentNS.MessageStatus.Completed),
      toolResult("a", AgentNS.MessageStatus.Completed, "A"),
    ];
    const before = messages.map((m) => ({ ...m }));
    reconcileAbortedToolRounds(messages, "fill");
    expect(messages.map((m) => m.status)).toEqual(before.map((m) => m.status));
    expect(messages[1]!.omit).toBeFalsy();
  });

  it("完整中断轮次（assistant 与结果全不在）不处理，不复活", () => {
    const messages: AgentNS.Message[] = [
      Message.System("sys"),
      assistantWithCalls(["a"], AgentNS.MessageStatus.Aborted),
      toolResult("a", AgentNS.MessageStatus.Aborted),
    ];
    reconcileAbortedToolRounds(messages, "fill");
    // 仍应保持整轮出列（不把中断轮次补成可见）
    expect(included(messages[1]!)).toBe(false);
    expect(included(messages[2]!)).toBe(false);
    expect(messages[2]!.content).not.toBe(DEFAULT_ABORTED_TOOL_ROUND_REASON);
  });

  it("非中断轮次不被处理（Error 等语义保持不变）", () => {
    const messages: AgentNS.Message[] = [
      Message.System("sys"),
      assistantWithCalls(["a"], AgentNS.MessageStatus.Completed),
      toolResult("a", AgentNS.MessageStatus.Error, "工具出错"),
    ];
    reconcileAbortedToolRounds(messages, "fill");
    expect(messages[2]!.status).toBe(AgentNS.MessageStatus.Error);
  });

  it("默认参数：策略 fill、原因「用户中断了会话」", () => {
    const messages: AgentNS.Message[] = [
      Message.System("sys"),
      assistantWithCalls(["a"], AgentNS.MessageStatus.Aborted),
      toolResult("a", AgentNS.MessageStatus.Completed, "A"),
    ];
    reconcileAbortedToolRounds(messages);
    expect(messages[1]!.status).toBe(AgentNS.MessageStatus.Completed);
  });

  it("幂等：重复调用结果不变", () => {
    const messages: AgentNS.Message[] = [
      Message.System("sys"),
      assistantWithCalls(["a", "b"], AgentNS.MessageStatus.Aborted),
      toolResult("a", AgentNS.MessageStatus.Completed, "A"),
      toolResult("b", AgentNS.MessageStatus.Aborted),
    ];
    reconcileAbortedToolRounds(messages, "fill");
    const snapshot = messages.map((m) => ({ id: m.id, status: m.status, content: m.content }));
    reconcileAbortedToolRounds(messages, "fill");
    expect(messages).toHaveLength(snapshot.length);
    expect(messages.map((m) => ({ id: m.id, status: m.status, content: m.content }))).toEqual(
      snapshot,
    );
  });
});
