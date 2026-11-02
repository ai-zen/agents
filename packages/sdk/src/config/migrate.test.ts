import { describe, it, expect } from "vitest";
import type { AppConfig, Model } from "../types/index.js";
import {
  DEFAULT_HANDOFF_THRESHOLD,
  migrateConfig,
  migrateModelReasoning,
  migrateModelThresholds,
} from "./migrate.js";

/** 旧形状的模型（含已淘汰字段），断言时按未索引对象处理 */
function legacyModel(fields: Record<string, unknown>): Model {
  return { id: "m", name: "M", endpointId: "e", ...fields } as unknown as Model;
}

function raw(model: Model): Record<string, unknown> {
  return JSON.parse(JSON.stringify(model)) as Record<string, unknown>;
}

describe("migrateModelThresholds", () => {
  it("maxContextTokens → handoff，并按 1.5 折算 guard（沿用旧行为）", () => {
    const { model, changed } = migrateModelThresholds(legacyModel({ maxContextTokens: 250_000 }));
    expect(changed).toBe(true);
    const out = raw(model);
    expect(out.tokenThresholds).toEqual({ handoff: 250_000, guard: 375_000 });
    expect(out).not.toHaveProperty("maxContextTokens");
    expect(out).not.toHaveProperty("maxContextChars");
  });

  it("maxContextChars 按 /4 折算成 tokens（与旧代码回退算法一致）", () => {
    const { model } = migrateModelThresholds(legacyModel({ maxContextChars: 1_000_000 }));
    expect(raw(model).tokenThresholds).toEqual({ handoff: 250_000, guard: 375_000 });
  });

  it("两者都有时以 tokens 为准", () => {
    const { model } = migrateModelThresholds(
      legacyModel({ maxContextTokens: 100_000, maxContextChars: 4_000_000 }),
    );
    expect(raw(model).tokenThresholds).toEqual({ handoff: 100_000, guard: 150_000 });
  });

  it("小模型不会被抬到过大的 guard（按 1.5 折算而非固定常量）", () => {
    const { model } = migrateModelThresholds(legacyModel({ maxContextTokens: 32_000 }));
    expect(raw(model).tokenThresholds).toEqual({ handoff: 32_000, guard: 48_000 });
  });

  it("两个旧字段都没有时用兜底默认", () => {
    const { model, changed } = migrateModelThresholds(legacyModel({}));
    expect(changed).toBe(true);
    expect(raw(model).tokenThresholds).toEqual({
      handoff: DEFAULT_HANDOFF_THRESHOLD,
      guard: DEFAULT_HANDOFF_THRESHOLD * 1.5,
    });
  });

  it("已是新形状 → 不迁移（changed = false，返回原对象）", () => {
    const source = legacyModel({ tokenThresholds: { handoff: 250_000, guard: 375_000 } });
    const { model, changed } = migrateModelThresholds(source);
    expect(changed).toBe(false);
    expect(model).toBe(source);
  });

  it("有 handoff 但缺 guard → 补齐 guard", () => {
    const { model, changed } = migrateModelThresholds(
      legacyModel({ tokenThresholds: { handoff: 200_000 } }),
    );
    expect(changed).toBe(true);
    expect(raw(model).tokenThresholds).toEqual({ handoff: 200_000, guard: 300_000 });
  });

  it("旧字段与新字段同时存在 → 以新字段为准并清掉旧字段", () => {
    const { model } = migrateModelThresholds(
      legacyModel({ maxContextTokens: 999, tokenThresholds: { handoff: 250_000, guard: 375_000 } }),
    );
    const out = raw(model);
    expect(out.tokenThresholds).toEqual({ handoff: 250_000, guard: 375_000 });
    expect(out).not.toHaveProperty("maxContextTokens");
  });

  it("脏值（0 / 负数 / 非数字）视为缺失", () => {
    for (const bad of [0, -1, "250000", null]) {
      const { model } = migrateModelThresholds(legacyModel({ maxContextTokens: bad }));
      expect(raw(model).tokenThresholds).toEqual({
        handoff: DEFAULT_HANDOFF_THRESHOLD,
        guard: DEFAULT_HANDOFF_THRESHOLD * 1.5,
      });
    }
  });

  it("不改入参对象", () => {
    const source = legacyModel({ maxContextTokens: 250_000 });
    migrateModelThresholds(source);
    expect(raw(source)).toHaveProperty("maxContextTokens", 250_000);
  });
});

