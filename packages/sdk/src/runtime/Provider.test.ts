import { describe, it, expect } from "vitest";
import { Provider } from "./Provider.js";
import { createModel } from "./createModel.js";

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

  it("无 mcpPaths 时 getMcpManager 返回 undefined", () => {
    const provider = new Provider(baseOptions);
    expect(provider.getMcpManager()).toBeUndefined();
  });

  it("有 mcpPaths 时 getMcpManager 延迟创建 McpConnectionManager", () => {
    const provider = new Provider({
      ...baseOptions,
      mcpPaths: ["/tmp/mcp.json"],
    });
    const manager = provider.getMcpManager();
    expect(manager).toBeDefined();
    // 多次调用返回同一实例
    expect(provider.getMcpManager()).toBe(manager);
  });

  it("createModel 根据 config 和 modelId 构建模型", () => {
    const provider = new Provider(baseOptions);
    const model = createModel(provider.config, "gpt4");
    expect(model).toBeDefined();
    expect(typeof model.createCompletion).toBe("function");
  });

  it("createModel 模型不存在时报错", () => {
    const provider = new Provider(baseOptions);
    expect(() => createModel(provider.config, "non-existent")).toThrow("不存在");
  });
});
