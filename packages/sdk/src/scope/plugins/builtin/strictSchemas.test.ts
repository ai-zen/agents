import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { discoverBuiltinTools } from "./discover.js";
import { makeEnv } from "../../../test-support/test-helpers.js";

/**
 * 严格模式（`tools[].function.strict: true`）对 JSON Schema 有两条硬要求，SDK 无条件下发那个开关，
 * 所以每一个工具定义都必须满足：
 *
 * 1. 每一层对象都要有 `additionalProperties: false`；
 * 2. 声明出来的属性必须全部出现在 `required` 里 —— 真正可选的靠「类型并上 `null`」表达，
 *    工具实现把 `null` 当没传。
 *
 * 不满足的后果是整条请求失败（有的服务方回 `invalid_function_parameters`，有的直接 400），
 * 而且只有真正走一次工具调用的模型才会撞上。这条用例就是那道闸：新增工具忘了这两条，测试先红。
 */
function violations(node: unknown, path = ""): string[] {
  if (node === null || typeof node !== "object") return [];
  const schema = node as Record<string, any>;
  const found: string[] = [];

  if (schema.type === "object" || schema.properties !== undefined) {
    if (schema.additionalProperties !== false) {
      found.push(`${path || "<根>"}: 缺 additionalProperties: false`);
    }
    const required = new Set<string>(schema.required ?? []);
    for (const key of Object.keys(schema.properties ?? {})) {
      if (!required.has(key)) found.push(`${path ? `${path}.` : ""}${key}: 不在 required 里`);
    }
  }
  if (schema.items !== undefined) found.push(...violations(schema.items, `${path}[]`));
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    found.push(...violations(child, path ? `${path}.${key}` : key));
  }
  return found;
}

describe("内置工具的 schema 符合严格模式", () => {
  const env = makeEnv(tmpdir());

  it("每一个内置工具都过关", () => {
    const tools = discoverBuiltinTools(env);
    expect(tools.length).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const tool of tools) {
      for (const line of violations(tool.function.parameters)) {
        problems.push(`${tool.function.name} → ${line}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("可选的参数写成「类型带 null」，而不是省略", () => {
    // 抽查两条：read.range 是可选的数组，glob.path 是可选的字符串
    const tools = discoverBuiltinTools(env);
    const byName = new Map(tools.map((tool) => [tool.function.name, tool]));

    const range = (byName.get("read")!.function.parameters as any).properties.range;
    expect(range.type).toEqual(["array", "null"]);
    expect((byName.get("read")!.function.parameters as any).required).toContain("range");

    const path = (byName.get("glob")!.function.parameters as any).properties.path;
    expect(path.type).toEqual(["string", "null"]);
  });
});
