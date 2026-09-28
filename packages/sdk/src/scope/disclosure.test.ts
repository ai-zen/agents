import { describe, it, expect } from "vitest";
import { createDisclosureParam } from "./disclosure.js";

describe("createDisclosureParam", () => {
  const baseDesc = "选择一个 Skill";
  const emptyHint = "（当前没有可用的 Skill，请联系用户添加）";

  it("有候选项时 — 返回枚举 + 原描述", () => {
    const result = createDisclosureParam(["code-review", "deploy"], baseDesc, emptyHint);

    expect(result.type).toBe("string");
    expect(result.description).toBe(baseDesc);
    expect(result.enum).toEqual(["code-review", "deploy"]);
  });

  it("无候选项时 — 无枚举，描述追加提示", () => {
    const result = createDisclosureParam([], baseDesc, emptyHint);

    expect(result.type).toBe("string");
    expect(result.description).toBe(`${baseDesc} ${emptyHint}`);
    expect(result.enum).toBeUndefined();
  });

  it("单个候选项", () => {
    const result = createDisclosureParam(["only-one"], baseDesc, emptyHint);

    expect(result.enum).toEqual(["only-one"]);
  });
});
