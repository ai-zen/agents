import { describe, it, expect } from "vitest";
import type { Model } from "../types/index.js";
import { DEFAULT_APP_CONFIG } from "../config/constants.js";
import { FACTORY_REASONING_PRESETS } from "../config/reasoning-presets.js";
import {
  applyReasoningEffort,
  modelLevels,
  presetOf,
  readReasoningEffort,
  resolveModelParams,
  resolveReasoningEffort,
} from "./reasoning.js";

const PRESETS = FACTORY_REASONING_PRESETS;

/** 模型工厂：只关心 id + 策略名 + 默认参数 */
function model(
  id: string,
  reasoningPreset?: string,
  defaultParams?: Record<string, unknown>,
): Model {
  return {
    id,
    name: id,
    endpointId: "e",
    tokenThresholds: { handoff: 1000, guard: 1500 },
    defaultParams,
    reasoningPreset,
  } as Model;
}

/** DeepSeek：thinking 开关 + effort，可关闭 */
const DEEPSEEK = model("deepseek-flash", "deepseek", { thinking: { type: "enabled" } });
/** 智谱 GLM-5.3 系：只认 low/high/max，且不能关 */
const GLM53 = model("glm-5.3", "zhipu-5.3", {
  thinking: { type: "enabled" },
  reasoning_effort: "max",
});
/** OpenAI：没有 thinking 参数，靠 effort=none 关闭 */
const OPENAI = model("gpt-6.1-sol", "openai", {});
/** 未关联策略（如 GLM-4.7 强制思考且无 effort 参数） */
const NO_PRESET = model("glm-4.7-flash", undefined, {});
/** 引用了不存在的策略名 */
const BAD_NAME = model("whatever", "no-such-preset", { temperature: 0.3 });

describe("出厂策略表：协议事实必须写在表里", () => {
  it("OpenAI 表里不该出现 thinking 键（它没有这个参数）", () => {
    for (const patch of Object.values(PRESETS.openai!.levels)) {
      expect(patch).not.toHaveProperty("thinking");
      expect(patch).toHaveProperty("reasoning_effort");
    }
    // 关闭思考 = reasoning_effort: "none"
    expect(PRESETS.openai!.levels.off).toEqual({ reasoning_effort: "none" });
  });

  it("智谱 GLM-5.3 表里只有三档，且没有 off（官方：传 disabled 会报错）", () => {
    expect(Object.keys(PRESETS["zhipu-5.3"]!.levels)).toEqual(["low", "high", "max"]);
    expect(PRESETS["zhipu-5.3"]!.levels).not.toHaveProperty("off");
  });

  it("DeepSeek 表用 thinking.type 关闭思考", () => {
    expect(Object.keys(PRESETS.deepseek!.levels)).toEqual(["low", "high", "max", "off"]);
    expect(PRESETS.deepseek!.levels.off).toEqual({ thinking: { type: "disabled" } });
  });

  it("出厂模型引用的策略都存在（写错名字 = 运行期静默失去调档能力）", () => {
    for (const m of DEFAULT_APP_CONFIG.models ?? []) {
      if (!m.reasoningPreset) continue;
      expect(PRESETS).toHaveProperty(m.reasoningPreset);
    }
  });

  it("出厂模型的策略归属符合官方文档", () => {
    const byId = new Map((DEFAULT_APP_CONFIG.models ?? []).map((m) => [m.id, m]));
    expect(byId.get("deepseek-flash")!.reasoningPreset).toBe("deepseek");
    for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"]) {
      expect(byId.get(id)!.reasoningPreset).toBe("zhipu-5.3");
    }
    for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]) {
      expect(byId.get(id)!.reasoningPreset).toBe("openai");
    }
    // GLM-4.7：强制思考且无 reasoning_effort 参数 → 不挂策略
    expect(byId.get("glm-4.7-flash")!.reasoningPreset).toBeUndefined();
  });
});

describe("presetOf / modelLevels：可选档位 = 表的键", () => {
  it("档位顺序即声明顺序，off 就是普通一员", () => {
    expect(modelLevels(DEEPSEEK, PRESETS)).toEqual(["low", "high", "max", "off"]);
    expect(modelLevels(OPENAI, PRESETS)).toEqual(["minimal", "low", "medium", "high", "off"]);
  });

  it("没挂策略 / 策略名不存在 / 传 null → 都不可调档", () => {
    expect(modelLevels(NO_PRESET, PRESETS)).toEqual([]);
    expect(modelLevels(BAD_NAME, PRESETS)).toEqual([]);
    expect(modelLevels(null, PRESETS)).toEqual([]);
    expect(modelLevels(GLM53, null)).toEqual([]);
    expect(presetOf(BAD_NAME, PRESETS)).toBeUndefined();
    expect(presetOf(GLM53, PRESETS)).toBe(PRESETS["zhipu-5.3"]);
  });

  it("策略名是用户可写的字符串，不能顺着原型链取到东西", () => {
    const evil = model("x", "constructor", {});
    expect(presetOf(evil, PRESETS)).toBeUndefined();
    expect(modelLevels(evil, PRESETS)).toEqual([]);
  });
});

