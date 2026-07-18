import { describe, it, expect } from "vitest";
import { Provider } from "./runtime.js";
import type { McpConnectionManager } from "./mcp-connection.js";

const baseOptions = {
  config: {
    defaultModel: "gpt4",
    endpoints: [{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" }],
    models: [{ id: "gpt4", name: "GPT-4", endpointId: "openai", modelName: "gpt-4", maxContextTokens: 128000 }],
  },
  agentsDir: "/tmp/agents",
  conversationsDir: "/tmp/conversations",
  draftsDir: "/tmp/drafts",
};

describe("Provider", () => {
  it("构造 Provider 实例", () => {
    const provider = new Provider(baseOptions);
    expect(provider).toBeInstanceOf(Provider);
    expect(provider.config.defaultModel).toBe("gpt4");
  });

  it("可选路径默认为空数组", () => {
    const provider = new Provider(baseOptions);
    expect(provider.subAgentsPaths).toEqual([]);
    expect(provider.skillsPaths).toEqual([]);
    expect(provider.toolsPaths).toEqual([]);
    expect(provider.mcpPaths).toEqual([]);
  });

  it("传入可选路径时正确赋值", () => {
    const provider = new Provider({
      ...baseOptions,
      subAgentsPaths: ["/tmp/sub-agents", "/tmp/project/sub-agents"],
      skillsPaths: ["/tmp/skills"],
      toolsPaths: ["/tmp/tools"],
      mcpPaths: ["/tmp/mcp.json"],
    });
    expect(provider.subAgentsPaths).toHaveLength(2);
    expect(provider.skillsPaths).toEqual(["/tmp/skills"]);
    expect(provider.toolsPaths).toEqual(["/tmp/tools"]);
    expect(provider.mcpPaths).toEqual(["/tmp/mcp.json"]);
  });

  it("mcpManager 和 mcpConfigs 可选", () => {
    const provider = new Provider(baseOptions);
    expect(provider.mcpManager).toBeUndefined();
    expect(provider.mcpConfigs).toBeUndefined();
  });

  it("传入 mcpManager 和 mcpConfigs", () => {
    const mcpConfigs = new Map([["github", { name: "github", config: { id: "github", name: "GitHub", transport: "stdio" as const, command: "gh" } }]]);
    const provider = new Provider({
      ...baseOptions,
      mcpManager: {} as McpConnectionManager,
      mcpConfigs,
    });
    expect(provider.mcpManager).toBeDefined();
    expect(provider.mcpConfigs).toBeInstanceOf(Map);
    expect(provider.mcpConfigs!.has("github")).toBe(true);
  });

  it("createModel 委托给 create-model", () => {
    const provider = new Provider(baseOptions);
    const model = provider.createModel("gpt4");
    expect(model).toBeDefined();
    expect(typeof model.createCompletion).toBe("function");
  });

  it("createModel 模型不存在时报错", () => {
    const provider = new Provider(baseOptions);
    expect(() => provider.createModel("non-existent")).toThrow("不存在");
  });
});
