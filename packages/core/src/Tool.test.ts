import { describe, it, expect } from "vitest";
import { Tool } from "./Tool.js";
import { FunctionCallContext } from "./FunctionCallContext.js";

describe("Tool 基类", () => {
  it("缺少 function 时应抛出错误", () => {
    expect(() => {
      new (class extends Tool {
        async exec() {
          return "ok";
        }
      })({} as any);
    }).toThrow("Tool must have a function");
  });

  it("应正确设置 type 和 function 属性", () => {
    const tool = new (class extends Tool {
      constructor() {
        super({
          function: {
            name: "testFn",
            description: "测试函数",
            parameters: {
              type: "object",
              properties: { x: { type: "string" } },
              required: ["x"],
            },
          },
        });
      }
      async exec(ctx: FunctionCallContext) {
        return `executed ${ctx.function_call.name}`;
      }
    })();

    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("testFn");
    expect(tool.function.description).toBe("测试函数");
  });

  it("type 默认为 'function'", () => {
    const tool = new (class extends Tool {
      constructor() {
        super({
          function: {
            name: "fn",
            description: "",
            parameters: { type: "object", properties: {} },
          },
        });
      }
      async exec() {
        return "";
      }
    })();

    expect(tool.type).toBe("function");
  });

  it("exec 方法应被子类正确重写", async () => {
    const tool = new (class extends Tool {
      constructor() {
        super({
          function: {
            name: "greet",
            description: "问候",
            parameters: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        });
      }
      async exec(ctx: FunctionCallContext) {
        const args = ctx.parsed_args;
        return `你好, ${args.name}!`;
      }
    })();

    const mockCtx = {
      function_call: { name: "greet", arguments: '{"name":"世界"}' },
      parsed_args: { name: "世界" },
    } as any;

    const result = await tool.exec(mockCtx);
    expect(result).toBe("你好, 世界!");
  });

  it("Tool 应实现 AgentNS.ToolDefine 接口", () => {
    const tool = new (class extends Tool {
      constructor() {
        super({
          function: {
            name: "fn",
            description: "desc",
            parameters: { type: "object", properties: {} },
          },
        });
      }
      async exec() {
        return "";
      }
    })();

    // 验证实现了 ToolDefine 接口
    expect(tool.type).toBe("function");
    expect(tool.function).toBeDefined();
    expect(tool.function.name).toBe("fn");
  });
});
