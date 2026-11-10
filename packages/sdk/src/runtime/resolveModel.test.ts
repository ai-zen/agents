/**
 * 模型三级解析 —— 整个仓库唯一的解析顺序就这几行，所以用例按「哪一级赢」逐条钉住。
 *
 * 这些用例不碰磁盘、不碰 Scope：解析是纯函数，行为必须能被一眼看懂（顺序即需求）。
 */
import { describe, expect, it } from "vitest";
import { resolveModel, resolveModelParams } from "./resolveModel.js";

describe("resolveModel：会话级 > Agent 定义 > 全局兜底", () => {
  it("三级都有值时会话级覆盖赢", () => {
    expect(resolveModel({ sessionModelId: "s", agentModelId: "a", defaultModel: "g" })).toEqual({
      modelId: "s",
      level: "session",
    });
  });

  it("没有会话级覆盖时 Agent 定义赢（全局兜底不该越位）", () => {
    expect(resolveModel({ agentModelId: "a", defaultModel: "g" })).toEqual({
      modelId: "a",
      level: "agent",
    });
  });

  it("定义没绑模型时才轮到全局兜底", () => {
    expect(resolveModel({ defaultModel: "g" })).toEqual({ modelId: "g", level: "global" });
  });

  it("三级全空返回 null（调用方据此报「这个 Agent 没有模型」，不静默挑一个）", () => {
    expect(resolveModel({})).toBeNull();
  });

  it("空串按「没配」算，不会顶掉下一级的真值", () => {
    expect(resolveModel({ sessionModelId: "", agentModelId: "a" })).toEqual({
      modelId: "a",
      level: "agent",
    });
    expect(resolveModel({ sessionModelId: "", agentModelId: "", defaultModel: "g" })).toEqual({
      modelId: "g",
      level: "global",
    });
  });
});

/**
 * 参数解析 —— 与模型的三级解析一一对应：**取「模型来自哪一级」那一份，绝不跨级混合**。
 *
 * 这一组用例的重点不是「三档各取哪份」，而是**跨级那一对**：会话级换了模型之后，
 * 定义上那份参数绝不能跟过去（旧模型的思考参数发给新模型 = 端点 400）。
 */
describe("resolveModelParams：参数跟着模型来自哪一级走", () => {
  const sessionParams = { reasoning_effort: "high" };
  const agentParams = { thinking: { type: "disabled" } };

  it("模型来自会话级 → 取会话级参数", () => {
    expect(
      resolveModelParams({
        level: "session",
        sessionModelParams: sessionParams,
        agentModelParams: agentParams,
      }),
    ).toEqual(sessionParams);
  });

  it("跨级不混合：会话级模型在场时，定义上的参数一个都不许跟过来", () => {
    const params = resolveModelParams({
      level: "session",
      sessionModelParams: sessionParams,
      agentModelParams: agentParams,
    });

    expect(params).toEqual(sessionParams);
    // 旧模型那套 `thinking: disabled` 发给新模型就是 400 —— 它不该出现在结果里
    expect(params).not.toHaveProperty("thinking");
  });

  it("会话级没设参数 → 不带覆盖（只用模型出厂参数），也不退回去用定义那份", () => {
    expect(resolveModelParams({ level: "session", agentModelParams: agentParams })).toBeUndefined();
  });

  it("模型来自 Agent 定义 → 取定义参数（一直是这个行为，不许变）", () => {
    expect(
      resolveModelParams({
        level: "agent",
        sessionModelParams: sessionParams,
        agentModelParams: agentParams,
      }),
    ).toEqual(agentParams);
  });

  it("模型来自全局兜底 → 没有可取的层，不带任何覆盖", () => {
    // 这一级只有 `config.defaultModel`，任何一层的参数挪过来都是跨级混合
    expect(
      resolveModelParams({
        level: "global",
        sessionModelParams: sessionParams,
        agentModelParams: agentParams,
      }),
    ).toBeUndefined();
  });
});
