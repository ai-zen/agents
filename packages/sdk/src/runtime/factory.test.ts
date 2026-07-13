import { describe, it, expect } from "vitest";
import { createAgent } from "./factory";
import type { AgentDefinition, AppConfig } from "../types";

const config: AppConfig = {
  defaultModel: "m1",
  endpoints: [
    { id: "e1", name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "sk-xxx" },
  ],
  models: [
    { id: "m1", name: "GPT-4", endpointId: "e1", maxContextChars: 500000 },
    { id: "m2", name: "GPT-3.5", endpointId: "e1", maxContextChars: 100000 },
  ],
};

const baseAgent: AgentDefinition = {
  id: "test-agent",
  name: "测试 Agent",
  messages: [{ role: "system", content: "You are helpful." }],
  permissions: {
    tools: { allow: ["readFile", "exec"] },
    skills: { allow: ["*"] },
    mcps: { allow: ["*"] },
    subagents: { deny: ["*"] },
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("createAgent", () => {
  it("使用 Agent 指定的 modelId", () => {
    const agent = { ...baseAgent, modelId: "m2" };
    const result = createAgent({ definition: agent, config });

    expect(result.model.id).toBe("m2");
    expect(result.model.name).toBe("GPT-3.5");
  });

  it("未指定 modelId 时使用默认模型", () => {
    const result = createAgent({ definition: baseAgent, config });
    expect(result.model.id).toBe("m1");
  });

  it("提取 system prompt", () => {
    const result = createAgent({ definition: baseAgent, config });
    expect(result.systemPrompt).toBe("You are helpful.");
  });

  it("权限过滤生效 — exec 可用，rm 不可用", () => {
    const result = createAgent({
      definition: baseAgent,
      config,
      builtinTools: ["readFile", "exec", "rm"],
    });

    expect(result.capabilities.tools).toContain("readFile");
    expect(result.capabilities.tools).toContain("exec");
    expect(result.capabilities.tools).not.toContain("rm");
  });

  it("SubAgent deny: ['*'] — subagents 为空", () => {
    const result = createAgent({
      definition: baseAgent,
      config,
      subagents: ["general_assistant"],
    });
    expect(result.capabilities.subagents).toEqual([]);
  });

  it("modelId 指向不存在的模型时抛异常", () => {
    const agent = { ...baseAgent, modelId: "nonexistent" };
    expect(() => createAgent({ definition: agent, config })).toThrow();
  });
});
