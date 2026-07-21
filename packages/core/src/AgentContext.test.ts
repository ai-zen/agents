import { describe, it, expect } from "vitest";
import { AgentContext } from "./AgentContext.js";
import { Message } from "./Message.js";
import { AgentNS } from "./AgentNS.js";
import { Tool } from "./Tool.js";

describe("AgentContext", () => {
  it("应使用有效 model 正确构造", () => {
    const ctx = new AgentContext({
      model: {} as any,
    });
    expect(ctx.model).toBeDefined();
    expect(ctx.messages).toEqual([]);
    expect(ctx.tools).toEqual([]);
    expect(ctx.rag).toBeUndefined();
    expect(ctx.allowJsonParseError).toBe(true);
  });

  it("缺少 model 时应抛出错误", () => {
    expect(() => {
      new AgentContext({} as any);
    }).toThrow("AgentContext must have a model");
  });

  it("应接受自定义配置", () => {
    const tool1 = new (class extends Tool {
      constructor() {
        super({
          function: { name: "fn1", description: "", parameters: { type: "object", properties: {} } },
        });
      }
      async exec() {
        return "ok";
      }
    })();

    const ctx = new AgentContext({
      model: {} as any,
      model_config: { temperature: 0.7 },
      messages: [Message.System("你好")],
      tools: [tool1],
      allowJsonParseError: false,
    });

    expect(ctx.model_config).toEqual({ temperature: 0.7 });
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].role).toBe(AgentNS.Role.System);
    expect(ctx.tools).toHaveLength(1);
    expect(ctx.allowJsonParseError).toBe(false);
  });

  describe("append", () => {
    it("应添加消息并返回最后一条", () => {
      const ctx = new AgentContext({ model: {} as any });
      const msg = Message.User("测试消息");
      const result = ctx.append(msg);

      expect(ctx.messages).toHaveLength(1);
      expect(result).toBe(msg);
      expect(result.content).toBe("测试消息");
    });

    it("多次 append 应累积消息", () => {
      const ctx = new AgentContext({ model: {} as any });
      ctx.append(Message.System("角色设定"));
      ctx.append(Message.User("问题1"));
      ctx.append(Message.Assistant());

      expect(ctx.messages).toHaveLength(3);
    });
  });

  it("默认 allowJsonParseError 为 true", () => {
    const ctx = new AgentContext({ model: {} as any });
    expect(ctx.allowJsonParseError).toBe(true);
  });

  // ---- onUnknownTool ----

  describe("onUnknownTool", () => {
    it("不设置时应为 undefined", () => {
      const ctx = new AgentContext({ model: {} as any });
      expect(ctx.onUnknownTool).toBeUndefined();
    });

    it("应接受同步函数", () => {
      const ctx = new AgentContext({
        model: {} as any,
        onUnknownTool: (ctx) => `工具 "${ctx.toolCall.function?.name}" 不可用`,
      });
      expect(ctx.onUnknownTool).toBeDefined();
    });

    it("应接受异步函数", () => {
      const ctx = new AgentContext({
        model: {} as any,
        onUnknownTool: async (ctx) => `工具 "${ctx.toolCall.function?.name}" 不可用，可用工具: ${ctx.availableTools.map((t) => t.function.name).join(", ")}`,
      });
      expect(ctx.onUnknownTool).toBeDefined();
    });

    it("同步函数应正确返回结果", () => {
      const ctx = new AgentContext({
        model: {} as any,
        onUnknownTool: (ctx) => `未知工具: ${ctx.toolCall.function?.name}，请使用可用工具。`,
      });

      const result = ctx.onUnknownTool!({
        toolCall: { function: { name: "Foo" } },
        availableTools: [],
      });
      expect(result).toBe("未知工具: Foo，请使用可用工具。");
    });

    it("异步函数应正确返回结果", async () => {
      const ctx = new AgentContext({
        model: {} as any,
        onUnknownTool: async (ctx) => {
          const names = ctx.availableTools.map((t) => t.function.name).join(", ");
          return `未知工具 "${ctx.toolCall.function?.name}"，可用工具: [${names}]`;
        },
      });

      const result = await ctx.onUnknownTool!({
        toolCall: { function: { name: "Bar" } },
        availableTools: [
          { function: { name: "readFile" } } as Tool,
          { function: { name: "writeFile" } } as Tool,
        ],
      });
      expect(result).toBe('未知工具 "Bar"，可用工具: [readFile, writeFile]');
    });

    it("应接收正确的 UnknownToolContext 参数", () => {
      const ctx = new AgentContext({
        model: {} as any,
        onUnknownTool: (ctx) => {
          expect(ctx.toolCall).toHaveProperty("function");
          expect(ctx.toolCall.function).toHaveProperty("name");
          expect(ctx.availableTools).toBeInstanceOf(Array);
          return "ok";
        },
      });

      ctx.onUnknownTool!({
        toolCall: { id: "call_123", type: "function", function: { name: "test", arguments: "{}" } },
        availableTools: [{ function: { name: "test" } } as Tool],
      });
    });
  });
});
