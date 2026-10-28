import { describe, it, expect } from "vitest";
import { createModel } from "./createModel.js";
import type { AppConfig } from "../types/index.js";
import type { Scope } from "../scope/Scope.js";

function mockScope(config: AppConfig): Scope {
  return { config } as unknown as Scope;
}

const baseConfig: AppConfig = {
  defaultModel: "gpt4",
  endpoints: [
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
    { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-ds" },
  ],
  models: [
    { id: "gpt4", name: "GPT-4", endpointId: "openai", modelName: "gpt-4", tokenThresholds: { handoff: 128000, guard: 192000 } },
    { id: "gpt4-no-modelname", name: "GPT-4 No Name", endpointId: "openai", tokenThresholds: { handoff: 128000, guard: 192000 } },
    { id: "ds-v3", name: "DeepSeek V3", endpointId: "deepseek", modelName: "deepseek-v3", tokenThresholds: { handoff: 64000, guard: 96000 }, defaultParams: { temperature: 0.7 } },
  ],
};

describe("createModel", () => {
  it("正常创建模型", () => {
    const model = createModel(mockScope(baseConfig), "gpt4");
    expect(model).toBeDefined();
    expect(model.client).toBeDefined();
    expect(model.model).toBe("gpt-4");
  });

  it("modelId 不存在时报错", () => {
    expect(() => createModel(mockScope(baseConfig), "non-existent")).toThrow("not found");
  });

  it("endpointId 找不到时报错", () => {
    const badConfig: AppConfig = {
      defaultModel: "bad",
      endpoints: [],
      models: [{ id: "bad", name: "Bad", endpointId: "missing-ep", tokenThresholds: { handoff: 1000, guard: 1500 } }],
    };
    expect(() => createModel(mockScope(badConfig), "bad")).toThrow("is not configured");
  });

  it("endpoint apiKey 为空时抛出明确错误", () => {
    const noKeyConfig: AppConfig = {
      defaultModel: "no-key",
      endpoints: [{ id: "no-key-ep", name: "No Key", baseUrl: "https://example.com/v1", apiKey: "" }],
      models: [{ id: "no-key", name: "No Key Model", endpointId: "no-key-ep", tokenThresholds: { handoff: 1000, guard: 1500 } }],
    };
    expect(() => createModel(mockScope(noKeyConfig), "no-key")).toThrow(
      'API key for endpoint "No Key" is not set',
    );
  });

  it("modelName 不填时回退到 id", () => {
    const model = createModel(mockScope(baseConfig), "gpt4-no-modelname");
    expect(model).toBeDefined();
    expect(model.model).toBe("gpt4-no-modelname");
  });

  it("传递 defaultParams", () => {
    const model = createModel(mockScope(baseConfig), "ds-v3");
    expect(model).toBeDefined();
    expect(model.modelConfig).toEqual({ temperature: 0.7 });
  });

  it("空 models 数组时报错", () => {
    const emptyConfig: AppConfig = { defaultModel: "none", endpoints: [], models: [] };
    expect(() => createModel(mockScope(emptyConfig), "none")).toThrow("not found");
  });

  it("空 endpoints 数组时报错", () => {
    const noEpConfig: AppConfig = {
      defaultModel: "m",
      endpoints: [],
      models: [{ id: "m", name: "M", endpointId: "ep", tokenThresholds: { handoff: 1000, guard: 1500 } }],
    };
    expect(() => createModel(mockScope(noEpConfig), "m")).toThrow("is not configured");
  });
});

describe("createModel：Agent 级参数覆盖（浅合并，SDK 不解释键名）", () => {
  const cfg: AppConfig = {
    defaultModel: "glm",
    endpoints: [{ id: "ep", name: "EP", baseUrl: "https://e/v1", apiKey: "k" }],
    models: [
      {
        id: "glm",
        name: "GLM",
        endpointId: "ep",
        tokenThresholds: { handoff: 1000, guard: 1500 },
        defaultParams: { thinking: { type: "enabled" }, reasoning_effort: "max", temperature: 0.3 },
      },
      {
        id: "bare",
        name: "Bare",
        endpointId: "ep",
        tokenThresholds: { handoff: 1000, guard: 1500 },
      },
    ],
  };

  it("无覆盖 → 原样返回模型的 defaultParams", () => {
    expect(createModel(mockScope(cfg), "glm").modelConfig).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      temperature: 0.3,
    });
  });

  it("空覆盖 → 等同于无覆盖（不凭空造空对象）", () => {
    expect(createModel(mockScope(cfg), "glm", {}).modelConfig).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      temperature: 0.3,
    });
    expect(createModel(mockScope(cfg), "bare", {}).modelConfig).toBeUndefined();
  });

  it("有覆盖 → 浅合并：同名键被覆盖，其它键保留", () => {
    expect(
      createModel(mockScope(cfg), "glm", { thinking: { type: "disabled" }, reasoning_effort: "low" })
        .modelConfig,
    ).toEqual({ thinking: { type: "disabled" }, reasoning_effort: "low", temperature: 0.3 });
  });

  it("模型没有 defaultParams 时，覆盖即全部参数", () => {
    expect(createModel(mockScope(cfg), "bare", { reasoning_effort: "high" }).modelConfig).toEqual({
      reasoning_effort: "high",
    });
  });

  it("合并是浅层的：嵌套对象整体替换，不做深合并", () => {
    // 档位补丁整块替换 thinking，绝不残留上一个档位里多出来的子键
    const model = createModel(mockScope(cfg), "glm", { thinking: { budget_tokens: 1024 } });
    expect(model.modelConfig!.thinking).toEqual({ budget_tokens: 1024 });
    expect((model.modelConfig!.thinking as Record<string, unknown>).type).toBeUndefined();
  });

  it("两个 Agent 用同一模型、各配一套参数，互不影响", () => {
    const a = createModel(mockScope(cfg), "glm", { reasoning_effort: "high" });
    const b = createModel(mockScope(cfg), "glm", { reasoning_effort: "off" });
    expect(a.modelConfig!.reasoning_effort).toBe("high");
    expect(b.modelConfig!.reasoning_effort).toBe("off");
    // 模型自身配置未被污染
    expect(cfg.models[0]!.defaultParams!.reasoning_effort).toBe("max");
  });
});
