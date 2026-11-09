/**
 * 模型三级解析 —— 整个仓库唯一的解析顺序就这几行，所以用例按「哪一级赢」逐条钉住。
 *
 * 这些用例不碰磁盘、不碰 Scope：解析是纯函数，行为必须能被一眼看懂（顺序即需求）。
 */
import { describe, expect, it } from "vitest";
import { resolveModel } from "./resolveModel.js";

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