describe("migrateConfig", () => {
  it("只迁移 models，imageModels 原样保留", () => {
    const config = {
      defaultModel: "m",
      endpoints: [],
      models: [legacyModel({ maxContextTokens: 250_000 })],
      imageModels: [{ id: "img", name: "IMG", endpointId: "e", modelName: "img" }],
    } as unknown as AppConfig;

    const result = migrateConfig(config);
    expect(result.changed).toBe(true);
    const models = result.config.models as unknown as Record<string, unknown>[];
    expect(models[0].tokenThresholds).toEqual({ handoff: 250_000, guard: 375_000 });
    expect(result.config.imageModels).toBe(config.imageModels);
  });

  it("无需迁移时返回原对象（避免无谓写盘）", () => {
    const config = {
      endpoints: [],
      models: [legacyModel({ tokenThresholds: { handoff: 1, guard: 2 } })],
      abortedMessageStrategy: "keep",
      abortedToolRoundStrategy: "fill",
    } as unknown as AppConfig;
    const result = migrateConfig(config);
    expect(result.changed).toBe(false);
    expect(result.config).toBe(config);
  });

  it("清除已废弃的 config.defaultModel", () => {
    const config = {
      defaultModel: "m",
      endpoints: [],
      models: [legacyModel({ tokenThresholds: { handoff: 1, guard: 2 } })],
    } as unknown as AppConfig;
    const result = migrateConfig(config);
    expect(result.changed).toBe(true);
    expect("defaultModel" in result.config).toBe(false);
    // 原始对象不被就地改（Scope 可能持有它的引用）
    expect("defaultModel" in config).toBe(true);
  });

  it("只迁移部分模型时，未变的条目保持同一引用", () => {
    const ok = legacyModel({ tokenThresholds: { handoff: 1, guard: 2 } });
    const bad = legacyModel({ maxContextTokens: 100_000 });
    const config = { endpoints: [], models: [ok, bad] } as unknown as AppConfig;

    const result = migrateConfig(config);
    expect(result.changed).toBe(true);
    expect(result.config.models![0]).toBe(ok);
    expect(
      (result.config.models![1] as unknown as Record<string, unknown>).tokenThresholds,
    ).toEqual({
      handoff: 100_000,
      guard: 150_000,
    });
  });
  it("补齐缺失的中断策略，原对象不被就地改", () => {
    const config = { endpoints: [], models: [] } as unknown as AppConfig;
    const result = migrateConfig(config);
    expect(result.changed).toBe(true);
    expect(result.config.abortedMessageStrategy).toBe("keep");
    expect(result.config.abortedToolRoundStrategy).toBe("fill");
    expect(config.abortedMessageStrategy).toBeUndefined();
  });

  it("中断策略非法 → 改写成出厂默认；合法值原样保留", () => {
    const bad = migrateConfig({
      endpoints: [],
      models: [],
      abortedMessageStrategy: "nope",
      abortedToolRoundStrategy: "fill",
    } as unknown as AppConfig);
    expect(bad.changed).toBe(true);
    expect(bad.config.abortedMessageStrategy).toBe("keep");
    expect(bad.config.abortedToolRoundStrategy).toBe("fill");

    const kept = migrateConfig({
      endpoints: [],
      models: [],
      abortedMessageStrategy: "drop",
      abortedToolRoundStrategy: "drop",
    } as unknown as AppConfig);
    expect(kept.changed).toBe(false);
    expect(kept.config.abortedMessageStrategy).toBe("drop");
    expect(kept.config.abortedToolRoundStrategy).toBe("drop");
  });
});

