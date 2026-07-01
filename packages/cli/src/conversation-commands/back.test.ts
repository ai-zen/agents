import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { ConversationContext } from "../types.js";
import { handleBack } from "./back.js";

// Mock inquirer
vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn(),
  },
}));

import inquirer from "inquirer";

/**
 * handleBack 只操作 agent.messages 和 ctx，
 * 用最简单的对象模拟即可，不需要真正的 Agent 实例
 */
function createMockAgent(messages: AgentNS.Message[]) {
  return { messages };
}

function createCtx(): ConversationContext {
  return {
    input: "",
    currentName: "test",
    modelId: "test-model",
    currentId: undefined,
    agentId: undefined,
    running: true,
    systemMessages: [],
  };
}

describe("handleBack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("没有消息时返回提示，不清除消息", async () => {
    const agent = createMockAgent([]);
    const ctx = createCtx();

    await handleBack(agent as any, ctx);

    expect(ctx.input).toBe("");
    expect(agent.messages.length).toBe(0);
  });

  it("只有 system 消息时无目标消息", async () => {
    const agent = createMockAgent([
      { role: AgentNS.Role.System, content: "system prompt" },
    ]);
    const ctx = createCtx();

    await handleBack(agent as any, ctx);

    expect(ctx.input).toBe("");
  });

  it("选择取消操作时不修改消息", async () => {
    const agent = createMockAgent([
      { role: AgentNS.Role.System, content: "system" },
      { role: AgentNS.Role.User, content: "hello" },
      { role: AgentNS.Role.Assistant, content: "hi" },
    ]);
    const ctx = createCtx();

    // 模拟选择取消
    vi.mocked(inquirer.prompt).mockResolvedValueOnce({ selectedIndex: -1 });

    await handleBack(agent as any, ctx);

    expect(ctx.input).toBe("");
    expect(agent.messages.length).toBe(3);
  });

  it("撤回用户消息并输入空内容时取消操作", async () => {
    const agent = createMockAgent([
      { role: AgentNS.Role.System, content: "system" },
      { role: AgentNS.Role.User, content: "hello" },
      { role: AgentNS.Role.Assistant, content: "hi" },
    ]);
    const ctx = createCtx();

    // 模拟选择撤回用户消息（index 1），然后输入空内容
    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 1 })
      .mockResolvedValueOnce({ editedContent: "" });

    await handleBack(agent as any, ctx);

    expect(ctx.input).toBe("");
    expect(ctx.shouldSend).toBeUndefined();
    // 消息已被截断到用户消息前
    expect(agent.messages.length).toBe(1);
    expect(agent.messages[0].content).toBe("system");
  });

  it("撤回用户消息后输入内容并发送", async () => {
    const agent = createMockAgent([
      { role: AgentNS.Role.System, content: "system" },
      { role: AgentNS.Role.User, content: "hello" },
      { role: AgentNS.Role.Assistant, content: "hi" },
    ]);
    const ctx = createCtx();

    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 1 })
      .mockResolvedValueOnce({ editedContent: "modified message" });

    await handleBack(agent as any, ctx);

    expect(ctx.input).toBe("modified message");
    expect(ctx.shouldSend).toBe(true);
    expect(agent.messages.length).toBe(1);
  });

  it("撤回用户消息后直接回车（默认值）发送原内容", async () => {
    const agent = createMockAgent([
      { role: AgentNS.Role.System, content: "system" },
      { role: AgentNS.Role.User, content: "hello" },
      { role: AgentNS.Role.Assistant, content: "hi" },
    ]);
    const ctx = createCtx();

    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 1 })
      .mockResolvedValueOnce({ editedContent: "hello" }); // 默认值即原内容

    await handleBack(agent as any, ctx);

    expect(ctx.input).toBe("hello");
    expect(ctx.shouldSend).toBe(true);
  });

  it("撤回工具消息后输入新消息继续对话", async () => {
    const agent = createMockAgent([
      { role: AgentNS.Role.System, content: "system" },
      { role: AgentNS.Role.User, content: "calculate 1+1" },
      { role: AgentNS.Role.Assistant, content: "", tool_calls: [{ id: "call1", type: "function", function: { name: "calc", arguments: "{}" } }] },
      { role: AgentNS.Role.Tool, content: "2", name: "calc" },
    ]);
    const ctx = createCtx();

    // 选择撤回工具消息（index 3）
    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 3 })
      .mockResolvedValueOnce({ newMessage: "继续" });

    await handleBack(agent as any, ctx);

    expect(ctx.input).toBe("继续");
    // 消息截断到工具消息之后（sliceEnd = index + 1 = 4）
    expect(agent.messages.length).toBe(4);
  });

  it("撤回工具消息后输入空内容返回错误", async () => {
    const agent = createMockAgent([
      { role: AgentNS.Role.System, content: "system" },
      { role: AgentNS.Role.User, content: "hello" },
      { role: AgentNS.Role.Assistant, content: "", tool_calls: [{ id: "call1", type: "function", function: { name: "calc", arguments: "{}" } }] },
      { role: AgentNS.Role.Tool, content: "result" },
    ]);
    const ctx = createCtx();

    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 3 })
      .mockResolvedValueOnce({ newMessage: "" });

    await handleBack(agent as any, ctx);

    expect(ctx.input).toBe("");
    expect(ctx.shouldSend).toBeUndefined();
  });

  it("撤回用户消息后输入空白字符视为取消", async () => {
    const agent = createMockAgent([
      { role: AgentNS.Role.System, content: "system" },
      { role: AgentNS.Role.User, content: "hello" },
      { role: AgentNS.Role.Assistant, content: "hi" },
    ]);
    const ctx = createCtx();

    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ selectedIndex: 1 })
      .mockResolvedValueOnce({ editedContent: "   " });

    await handleBack(agent as any, ctx);

    expect(ctx.input).toBe("");
    expect(ctx.shouldSend).toBeUndefined();
  });
});
