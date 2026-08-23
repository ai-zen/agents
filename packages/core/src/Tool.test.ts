import { describe, it, expect } from "vitest";
import { Tool } from "./Tool.js";
import { ToolCallContext } from "./ToolCallContext.js";

describe("Tool 基类", () => {
  it("type 默认为 'function'", () => {
    const tool = new (class extends Tool {
      function = {
        name: "fn",
        description: "",
        parameters: { type: "object", properties: {} },
      } as Tool["function"];
      async exec() {
        return "";
      }
    })();

    expect(tool.type).toBe("function");
  });

  it("子类通过类体字段提供 function 定义", () => {
    const tool = new (class extends Tool {
      function = {
        name: "testFn",
        description: "测试函数",
        parameters: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
        },
      } as Tool["function"];
      async exec(ctx: ToolCallContext) {
        return `executed ${ctx.function_call.name}`;
      }
    })();

    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("testFn");
    expect(tool.function.description).toBe("测试函数");
  });

  it("子类通过构造函数赋值 this.function 也可行", () => {
    const tool = new (class extends Tool {
      constructor() {
        super();
        this.function = {
          name: "ctorFn",
          description: "",
          parameters: { type: "object", properties: {} },
        };
      }
      async exec() {
        return "";
      }
    })();

    expect(tool.function.name).toBe("ctorFn");
  });

  it("exec 方法应被子类正确重写", async () => {
    const tool = new (class extends Tool {
      function = {
        name: "greet",
        description: "问候",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      } as Tool["function"];
      async exec(ctx: ToolCallContext) {
        const args = ctx.parsedArgs;
        return `你好, ${args.name}!`;
      }
    })();

    const mockCtx = {
      function_call: { name: "greet", arguments: '{"name":"世界"}' },
      parsedArgs: { name: "世界" },
    } as any;

    const result = await tool.exec(mockCtx);
    expect(result).toBe("你好, 世界!");
  });
});