describe("migrateModelReasoning：reasoning → reasoningPreset", () => {
  it("标了 custom 的出厂模型：删旧字段并按同 id 补回策略名（否则默默失去调档能力）", () => {
    const model = legacyModel({
      id: "glm-5.3",
      custom: true,
      tokenThresholds: { handoff: 1, guard: 2 },
      reasoning: { efforts: ["low", "high", "max"] },
    });
    const { model: next, changed } = migrateModelReasoning(model);
    expect(changed).toBe(true);
    expect(raw(next)).not.toHaveProperty("reasoning");
    expect(next.reasoningPreset).toBe("zhipu-5.3");
  });

  it("id 不在出厂清单 → 只删旧字段，不瞎猜策略", () => {
    const model = legacyModel({
      id: "my-own-model",
      custom: true,
      tokenThresholds: { handoff: 1, guard: 2 },
      reasoning: { efforts: ["low", "high"] },
    });
    const { model: next } = migrateModelReasoning(model);
    expect(raw(next)).not.toHaveProperty("reasoning");
    expect(next.reasoningPreset).toBeUndefined();
  });

  it("已有 reasoningPreset → 保留用户选择，只清旧字段", () => {
    const model = legacyModel({
      id: "glm-5.3",
      reasoningPreset: "openai",
      reasoning: { efforts: ["low", "high", "max"] },
    });
    const { model: next } = migrateModelReasoning(model);
    expect(next.reasoningPreset).toBe("openai");
    expect(raw(next)).not.toHaveProperty("reasoning");
  });

  it("没有旧字段 → 不动（用户主动删掉 preset 后不会被反复补回）", () => {
    const model = legacyModel({ id: "glm-5.3", custom: true });
    const result = migrateModelReasoning(model);
    expect(result.changed).toBe(false);
    expect(result.model).toBe(model);
    expect(model.reasoningPreset).toBeUndefined();
  });

  it("不改入参", () => {
    const model = legacyModel({
      id: "deepseek-flash",
      reasoning: { efforts: ["low", "high", "max"], disable: "thinking" },
    });
    const before = JSON.stringify(model);
    migrateModelReasoning(model);
    expect(JSON.stringify(model)).toBe(before);
  });

  it("migrateConfig 同时处理阈值与思考字段", () => {
    const model = legacyModel({
      id: "deepseek-flash",
      custom: true,
      maxContextTokens: 250_000,
      reasoning: { efforts: ["low", "high", "max"], disable: "thinking" },
    });
    const config = { defaultModel: "m", endpoints: [], models: [model] } as unknown as AppConfig;

    const result = migrateConfig(config);
    expect(result.changed).toBe(true);
    const out = raw(result.config.models![0]!);
    expect(out.tokenThresholds).toEqual({ handoff: 250_000, guard: 375_000 });
    expect(out).not.toHaveProperty("reasoning");
    expect(out.reasoningPreset).toBe("deepseek");
  });
});

describe("normalizeEndpointCapabilities：补齐端点缺失的能力位", () => {
  const endpoint = (fields: Record<string, unknown>) =>
    ({
      id: "deepseek",
      name: "DeepSeek",
      apiKey: "sk-x",
      baseUrl: "https://api.deepseek.com/v1",
      ...fields,
    }) as any;

  /** 中断策略显式给足：否则 normalizeAbortStrategies 自己就会把 changed 置 true，干扰断言 */
  const configOf = (endpoints: any[]) =>
    ({
      endpoints,
      models: [],
      imageModels: [],
      abortedMessageStrategy: "keep",
      abortedToolRoundStrategy: "fill",
    }) as unknown as AppConfig;

  it("老配置里 deepseek 缺 capabilities → 按出厂补上 filesApi（alpha.12 之前的老用户）", () => {
    const { config, changed } = migrateConfig(configOf([endpoint({})]));
    expect(changed).toBe(true);
    expect(config.endpoints[0]!.capabilities).toEqual({ filesApi: true });
  });

  it("用户显式写了 filesApi: false → 绝不覆盖（那是明确表态）", () => {
    const { config, changed } = migrateConfig(
      configOf([endpoint({ capabilities: { filesApi: false } })]),
    );
    expect(config.endpoints[0]!.capabilities).toEqual({ filesApi: false });
    expect(changed).toBe(false);
  });

  it("capabilities 已存在（哪怕空对象）→ 一个字段都不动", () => {
    const { config, changed } = migrateConfig(configOf([endpoint({ capabilities: {} })]));
    expect(config.endpoints[0]!.capabilities).toEqual({});
    expect(changed).toBe(false);
  });

  it("用户自建端点（id 不在出厂清单）→ 不动（猜错会把上传打到不存在的 /files）", () => {
    const { config, changed } = migrateConfig(
      configOf([endpoint({ id: "my-own", name: "Mine", baseUrl: "https://example.test/v1" })]),
    );
    expect(config.endpoints[0]!.capabilities).toBeUndefined();
    expect(changed).toBe(false);
  });

  it("出厂也没有能力的端点（如 openai）→ 不凭空造能力位", () => {
    const { config, changed } = migrateConfig(
      configOf([endpoint({ id: "openai", name: "OpenAI" })]),
    );
    expect(config.endpoints[0]!.capabilities).toBeUndefined();
    expect(changed).toBe(false);
  });

  it("幂等：补过一次之后再跑就不再有改动（迁移只发生一次）", () => {
    const first = migrateConfig(configOf([endpoint({})]));
    expect(first.changed).toBe(true);
    const second = migrateConfig(first.config);
    expect(second.changed).toBe(false);
    expect(second.config.endpoints[0]!.capabilities).toEqual({ filesApi: true });
  });

  it("不把副作用浇到调用方手里的旧对象上", () => {
    const original = endpoint({});
    migrateConfig(configOf([original]));
    expect(original.capabilities).toBeUndefined();
  });
});
