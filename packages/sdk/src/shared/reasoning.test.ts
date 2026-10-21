import { describe, it, expect } from "vitest";
import type { Model, ReasoningEffort } from "../types/index.js";
import { DEFAULT_APP_CONFIG } from "../config/constants.js";
import {
  applyReasoningEffort,
  capabilityOf,
  isReasoningEffort,
  modelAllowedEfforts,
  modelEfforts,
  readReasoningEffort,
  resolveModelParams,
  resolveReasoningEffort,
} from "./reasoning.js";

/** 模型工厂：只关心 id + reasoning 声明 */
function model(id: string, reasoning?: Model["reasoning"], defaultParams?: Record<string, unknown>): Model {
  return {
    id,
    name: id,
    endpointId: "e",
    tokenThresholds: { handoff: 1000, guard: 1500 },
    defaultParams,
    reasoning,
  } as Model;
}

/** DeepSeek：可调 low/high/max，可关闭（thinking.type） */
const DEEPSEEK = model(
  "deepseek-flash",
  { efforts: ["low", "high", "max"], disable: "thinking" },
  { thinking: { type: "enabled" } },
);
/** 智谱 GLM-5.3 系：只认 low/high/max，且不能关 */
const GLM53 = model(
  "glm-5.3",
  { efforts: ["low", "high", "max"] },
  { thinking: { type: "enabled" }, reasoning_effort: "max" },
);
/** OpenAI：没有 thinking 参数，靠 effort=none 关闭 */
const OPENAI = model("gpt-6.1-sol", { efforts: ["minimal", "low", "medium", "high"], disable: "effort-none" }, {});
/** 强制思考且无 effort 参数（GLM-4.7） */
const FORCED = model("glm-4.7-flash", { efforts: [] }, {});
/** 未声明能力 */
const UNDECLARED = model("whatever", undefined, { temperature: 0.3 });

describe("能力声明与出厂模型", () => {
  it("出厂清单按官方文档声明能力（关键型号抽查）", () => {
    const byId = new Map((DEFAULT_APP_CONFIG.models ?? []).map((m) => [m.id, m]));

    // DeepSeek：low/high/max + 可关闭
    expect(byId.get("deepseek-flash")!.reasoning).toEqual({
      efforts: ["low", "high", "max"],
      disable: "thinking",
    });
    // 智谱 5.3 系：只有三档且无 disable（传 disabled 会报错，故不能出现 off）
    for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"]) {
      expect(byId.get(id)!.reasoning).toEqual({ efforts: ["low", "high", "max"] });
    }
    // GLM-4.7：强制思考、无 effort 参数
    expect(byId.get("glm-4.7-flash")!.reasoning).toEqual({ efforts: [] });
    // OpenAI：靠 effort=none 关闭，没有 thinking
    expect(byId.get("gpt-6.1-sol")!.reasoning).toEqual({
      efforts: ["minimal", "low", "medium", "high"],
      disable: "effort-none",
    });
  });

  it("modelAllowedEfforts：off 只在声明了 disable 时出现", () => {
    expect(modelEfforts(DEEPSEEK)).toEqual(["low", "high", "max"]);
    expect(modelAllowedEfforts(DEEPSEEK)).toEqual(["off", "low", "high", "max"]);
    expect(modelAllowedEfforts(GLM53)).toEqual(["low", "high", "max"]); // 无 off
    expect(modelAllowedEfforts(FORCED)).toEqual([]);
    expect(modelAllowedEfforts(UNDECLARED)).toEqual([]);
    expect(modelAllowedEfforts(null)).toEqual([]);
  });

  it("isReasoningEffort 严格校验", () => {
    expect(isReasoningEffort("high")).toBe(true);
    expect(isReasoningEffort("off")).toBe(true);
    expect(isReasoningEffort("HIGH")).toBe(false);
    expect(isReasoningEffort("ultra")).toBe(false);
    expect(capabilityOf(GLM53)).toEqual({ efforts: ["low", "high", "max"] });
  });
});

describe("readReasoningEffort：读取现状", () => {
  it("thinking 关闭 → off（优先级最高）", () => {
    expect(readReasoningEffort({ thinking: { type: "disabled" }, reasoning_effort: "high" })).toBe("off");
  });

  it("reasoning_effort 合法值原样返回", () => {
    expect(readReasoningEffort({ reasoning_effort: "max" })).toBe("max");
    expect(readReasoningEffort({ reasoning_effort: "xhigh" })).toBe("xhigh");
  });

  it("none 归一为 off，避免菜单出现两个「关」", () => {
    expect(readReasoningEffort({ reasoning_effort: "none" })).toBe("off");
  });

  it("开了思考但没写档位（DeepSeek 出厂）→ undefined", () => {
    expect(readReasoningEffort({ thinking: { type: "enabled" } })).toBeUndefined();
    expect(readReasoningEffort({})).toBeUndefined();
    expect(readReasoningEffort(null)).toBeUndefined();
  });

  it("非法值视为未声明", () => {
    expect(readReasoningEffort({ reasoning_effort: "ultra" })).toBeUndefined();
  });
});

