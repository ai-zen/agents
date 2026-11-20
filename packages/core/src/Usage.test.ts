import { describe, expect, it } from "vitest";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";
import { addUsage, sumUsage, ZERO_USAGE } from "./Usage.js";

const usage = (prompt: number, completion: number, total: number): AgentNS.Usage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: total,
});

describe("addUsage", () => {
  it("逐字段相加并返回新对象", () => {
    const a = usage(1, 2, 3);
    const b = usage(10, 20, 30);
    const sum = addUsage(a, b);
    expect(sum).toEqual(usage(11, 22, 33));
    expect(a).toEqual(usage(1, 2, 3)); // 不修改入参
    expect(b).toEqual(usage(10, 20, 30));
  });
});

describe("sumUsage", () => {
  it("空数组归零", () => {
    expect(sumUsage([])).toEqual(ZERO_USAGE);
  });

  it("累加 assistant 的 usage 与 tool 的 subAgentUsage（互斥出现）", () => {
    const messages: AgentNS.Message[] = [
      { createdAt: Date.now(), role: AgentNS.Role.System, content: "系统", id: "s" },
      {
        id: "a1",
        createdAt: Date.now(),
        role: AgentNS.Role.Assistant,
        content: "回复",
        usage: usage(100, 20, 120),
      },
      // 工具消息：内部委派（subagent）的累计
      {
        id: "t1",
        createdAt: Date.now(),
        role: AgentNS.Role.Tool,
        content: "结果",
        subAgentUsage: usage(200, 30, 230),
      },
    ];
    expect(sumUsage(messages)).toEqual(usage(300, 50, 350));
  });

  it("忽略既无 usage 也无 subAgentUsage 的消息", () => {
    const messages = [Message.User("你好"), Message.Assistant("无用量")] as AgentNS.Message[];
    expect(sumUsage(messages)).toEqual(ZERO_USAGE);
  });

  it("嵌套自动成立：对 subagent 的 messages 求和即含孙级", () => {
    // subagent 自己的 messages：一轮自身回复 + 一次孙级委派
    const subAgentMessages: AgentNS.Message[] = [
      {
        id: "sa",
        createdAt: Date.now(),
        role: AgentNS.Role.Assistant,
        content: "子的回复",
        usage: usage(50, 10, 60),
      },
      {
        id: "st",
        createdAt: Date.now(),
        role: AgentNS.Role.Tool,
        content: "孙的结果",
        subAgentUsage: usage(80, 12, 92),
      },
    ];
    expect(sumUsage(subAgentMessages)).toEqual(usage(130, 22, 152));
  });
});