describe("readReasoningEffort：反查当前档位", () => {
  it("命中补丁即返回档位键", () => {
    expect(readReasoningEffort(GLM53, PRESETS)).toBe("max");
    expect(readReasoningEffort(DEEPSEEK, PRESETS, { thinking: { type: "disabled" } })).toBe("off");
    expect(readReasoningEffort(OPENAI, PRESETS, { reasoning_effort: "none" })).toBe("off");
  });

  it("参数不完整匹配任何档位 → undefined（如 DeepSeek 出厂只开思考不指定档位）", () => {
    expect(readReasoningEffort(DEEPSEEK, PRESETS)).toBeUndefined();
    expect(readReasoningEffort(OPENAI, PRESETS)).toBeUndefined();
    expect(readReasoningEffort(GLM53, PRESETS, {})).toBeUndefined();
    expect(readReasoningEffort(GLM53, PRESETS, null)).toBeUndefined();
  });

  it("多张补丁同时命中时取最具体的那个", () => {
    // 两个键都齐 → 命中 low（两键）；只有 thinking → 不命中任何档位
    expect(readReasoningEffort(DEEPSEEK, PRESETS, {
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    })).toBe("low");
  });

  it("未挂策略 → 永远 undefined", () => {
    expect(readReasoningEffort(NO_PRESET, PRESETS, { reasoning_effort: "high" })).toBeUndefined();
  });
});

describe("applyReasoningEffort：剔除旧键 + 合并补丁", () => {
  it("DeepSeek：开档位时写入开关与档位", () => {
    expect(applyReasoningEffort(DEEPSEEK, PRESETS, "high")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });

  it("切到 off 不会残留上一档的 reasoning_effort（脏参数会改变语义）", () => {
    const next = applyReasoningEffort(DEEPSEEK, PRESETS, "off", {
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    expect(next).toEqual({ thinking: { type: "disabled" } });
  });

  it("智谱 5.3：只改 effort，thinking 开关由表里的补丁决定", () => {
    expect(applyReasoningEffort(GLM53, PRESETS, "low")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    });
  });

  it("智谱 5.3 设 medium / off 直接抛错（官方：其余输入将报错）", () => {
    expect(() => applyReasoningEffort(GLM53, PRESETS, "medium")).toThrow(/没有档位 "medium"/);
    expect(() => applyReasoningEffort(GLM53, PRESETS, "off")).toThrow(/没有档位 "off"/);
  });

  it("OpenAI 永不出现 thinking 键", () => {
    const on = applyReasoningEffort(OPENAI, PRESETS, "medium");
    expect(on).toEqual({ reasoning_effort: "medium" });
    expect(on).not.toHaveProperty("thinking");

    const off = applyReasoningEffort(OPENAI, PRESETS, "off", { reasoning_effort: "high", thinking: { type: "enabled" } });
    expect(off).toEqual({ reasoning_effort: "none" });
  });

  it("未挂策略 / 策略名不存在 → 抛错", () => {
    expect(() => applyReasoningEffort(NO_PRESET, PRESETS, "high")).toThrow(/未关联思考策略/);
    expect(() => applyReasoningEffort(BAD_NAME, PRESETS, "high")).toThrow(/不存在/);
  });

  it("不改入参，保留无关参数", () => {
    const params = { thinking: { type: "enabled" }, temperature: 0.7 };
    const next = applyReasoningEffort(DEEPSEEK, PRESETS, "low", params);
    expect(next.temperature).toBe(0.7);
    expect(params).toEqual({ thinking: { type: "enabled" }, temperature: 0.7 });
  });

  it("往返一致：每个合法档位写入后都能读回", () => {
    for (const m of [DEEPSEEK, GLM53, OPENAI]) {
      for (const level of modelLevels(m, PRESETS)) {
        const next = applyReasoningEffort(m, PRESETS, level);
        expect(readReasoningEffort(m, PRESETS, next)).toBe(level);
      }
    }
  });
});

describe("resolveModelParams：Agent 级覆盖", () => {
  it("未声明 reasoningEffort → 原样返回模型参数（既有行为不变）", () => {
    expect(resolveModelParams(GLM53, PRESETS)).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    expect(resolveModelParams(GLM53, PRESETS, null)).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });

  it("声明了 → 覆盖模型参数（同一模型给不同 Agent 不同强度）", () => {
    expect(resolveModelParams(GLM53, PRESETS, { reasoningEffort: "low" })).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    });
    expect(resolveModelParams(DEEPSEEK, PRESETS, { reasoningEffort: "off" })).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("声明了策略里没有的值 → 退回模型默认（不发非法参数）", () => {
    expect(resolveModelParams(GLM53, PRESETS, { reasoningEffort: "medium" })).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    expect(resolveModelParams(NO_PRESET, PRESETS, { reasoningEffort: "high" })).toEqual({});
    expect(resolveModelParams(BAD_NAME, PRESETS, { reasoningEffort: "high" })).toEqual({
      temperature: 0.3,
    });
  });
});

describe("resolveReasoningEffort：实际生效档位", () => {
  it("Agent 声明优先", () => {
    expect(resolveReasoningEffort(GLM53, PRESETS, { reasoningEffort: "low" })).toBe("low");
  });

  it("未声明 → 读模型默认参数", () => {
    expect(resolveReasoningEffort(GLM53, PRESETS, {})).toBe("max");
    expect(resolveReasoningEffort(DEEPSEEK, PRESETS, {})).toBeUndefined(); // 出厂只开思考，无档位
  });

  it("Agent 声明非法 → 回退模型默认", () => {
    expect(resolveReasoningEffort(GLM53, PRESETS, { reasoningEffort: "xhigh" })).toBe("max");
    expect(resolveReasoningEffort(NO_PRESET, PRESETS, { reasoningEffort: "high" })).toBeUndefined();
  });
});
