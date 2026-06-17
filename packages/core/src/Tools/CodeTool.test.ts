import { describe, it, expect, vi } from "vitest";
import { CodeTool } from "./CodeTool.js";
import { FunctionCallContext } from "../FunctionCallContext.js";
import { Agent } from "../Agent.js";
import { Message } from "../Message.js";

function createMockAgent(): Agent {
  return new Agent({ model: {} as any, messages: [Message.System("test")], tools: [] });
}

function createMockCtx(
  agent: Agent,
  functionName: string,
  parsedArgs: any,
): FunctionCallContext {
  return new FunctionCallContext({
    agent,
    function_call: { name: functionName, arguments: JSON.stringify(parsedArgs) },
    result_message: Message.Tool({ id: 1, function: { name: functionName } }),
  });
}

describe("CodeTool", () => {
  it("构造函数缺少 function 应抛出错误", () => {
    expect(() => {
      new CodeTool({} as any);
    }).toThrow("CodeTool must have a function");
  });

  it("应执行动态函数并返回计算结果（字符串）", async () => {
    const tool = new CodeTool({
      function: {
        name: "add",
        description: "两个数相加",
        parameters: {
          type: "object",
          properties: {
            a: { type: "number", description: "数字a" },
            b: { type: "number", description: "数字b" },
          },
          required: ["a", "b"],
        },
      },
      code: "return a + b;",
    });

    const agent = createMockAgent();
    const ctx = createMockCtx(agent, "add", { a: 3, b: 7 });

    const result = await tool.exec(ctx);
    expect(result).toBe("10");
  });

  it("应执行动态函数并返回计算结果（对象->JSON）", async () => {
    const tool = new CodeTool({
      function: {
        name: "formatData",
        description: "格式化数据",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "number" },
          },
          required: ["name", "value"],
        },
      },
      code: "return { name, value: value * 2 };",
    });

    const agent = createMockAgent();
    const ctx = createMockCtx(agent, "formatData", { name: "test", value: 5 });

    const result = await tool.exec(ctx);
    expect(result).toBe('{"name":"test","value":10}');
  });

  it("应传递所有参数，缺失的参数为 undefined", async () => {
    const tool = new CodeTool({
      function: {
        name: "logArgs",
        description: "打印参数",
        parameters: {
          type: "object",
          properties: {
            x: { type: "string" },
            y: { type: "string" },
          },
          required: ["x"],
        },
      },
      code: "return JSON.stringify({ x, y });",
    });

    const agent = createMockAgent();
    const ctx = createMockCtx(agent, "logArgs", { x: "hello" });

    const result = await tool.exec(ctx);
    // JSON.stringify 会忽略值为 undefined 的键，所以结果中只有 x
    const parsed = JSON.parse(result);
    expect(parsed.x).toBe("hello");
    expect(parsed).not.toHaveProperty("y"); // y 为 undefined, JSON.stringify 忽略
  });

  it("没有 code 时应返回空字符串", async () => {
    const tool = new CodeTool({
      function: {
        name: "noop",
        description: "什么都不做",
        parameters: { type: "object", properties: {} },
      },
    } as any);

    const agent = createMockAgent();
    const ctx = createMockCtx(agent, "noop", {});

    const result = await tool.exec(ctx);
    // JSON.stringify(undefined) 返回 undefined，?? "" 兜底为空字符串
    expect(result).toBe("");
  });
});
