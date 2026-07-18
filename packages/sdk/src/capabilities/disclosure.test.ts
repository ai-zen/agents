import { describe, it, expect } from "vitest";
import { buildDisclosureParam } from "./disclosure.js";

describe("buildDisclosureParam", () => {
  const baseDesc = "选择一个 Skill";
  const emptyHint = "（当前没有可用的 Skill，请联系用户添加）";

  it("有候选项时 — 返回枚举 + 原描述", () => {
    const items = [
      { id: "code-review", description: "代码审查" },
      { id: "deploy", description: "部署工具" },
    ];

    const result = buildDisclosureParam(items, baseDesc, emptyHint);

    expect(result.type).toBe("string");
    expect(result.description).toBe(baseDesc);
    expect(result.enum).toEqual(["code-review", "deploy"]);
  });

  it("无候选项时 — 无枚举，描述追加提示", () => {
    const result = buildDisclosureParam([], baseDesc, emptyHint);

    expect(result.type).toBe("string");
    expect(result.description).toBe(`${baseDesc} ${emptyHint}`);
    expect(result.enum).toBeUndefined();
  });

  it("单个候选项", () => {
    const result = buildDisclosureParam(
      [{ id: "only-one", description: "唯一" }],
      baseDesc,
      emptyHint,
    );

    expect(result.enum).toEqual(["only-one"]);
  });
});
