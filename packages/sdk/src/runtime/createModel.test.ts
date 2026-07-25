import { describe, it, expect } from "vitest";
import { createModel } from "./createModel.js";
import type { AppConfig } from "../types/index.js";
import type { Provider } from "./Provider.js";

function mockProvider(config: AppConfig): Provider {
  return {
    config,
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
    mcpManager: undefined,
    filter: () => ({ tools: [], subagents: [], skills: [], mcps: [] }),
    buildTools: () => [],
    instantiate: () => [],
    refresh: async () => {},
  } as unknown as Provider;
}

const baseConfig: AppConfig = {
  defaultModel: "gpt4",
  endpoints: [
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
    { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-ds" },
  ],
  models: [
    { id: "gpt4", name: "GPT-4", endpointId: "openai", modelName: "gpt-4", maxContextTokens: 128000 },
    { id: "gpt4-no-modelname", name: "GPT-4 No Name", endpointId: "openai", maxContextTokens: 128000 },
    { id: "ds-v3", name: "DeepSeek V3", endpointId: "deepseek", modelName: "deepseek-v3", maxContextTokens: 64000, defaultParams: { temperature: 0.7 } },
  ],
};

describe("createModel", () => {
  it("正常创建模型", () => {
    const model = createModel(mockProvider(baseConfig), "gpt4");
    expect(model).toBeDefined();
    expect(typeof model.createCompletion).toBe("function");
    expect(typeof model.createStream).toBe("function");
  });

  it("modelId 不存在时报错", () => {
    expect(() => createModel(mockProvider(baseConfig), "non-existent")).toThrow("不存在");
  });

  it("endpointId 找不到时报错", () => {
    const badConfig: AppConfig = {
      defaultModel: "bad",
      endpoints: [],
      models: [{ id: "bad", name: "Bad", endpointId: "missing-ep", maxContextTokens: 1000 }],
    };
    expect(() => createModel(mockProvider(badConfig), "bad")).toThrow("未配置");
  });

  it("endpoint apiKey 为空时不直接报错（由底层处理）", () => {
    const noKeyConfig: AppConfig = {
      defaultModel: "no-key",
      endpoints: [{ id: "no-key-ep", name: "No Key", baseUrl: "https://example.com/v1", apiKey: "" }],
      models: [{ id: "no-key", name: "No Key Model", endpointId: "no-key-ep", maxContextTokens: 1000 }],
    };
    const model = createModel(mockProvider(noKeyConfig), "no-key");
    expect(model).toBeDefined();
  });

  it("modelName 不填时回退到 id", () => {
    const model = createModel(mockProvider(baseConfig), "gpt4-no-modelname");
    expect(model).toBeDefined();
  });

  it("传递 defaultParams", () => {
    const model = createModel(mockProvider(baseConfig), "ds-v3");
    expect(model).toBeDefined();
  });

  it("空 models 数组时报错", () => {
    const emptyConfig: AppConfig = { defaultModel: "none", endpoints: [], models: [] };
    expect(() => createModel(mockProvider(emptyConfig), "none")).toThrow("不存在");
  });

  it("空 endpoints 数组时报错", () => {
    const noEpConfig: AppConfig = {
      defaultModel: "m",
      endpoints: [],
      models: [{ id: "m", name: "M", endpointId: "ep", maxContextTokens: 1000 }],
    };
    expect(() => createModel(mockProvider(noEpConfig), "m")).toThrow("未配置");
  });
});
