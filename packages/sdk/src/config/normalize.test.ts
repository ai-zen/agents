import { describe, it, expect } from "vitest";
import type { AppConfig, ModelDefinition } from "../types/index.js";
import {
  DEFAULT_HANDOFF_THRESHOLD,
  normalizeConfig,
  normalizeModelThresholds,
} from "./normalize.js";

/** 一个模型（只填用例关心的那几格，其余走 type assertion） */
function model(fields: Record<string, unknown> = {}): ModelDefinition {
  return { id: "m", name: "M", endpointId: "e", ...fields } as unknown as ModelDefinition;
}

function raw(value: ModelDefinition): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

const FACTORY_THRESHOLDS = {
  handoff: DEFAULT_HANDOFF_THRESHOLD,
  guard: DEFAULT_HANDOFF_THRESHOLD * 1.5,
};

describe("normalizeModelThresholds：缺阈值补出厂值", () => {
  it("两条都缺 → 补 handoff 出厂值与 1.5 倍的 guard", () => {
    const { model: next, changed } = normalizeModelThresholds(model());
    expect(changed).toBe(true);
    expect(raw(next).tokenThresholds).toEqual(FACTORY_THRESHOLDS);
  });

  it("已是完整形状（两条都在）→ 不改，返回原对象", () => {
    const source = model({ tokenThresholds: { handoff: 250_000, guard: 375_000 } });
    const { model: next, changed } = normalizeModelThresholds(source);
    expect(changed).toBe(false);
    expect(next).toBe(source);
  });

  it("有 handoff 但缺 guard → 按 1.5 倍补齐 guard", () => {
    const { model: next, changed } = normalizeModelThresholds(
      model({ tokenThresholds: { handoff: 200_000 } }),
    );
    expect(changed).toBe(true);
    expect(raw(next).tokenThresholds).toEqual({ handoff: 200_000, guard: 300_000 });
  });

  it("只有 guard → handoff 补出厂值，guard 是用户的数、不动", () => {
    const { model: next, changed } = normalizeModelThresholds(
      model({ tokenThresholds: { guard: 200_000 } }),
    );
    expect(changed).toBe(true);
    expect(raw(next).tokenThresholds).toEqual({
      handoff: DEFAULT_HANDOFF_THRESHOLD,
      guard: 200_000,
    });
  });

  it("脏值（0 / 负数 / 非数字 / null）视为没填 → 补出厂值", () => {
    for (const bad of [0, -1, "250000", null, Number.NaN]) {
      const { model: next } = normalizeModelThresholds(
        model({ tokenThresholds: { handoff: bad, guard: bad } }),
      );
      expect(raw(next).tokenThresholds).toEqual(FACTORY_THRESHOLDS);
    }
  });

  it("tokenThresholds 整格不是对象（手改坏）→ 补出厂值", () => {
    for (const bad of [null, "250000", 42, []]) {
      const { model: next } = normalizeModelThresholds(model({ tokenThresholds: bad }));
      expect(raw(next).tokenThresholds).toEqual(FACTORY_THRESHOLDS);
    }
  });

  it("不改入参对象", () => {
    const source = model({ tokenThresholds: { handoff: 200_000 } });
    normalizeModelThresholds(source);
    expect(raw(source).tokenThresholds).toEqual({ handoff: 200_000 });
  });
});

