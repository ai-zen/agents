import { describe, it, expect, vi } from "vitest";
import { CallbackTool } from "./CallbackTool.js";
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
    result_message: Message.Tool({ id: "1", function: { name: functionName } }),
  });
}

describe("CallbackTool", () => {
  it("构造函数缺少 function 应抛出错误", () => {
    expect(() => {
      new CallbackTool({} as any);
    }).toThrow("CallbackTool must have a function");
  });

  it("应执行回调并返回序列化结果", async () => {
    const callback = vi.fn((args: any) => `你好, ${args.name}!`);

    const tool = new CallbackTool({
      function: {
        name: "greet",
        description: "问候某人",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "名称" },
          },
          required: ["name"],
        },
      },
      callback,
    });

    const agent = createMockAgent();
    const ctx = createMockCtx(agent, "greet", { name: "世界" });

    const result = await tool.exec(ctx);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ name: "世界" });
    expect(result).toBe("你好, 世界!");
  });

  it("回调返回对象时应序列化为 JSON", async () => {
    const tool = new CallbackTool({
      function: {
        name: "getInfo",
        description: "获取信息",
        parameters: {
          type: "object",
          properties: {},
        },
      },
      callback: () => ({ code: 200, message: "ok" }),
    });

    const agent = createMockAgent();
    const ctx = createMockCtx(agent, "getInfo", {});

    const result = await tool.exec(ctx);
    expect(result).toBe('{"code":200,"message":"ok"}');
  });

  it("回调返回 undefined 时应返回空字符串", async () => {
    const tool = new CallbackTool({
      function: {
        name: "noop",
        description: "什么都不做",
        parameters: { type: "object", properties: {} },
      },
      callback: () => undefined,
    });

    const agent = createMockAgent();
    const ctx = createMockCtx(agent, "noop", {});

    const result = await tool.exec(ctx);
    // JSON.stringify(undefined) 返回 undefined，?? "" 兜底为空字符串
    expect(result).toBe("");
  });

  it("this 上下文应为 FunctionCallContext", async () => {
    let contextThis: any = null;
    const tool = new CallbackTool({
      function: {
        name: "contextCheck",
        description: "检查上下文",
        parameters: { type: "object", properties: {} },
      },
      callback: function (this: any) {
        contextThis = this;
        return "ok";
      },
    });

    const agent = createMockAgent();
    const ctx = createMockCtx(agent, "contextCheck", {});

    await tool.exec(ctx);
    expect(contextThis).toBeInstanceOf(FunctionCallContext);
    expect(contextThis.function_call.name).toBe("contextCheck");
  });
});
