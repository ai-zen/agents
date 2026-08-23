import { describe, it, expect, vi } from "vitest";
import { CallbackTool } from "./CallbackTool.js";
import { ToolCallContext } from "../ToolCallContext.js";
import { Agent } from "../Agent.js";
import { Message } from "../Message.js";

function createMockAgent(): Agent {
  return new Agent({ client: {} as any, model: "gpt-4", messages: [Message.System("test")], tools: [] });
}

function createMockCtx(
  agent: Agent,
  functionName: string,
  parsedArgs: any,
): ToolCallContext {
  return new ToolCallContext({
    agent,
    tool_call: { function: { name: functionName, arguments: JSON.stringify(parsedArgs) } },
    resultMessage: Message.Tool({ id: "1", function: { name: functionName } }),
  });
}

describe("CallbackTool", () => {
  it("构造时可提供 function 定义", () => {
    const tool = new CallbackTool({
      function: {
        name: "testFn",
        description: "测试",
        parameters: { type: "object", properties: {} },
      },
      callback: () => "ok",
    });
    expect(tool.function.name).toBe("testFn");
    expect(tool.type).toBe("function");
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
    expect(callback).toHaveBeenCalledWith({ name: "世界" }, ctx);
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

  it("回调返回内容块数组（图片等）时透传，不序列化", async () => {
    const sections = [
      { type: "text", text: "图片如下：" },
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ];
    const tool = new CallbackTool({
      function: {
        name: "viewImg",
        description: "查看图片",
        parameters: { type: "object", properties: {} },
      },
      callback: () => sections,
    });

    const agent = createMockAgent();
    const ctx = createMockCtx(agent, "viewImg", {});

    const result = await tool.exec(ctx);
    expect(result).toBe(sections);
  });

  it("第二参 ctx 应为 ToolCallContext", async () => {
    let receivedCtx: any = null;
    const tool = new CallbackTool({
      function: {
        name: "contextCheck",
        description: "检查上下文",
        parameters: { type: "object", properties: {} },
      },
      callback: (_parsedArgs: any, ctx: any) => {
        receivedCtx = ctx;
        return "ok";
      },
    });

    const agent = createMockAgent();
    const ctx = createMockCtx(agent, "contextCheck", {});

    await tool.exec(ctx);
    expect(receivedCtx).toBeInstanceOf(ToolCallContext);
    expect(receivedCtx.function_call.name).toBe("contextCheck");
  });
});
