import { describe, it, expect } from "vitest";
import type { AppConfig, Model } from "../types/index.js";
import {
  DEFAULT_HANDOFF_THRESHOLD,
  migrateConfig,
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
      defaultModel: "m",
      endpoints: [],
      models: [legacyModel({ tokenThresholds: { handoff: 1, guard: 2 } })],
    } as unknown as AppConfig;
    const result = migrateConfig(config);
    expect(result.changed).toBe(false);
    expect(result.config).toBe(config);
  });

  it("只迁移部分模型时，未变的条目保持同一引用", () => {
    const ok = legacyModel({ tokenThresholds: { handoff: 1, guard: 2 } });
    const bad = legacyModel({ maxContextTokens: 100_000 });
    const config = { defaultModel: "m", endpoints: [], models: [ok, bad] } as unknown as AppConfig;

    const result = migrateConfig(config);
    expect(result.changed).toBe(true);
    expect(result.config.models![0]).toBe(ok);
    expect((result.config.models![1] as unknown as Record<string, unknown>).tokenThresholds).toEqual({
      handoff: 100_000,
      guard: 150_000,
    });
  });
});
