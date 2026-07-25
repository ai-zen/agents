import { describe, it, expect, vi } from "vitest";
import { Agent, AgentNS } from "@ai-zen/agents-core";
import { createSubAgentTool } from "./subAgentTools.js";
import type { Provider } from "../../runtime/Provider.js";
import type { AgentDefinition } from "../../types/index.js";

vi.mock("../../runtime/createModel.js", () => ({
  createModel: vi.fn().mockReturnValue({
    createCompletion: vi.fn(),
    createStream: vi.fn(),
  }),
}));

function mockProvider(): Provider {
  return {
    config: {
      defaultModel: "gpt4",
      endpoints: [{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" }],
      models: [{ id: "gpt4", name: "GPT-4", endpointId: "openai", modelName: "gpt-4", maxContextTokens: 128000 }],
    },
    agentsDir: "",
    subAgentsPaths: [],
    skillsPaths: [],
    toolsPaths: [],
    mcpPaths: [],

    builtinTools: [],
    userTools: [],
    subagents: [],
    skills: [],
    mcps: [],

    filter: vi.fn(() => ({ tools: [], subagents: [], skills: [], mcps: [] })),
    instantiate: vi.fn(() => []),
    buildTools: vi.fn(() => []),
    refresh: vi.fn(),
    mcpManager: undefined,
  } as unknown as Provider;
}

function sampleDef(id: string, functionName: string): AgentDefinition {
  return {
    id,
    name: id,
    messages: [
      { role: AgentNS.Role.System, content: "You are a sub-agent." },
      { role: AgentNS.Role.User, content: "{{task}}" },
    ],
    function: {
      name: functionName,
      description: `Sub-agent ${functionName}`,
      parameters: { type: "object", properties: {}, required: [] },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("createSubAgentTool", () => {
  it("返回 AgentToolLazy 实例", () => {
    const tool = createSubAgentTool(sampleDef("sa1", "agent_one"), mockProvider());
    expect(tool).toBeDefined();
    expect(tool.function.name).toBe("agent_one");
    expect(tool.function.description).toContain("Sub-agent agent_one");
  });

  it("Agent 没有 function 字段时抛出错误", () => {
    const def = sampleDef("no-func", "no_func");
    delete def.function;
    expect(() => createSubAgentTool(def, mockProvider())).toThrow("没有 function");
  });

  it("SubAgent 有独立 modelId 时使用独立模型", () => {
    const provider = mockProvider();
    const def = sampleDef("sa1", "agent_one");
    def.modelId = "gpt4";

    const tool = createSubAgentTool(def, provider);
    expect(tool.function.name).toBe("agent_one");
    // modelId 指定了，会通过 createModel(provider.config, def.modelId) 构建独立模型
  });

  it("SubAgent 无 modelId 时复用父 Agent 模型", () => {
    const provider = mockProvider();

    const tool = createSubAgentTool(sampleDef("sa1", "agent_one"), provider);
    expect(tool.function.name).toBe("agent_one");
  });

  it("permissions 为空时仍能创建工具", () => {
    const provider = mockProvider();

    const def = sampleDef("sa1", "agent_one");
    const tool = createSubAgentTool(def, provider);
    expect(tool).toBeDefined();
    expect(tool.function.name).toBe("agent_one");
  });
});