describe("applyReasoningEffort：按能力声明选择写入形态", () => {
  it("DeepSeek：开关 + 档位都写", () => {
    expect(applyReasoningEffort({ thinking: { type: "enabled" } }, DEEPSEEK, "high")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(applyReasoningEffort({ thinking: { type: "enabled" } }, DEEPSEEK, "off")).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("GLM-5.3：只写 reasoning_effort，绝不动 thinking", () => {
    const next = applyReasoningEffort({ thinking: { type: "enabled" }, reasoning_effort: "max" }, GLM53, "low");
    expect(next).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" });
    expect(next).not.toHaveProperty("thinking.type.disabled");
  });

  it("GLM-5.3 设 medium 抛错（官方：其余输入将报错）", () => {
    expect(() => applyReasoningEffort({}, GLM53, "medium")).toThrow(/不支持档位 "medium"/);
  });

  it("GLM-5.3 设 off 抛错（官方：thinking.type 传 disabled 会报错）", () => {
    expect(() => applyReasoningEffort({}, GLM53, "off")).toThrow(/不支持关闭思考/);
  });

  it("OpenAI：只写 reasoning_effort，永不出现 thinking 键", () => {
    const on = applyReasoningEffort({}, OPENAI, "medium");
    expect(on).toEqual({ reasoning_effort: "medium" });
    expect(on).not.toHaveProperty("thinking");

    const off = applyReasoningEffort({}, OPENAI, "off");
    expect(off).toEqual({ reasoning_effort: "none" });
    expect(off).not.toHaveProperty("thinking");
  });

  it("不可调档的模型（efforts 为空）→ 抛错", () => {
    expect(() => applyReasoningEffort({}, FORCED, "high")).toThrow(/不支持档位/);
    expect(() => applyReasoningEffort({}, UNDECLARED, "high")).toThrow(/未声明思考能力/);
  });

  it("不改入参，且保留无关参数", () => {
    const params = { thinking: { type: "enabled" }, temperature: 0.7 };
    const next = applyReasoningEffort(params, DEEPSEEK, "low");
    expect(next.temperature).toBe(0.7);
    expect(params).toEqual({ thinking: { type: "enabled" }, temperature: 0.7 });
  });

  it("往返一致：每个合法档位写入后都能读回", () => {
    for (const m of [DEEPSEEK, GLM53, OPENAI]) {
      for (const effort of modelAllowedEfforts(m)) {
        const next = applyReasoningEffort(m.defaultParams, m, effort as ReasoningEffort);
        expect(readReasoningEffort(next)).toBe(effort);
      }
    }
  });
});

describe("resolveModelParams：Agent 级覆盖", () => {
  it("未声明 reasoningEffort → 原样返回模型参数（既有行为不变）", () => {
    expect(resolveModelParams(GLM53, {})).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(resolveModelParams(GLM53, null)).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
  });

  it("声明了 → 覆盖模型参数（同一模型给不同 Agent 不同强度）", () => {
    expect(resolveModelParams(GLM53, { reasoningEffort: "low" })).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    });
    expect(resolveModelParams(DEEPSEEK, { reasoningEffort: "off" })).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("声明了模型不支持的值 → 退回模型默认（不发非法参数）", () => {
    expect(resolveModelParams(GLM53, { reasoningEffort: "medium" })).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    expect(resolveModelParams(UNDECLARED, { reasoningEffort: "high" })).toEqual({ temperature: 0.3 });
  });
});

describe("resolveReasoningEffort：实际生效档位", () => {
  it("Agent 声明优先", () => {
    expect(resolveReasoningEffort(GLM53, { reasoningEffort: "low" })).toBe("low");
  });

  it("未声明 → 读模型默认参数", () => {
    expect(resolveReasoningEffort(GLM53, {})).toBe("max");
    expect(resolveReasoningEffort(DEEPSEEK, {})).toBeUndefined(); // 出厂只有开关，无档位
  });

  it("Agent 声明非法 → 回退模型默认", () => {
    expect(resolveReasoningEffort(GLM53, { reasoningEffort: "xhigh" })).toBe("max");
  });
});
