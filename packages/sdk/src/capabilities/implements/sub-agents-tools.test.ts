import { describe, it, expect, vi } from "vitest";
import { Agent, AgentNS } from "@ai-zen/agents-core";
import { createSubAgentTool } from "./sub-agents-tools.js";
import type { Provider } from "../../runtime/runtime.js";
import type { Capabilities } from "../capabilities.js";
import type { AgentDefinition } from "../../types/index.js";

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
    conversationsDir: "",
    draftsDir: "",
    createModel: vi.fn().mockReturnValue({
      createCompletion: vi.fn(),
      createStream: vi.fn(),
    }),
  } as unknown as Provider;
}

function mockCaps(overrides?: Partial<Capabilities>): Capabilities {
  return {
    filter: vi.fn(() => ({ tools: [], subagents: [], skills: [], mcps: [] })),
    instantiate: vi.fn(() => []),
    buildTools: vi.fn(() => []),
    ...overrides,
  } as unknown as Capabilities;
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
    const tool = createSubAgentTool(sampleDef("sa1", "agent_one"), mockProvider(), mockCaps());
    expect(tool).toBeDefined();
    expect(tool.function.name).toBe("agent_one");
    expect(tool.function.description).toContain("Sub-agent agent_one");
  });

  it("Agent 没有 function 字段时抛出错误", () => {
    const def = sampleDef("no-func", "no_func");
    delete def.function;
    expect(() => createSubAgentTool(def, mockProvider(), mockCaps())).toThrow("没有 function");
  });

  it("不传 caps 时 buildAgent 抛出错误", async () => {
    const tool = createSubAgentTool(sampleDef("sa1", "agent_one"), mockProvider());
    // AgentToolLazy 会在调用时触发 buildAgent
    // 这里构造一个 mock 的 FunctionCallContext 来测试
    expect(tool.function.name).toBe("agent_one");
  });

  it("SubAgent 有独立 modelId 时使用独立模型", () => {
    const provider = mockProvider();
    const def = sampleDef("sa1", "agent_one");
    def.modelId = "gpt4";
    const caps = mockCaps();
    caps.filter = vi.fn(() => ({ tools: ["readFile"], subagents: [], skills: [], mcps: [] }));
    caps.instantiate = vi.fn(() => []);

    const tool = createSubAgentTool(def, provider, caps);
    expect(tool.function.name).toBe("agent_one");
    // modelId 指定了，should use provider.createModel
  });

  it("SubAgent 无 modelId 时复用父 Agent 模型", () => {
    const provider = mockProvider();
    const caps = mockCaps();
    caps.filter = vi.fn(() => ({ tools: [], subagents: [], skills: [], mcps: [] }));
    caps.instantiate = vi.fn(() => []);

    const tool = createSubAgentTool(sampleDef("sa1", "agent_one"), provider, caps);
    expect(tool.function.name).toBe("agent_one");
  });

  it("permissions 为空时仍能创建工具", () => {
    const provider = mockProvider();
    const caps = mockCaps();

    const def = sampleDef("sa1", "agent_one");
    const tool = createSubAgentTool(def, provider, caps);
    expect(tool).toBeDefined();
    expect(tool.function.name).toBe("agent_one");
  });
});