describe("normalizeConfig", () => {
  it("只补 models，imageModels 原样保留", () => {
    const config = {
      defaultModel: "m",
      endpoints: [],
      models: [model()],
      imageModels: [{ id: "img", name: "IMG", endpointId: "e", modelName: "img" }],
    } as unknown as AppConfig;

    const result = normalizeConfig(config);
    expect(result.changed).toBe(true);
    const models = result.config.models as unknown as Record<string, unknown>[];
    expect(models[0]!.tokenThresholds).toEqual(FACTORY_THRESHOLDS);
    expect(result.config.imageModels).toBe(config.imageModels);
  });

  it("无需改动时返回原对象（避免无谓写盘）", () => {
    const config = {
      endpoints: [],
      models: [model({ tokenThresholds: { handoff: 1, guard: 2 } })],
      abortedMessageStrategy: "keep",
      abortedToolRoundStrategy: "fill",
    } as unknown as AppConfig;
    const result = normalizeConfig(config);
    expect(result.changed).toBe(false);
    expect(result.config).toBe(config);
  });

  it("保留 config.defaultModel（三级解析的全局兜底层，不补也不清）", () => {
    const config = {
      defaultModel: "m",
      endpoints: [],
      models: [model({ tokenThresholds: { handoff: 1, guard: 2 } })],
      abortedMessageStrategy: "keep",
      abortedToolRoundStrategy: "fill",
    } as unknown as AppConfig;
    const result = normalizeConfig(config);
    expect(result.config.defaultModel).toBe("m");
    // 除此之外没什么可补的 → 不触发写盘（避免每次启动都重写 config.json）
    expect(result.changed).toBe(false);
  });

  it("同一份配置里既有缺阈值的模型、也有 defaultModel：补位只补它该补的", () => {
    const config = {
      defaultModel: "m",
      endpoints: [],
      models: [model()],
    } as unknown as AppConfig;
    const result = normalizeConfig(config);
    expect(result.changed).toBe(true);
    expect(result.config.defaultModel).toBe("m");
  });

  it("只补部分模型时，未变的InboxEntry保持同一引用", () => {
    const ok = model({ tokenThresholds: { handoff: 1, guard: 2 } });
    const missing = model({ id: "m2" });
    const config = { endpoints: [], models: [ok, missing] } as unknown as AppConfig;

    const result = normalizeConfig(config);
    expect(result.changed).toBe(true);
    expect(result.config.models![0]).toBe(ok);
    expect(
      (result.config.models![1] as unknown as Record<string, unknown>).tokenThresholds,
    ).toEqual(FACTORY_THRESHOLDS);
  });

  it("补齐缺失的中断策略，原对象不被就地改", () => {
    const config = { endpoints: [], models: [] } as unknown as AppConfig;
    const result = normalizeConfig(config);
    expect(result.changed).toBe(true);
    expect(result.config.abortedMessageStrategy).toBe("keep");
    expect(result.config.abortedToolRoundStrategy).toBe("fill");
    expect(config.abortedMessageStrategy).toBeUndefined();
  });

  it("中断策略非法 → 改写成出厂默认；合法值原样保留", () => {
    const bad = normalizeConfig({
      endpoints: [],
      models: [],
      abortedMessageStrategy: "nope",
      abortedToolRoundStrategy: "fill",
    } as unknown as AppConfig);
    expect(bad.changed).toBe(true);
    expect(bad.config.abortedMessageStrategy).toBe("keep");
    expect(bad.config.abortedToolRoundStrategy).toBe("fill");

    const kept = normalizeConfig({
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

  it("deepseek 缺 capabilities → 按出厂补上 filesApi", () => {
    const { config, changed } = normalizeConfig(configOf([endpoint({})]));
    expect(changed).toBe(true);
    expect(config.endpoints[0]!.capabilities).toEqual({ filesApi: true });
  });

  it("用户显式写了 filesApi: false → 绝不覆盖（那是明确表态）", () => {
    const { config, changed } = normalizeConfig(
      configOf([endpoint({ capabilities: { filesApi: false } })]),
    );
    expect(config.endpoints[0]!.capabilities).toEqual({ filesApi: false });
    expect(changed).toBe(false);
  });

  it("capabilities 已存在（哪怕空对象）→ 一个字段都不动", () => {
    const { config, changed } = normalizeConfig(configOf([endpoint({ capabilities: {} })]));
    expect(config.endpoints[0]!.capabilities).toEqual({});
    expect(changed).toBe(false);
  });

  it("用户自建端点（id 不在出厂清单）→ 不动（猜错会把上传打到不存在的 /files）", () => {
    const { config, changed } = normalizeConfig(
      configOf([endpoint({ id: "my-own", name: "Mine", baseUrl: "https://example.test/v1" })]),
    );
    expect(config.endpoints[0]!.capabilities).toBeUndefined();
    expect(changed).toBe(false);
  });

  it("出厂也没有能力的端点（如 openai）→ 不凭空造能力位", () => {
    const { config, changed } = normalizeConfig(
      configOf([endpoint({ id: "openai", name: "OpenAI" })]),
    );
    expect(config.endpoints[0]!.capabilities).toBeUndefined();
    expect(changed).toBe(false);
  });

  it("幂等：补过一次之后再跑就不再有改动（补位只发生一次）", () => {
    const first = normalizeConfig(configOf([endpoint({})]));
    expect(first.changed).toBe(true);
    const second = normalizeConfig(first.config);
    expect(second.changed).toBe(false);
    expect(second.config.endpoints[0]!.capabilities).toEqual({ filesApi: true });
  });

  it("不把副作用浇到调用方手里的旧对象上", () => {
    const original = endpoint({});
    normalizeConfig(configOf([original]));
    expect(original.capabilities).toBeUndefined();
  });
});
