import { describe, it, expect } from "vitest";
import { assembleAgent } from "./factory";
import type { AgentDefinition, AppConfig, AgentDefinition as AgentDef } from "../types";
import { CallbackTool } from "@ai-zen/agents-core";
import type { Tool } from "@ai-zen/agents-core";

function makeTool(name: string): Tool {
  return new CallbackTool({
    function: { name, description: `${name} tool`, parameters: { type: "object", properties: {}, required: [] } },
    callback: async () => name,
  });
}

const config: AppConfig = {
  defaultModel: "gpt4",
  endpoints: [
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "sk-xxx" },
  ],
  models: [
    { id: "gpt4", name: "GPT-4", endpointId: "openai", maxContextTokens: 500000 },
    { id: "gpt35", name: "GPT-3.5", endpointId: "openai", maxContextTokens: 8000 },
  ],
};

const baseDef: AgentDefinition = {
  id: "test-agent",
  name: "Test Agent",
  messages: [{ role: "system", content: "You are a test agent." }],
  permissions: {
    tools: { allow: ["readFile", "exec"] },
    subagents: { deny: ["*"] },
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("assembleAgent", () => {
  it("使用 Agent 指定的 modelId", () => {
    const result = assembleAgent({
      definition: { ...baseDef, modelId: "gpt35" },
      config,
      builtinTools: ["readFile", "exec", "rm"].map(makeTool),
    });

    expect(result.model.id).toBe("gpt35");
  });

  it("未指定 modelId 时使用默认模型", () => {
    const result = assembleAgent({
      definition: baseDef,
      config,
      builtinTools: ["readFile", "exec"].map(makeTool),
    });

    expect(result.model.id).toBe("gpt4");
  });

  it("权限过滤生效 — exec 可用，rm 不可用", () => {
    const result = assembleAgent({
      definition: baseDef,
      config,
      builtinTools: ["readFile", "exec", "rm"].map(makeTool),
    });

    expect(result.capabilities.tools.map((t: Tool) => t.function.name)).toContain("readFile");
    expect(result.capabilities.tools.map((t: Tool) => t.function.name)).toContain("exec");
    expect(result.capabilities.tools.map((t: Tool) => t.function.name)).not.toContain("rm");
  });

  it("SubAgent deny: ['*'] — subagents 不在 tools 中", () => {
    const result = assembleAgent({
      definition: baseDef,
      config,
      builtinTools: ["readFile"].map(makeTool),
      subagents: [{
        id: "ga", name: "ga",
        messages: [{ role: "system", content: "Hi" }, { role: "user", content: "{{task}}" }],
        function: { name: "general_assistant", description: "", parameters: { type: "object", properties: {}, required: [] } },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
    });

    expect(result.capabilities.tools.map((t: Tool) => t.function.name)).not.toContain("general_assistant");
  });

  it("modelId 指向不存在的模型时抛异常", () => {
    expect(() =>
      assembleAgent({
        definition: { ...baseDef, modelId: "nonexistent" },
        config,
      }),
    ).toThrow();
  });
});
