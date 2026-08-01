import { describe, it, expect } from "vitest";
import path from "node:path";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import { makeEnv } from "../capabilities/implements/builtin/test-helpers.js";
import type { ToolEnv } from "../types/index.js";
import type { FunctionCallContext } from "@ai-zen/agents-core";

class TestTool extends SdkCallbackTool {
  private fn: (input: any) => unknown;

  constructor(env: ToolEnv, fn: (input: any) => unknown) {
    super({
      function: {
        name: "test_tool",
        description: "test",
        parameters: { type: "object", properties: {}, required: [] },
      },
      env,
    });
    this.fn = fn;
  }

  call(input: any): unknown {
    return this.fn(input);
  }
}

function makeCtx(input: unknown): FunctionCallContext {
  return { parsed_args: input } as unknown as FunctionCallContext;
}

describe("SdkCallbackTool", () => {
  it("env 在构造时注入，可被子类访问", () => {
    const env = makeEnv("/ws");
    const tool = new TestTool(env, () => "");
    expect(tool.env).toBe(env);
  });

  it("exec: call 返回字符串时原样返回", async () => {
    const tool = new TestTool(makeEnv("/ws"), () => "hello");
    expect(await tool.exec(makeCtx({}))).toBe("hello");
  });

  it("exec: call 返回对象时序列化为 JSON", async () => {
    const tool = new TestTool(makeEnv("/ws"), () => ({ ok: true, n: 1 }));
    expect(await tool.exec(makeCtx({}))).toBe(JSON.stringify({ ok: true, n: 1 }));
  });

  it("exec: call 返回 undefined 时返回空串，不破坏 Promise<string> 契约", async () => {
    const tool = new TestTool(makeEnv("/ws"), () => undefined);
    expect(await tool.exec(makeCtx({}))).toBe("");
  });

  it("exec: call 返回 null 时序列化为 'null'", async () => {
    const tool = new TestTool(makeEnv("/ws"), () => null);
    expect(await tool.exec(makeCtx({}))).toBe("null");
  });

  it("resolve: 相对路径解析到 env.cwd", () => {
    const tool = new TestTool(makeEnv("/ws"), () => "");
    expect(tool.resolve("a/b.txt")).toBe(path.join("/ws", "a/b.txt"));
  });

  it("resolve: 绝对路径原样返回", () => {
    const tool = new TestTool(makeEnv("/ws"), () => "");
    const abs = path.isAbsolute("/abs/c.txt") ? "/abs/c.txt" : path.resolve("/abs/c.txt");
    expect(tool.resolve("/abs/c.txt")).toBe(abs);
  });

  it("resolve: 空字符串解析为 env.cwd 本身", () => {
    const tool = new TestTool(makeEnv("/ws"), () => "");
    expect(tool.resolve("")).toBe(path.join("/ws", ""));
  });
});
