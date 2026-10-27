import { describe, it, expect } from "vitest";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";
import { reconcileAbortedMessages } from "./AbortedMessages.js";

/** 被中断的 assistant 消息（可带内容 / 思考 / 工具调用） */
function abortedAssistant(
  fields: {
    content?: string;
    reasoning?: string;
    toolCalls?: AgentNS.ToolCall[];
    omit?: boolean;
  } = {},
) {
  return new Message({
    role: AgentNS.Role.Assistant,
    status: AgentNS.MessageStatus.Aborted,
    content: fields.content,
    reasoning_content: fields.reasoning,
    tool_calls: fields.toolCalls,
    omit: fields.omit,
  });
}

/** 与 formatHistory 的纳入条件一致 */
const included = (m: AgentNS.Message) =>
  (m.status == undefined || m.status === AgentNS.MessageStatus.Completed) && !m.omit;

describe("reconcileAbortedMessages", () => {
  it("drop（默认）：被中断的思考与内容都不进历史", () => {
    const messages: AgentNS.Message[] = [
      Message.System("sys"),
      abortedAssistant({ reasoning: "让我想想…", content: "答案是 4" }),
    ];

    reconcileAbortedMessages(messages);

    expect(messages[1]!.status).toBe(AgentNS.MessageStatus.Aborted);
    expect(included(messages[1]!)).toBe(false);
  });

  it("keep：保留已输出的内容（恢复为 Completed）", () => {
    const messages: AgentNS.Message[] = [
      Message.System("sys"),
      abortedAssistant({ reasoning: "让我想想…", content: "答案是 4" }),
    ];

    reconcileAbortedMessages(messages, "keep");

    expect(messages[1]!.status).toBe(AgentNS.MessageStatus.Completed);
    expect(included(messages[1]!)).toBe(true);
    // 内容与思考原样保留，一个字都不改
    expect(messages[1]!.content).toBe("答案是 4");
    expect(messages[1]!.reasoning_content).toBe("让我想想…");
  });

  it("keep：只有思考没有正文也保留（思考本身有价值）", () => {
    const messages: AgentNS.Message[] = [abortedAssistant({ reasoning: "先分析题意…" })];

    reconcileAbortedMessages(messages, "keep");

    expect(included(messages[0]!)).toBe(true);
    expect(messages[0]!.content).toBeUndefined();
    expect(messages[0]!.reasoning_content).toBe("先分析题意…");
  });

  it("keep：一个字都没输出就中断 → 仍丢弃，不留空消息", () => {
    const messages: AgentNS.Message[] = [
      abortedAssistant(),
      abortedAssistant({ content: "   " }),
      abortedAssistant({ content: "", reasoning: "" }),
    ];

    reconcileAbortedMessages(messages, "keep");

    expect(messages.every((m) => !included(m))).toBe(true);
  });

  it("keep：带工具调用的消息不归本函数管（交给工具轮次策略）", () => {
    const withCall = abortedAssistant({
      content: "我这就去查",
      toolCalls: [
        { index: 0, id: "1", type: "function", function: { name: "getTime", arguments: "{}" } },
      ],
    });
    const messages: AgentNS.Message[] = [withCall];

    reconcileAbortedMessages(messages, "keep");

    // 状态保持 Aborted：若在此处复活，会出现「有调用无结果」的非法历史
    expect(messages[0]!.status).toBe(AgentNS.MessageStatus.Aborted);
    expect(included(messages[0]!)).toBe(false);
  });

  it("keep：已被 omit 的消息不复活", () => {
    const messages: AgentNS.Message[] = [abortedAssistant({ content: "半句话", omit: true })];

    reconcileAbortedMessages(messages, "keep");

    expect(messages[0]!.omit).toBe(true);
    expect(included(messages[0]!)).toBe(false);
  });

  it("keep：多模态内容块数组视为有内容", () => {
    const msg = new Message({
      role: AgentNS.Role.Assistant,
      status: AgentNS.MessageStatus.Aborted,
      content: [{ type: "text", text: "看图" }] as any,
    });

    reconcileAbortedMessages([msg], "keep");

    expect(included(msg)).toBe(true);
  });

  it("幂等：重复调用结果一致", () => {
    const messages: AgentNS.Message[] = [abortedAssistant({ content: "半句话" })];

    reconcileAbortedMessages(messages, "keep");
    reconcileAbortedMessages(messages, "keep");

    expect(messages[0]!.status).toBe(AgentNS.MessageStatus.Completed);
  });

  it("已完成 / 正常消息不受影响", () => {
    const done = new Message({
      role: AgentNS.Role.Assistant,
      status: AgentNS.MessageStatus.Completed,
      content: "完整回答",
    });
    const pending = new Message({
      role: AgentNS.Role.Assistant,
      status: AgentNS.MessageStatus.Pending,
      content: "",
    });

    reconcileAbortedMessages([done, pending], "keep");

    expect(done.status).toBe(AgentNS.MessageStatus.Completed);
    expect(pending.status).toBe(AgentNS.MessageStatus.Pending);
  });
});
