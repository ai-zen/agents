import { describe, it, expect } from "vitest";
import { getLastPromptTokens } from "./helpers";

function mockAgent(lastUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return {
    lastUsage,
    messages: [],
    tools: [],
    model: {},
    send: async () => [],
  };
}

describe("getLastPromptTokens", () => {
  it("有 lastUsage 时返回 prompt_tokens", () => {
    const agent = mockAgent({ prompt_tokens: 50000, completion_tokens: 8000, total_tokens: 58000 });
    expect(getLastPromptTokens(agent as any)).toBe(50000);
  });

  it("无 lastUsage 时返回 undefined", () => {
    const agent = mockAgent();
    expect(getLastPromptTokens(agent as any)).toBeUndefined();
  });

  it("lastUsage 存在但 prompt_tokens 为 0", () => {
    const agent = mockAgent({ prompt_tokens: 0, completion_tokens: 500, total_tokens: 500 });
    expect(getLastPromptTokens(agent as any)).toBe(0);
  });
});
