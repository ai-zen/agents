import { describe, it, expect, vi } from "vitest";
import { ToolCallContext, FunctionCallContext } from "./ToolCallContext.js";
import { Agent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";

// 创建一个最小可用的 Agent mock
function createMockAgent(): Agent {
  return new Agent({
    client: {} as any,
    model: "gpt-4",
    messages: [Message.System("测试助手")],
    tools: [],
  });
}

describe("ToolCallContext", () => {
  describe("构造函数 - JSON 解析", () => {
    it("应正确解析合法 JSON 参数", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: "1", function: { name: "fn" } });

      const ctx = new ToolCallContext({
        agent,
        tool_call: { function: { name: "fn", arguments: '{"city":"北京","count":3}' } },
        resultMessage: resultMsg,
      });

      expect(ctx.parsedArgs).toEqual({ city: "北京", count: 3 });
      expect(ctx.parseError).toBeUndefined();
    });

    it("解析失败且 allowJsonParseError=true 时不应抛出异常", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: "1", function: { name: "fn" } });

      const ctx = new ToolCallContext({
        agent,
        tool_call: { function: { name: "fn", arguments: "{invalid json}" } },
        resultMessage: resultMsg,
        allowJsonParseError: true,
      });

      expect(ctx.parsedArgs).toBeUndefined();
      expect(ctx.parseError).toBeDefined();
      expect(typeof ctx.parseError).toBe("string");
    });

    it("解析失败且 allowJsonParseError=false 时应抛出异常", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: "1", function: { name: "fn" } });

      expect(() => {
        new ToolCallContext({
          agent,
          tool_call: { function: { name: "fn", arguments: "{invalid}" } },
          resultMessage: resultMsg,
          allowJsonParseError: false,
        });
      }).toThrow();
    });

    it("arguments 为 undefined 时 parsed_args 应为 undefined", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: "1", function: { name: "fn" } });

      const ctx = new ToolCallContext({
        agent,
        tool_call: { function: { name: "fn" } },
        resultMessage: resultMsg,
      });

      expect(ctx.parsedArgs).toBeUndefined();
      expect(ctx.parseError).toBeUndefined();
    });
  });

  describe("preventDefault", () => {
    it("调用后 is_prevent_default 应变为 true", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: "1", function: { name: "fn" } });

      const ctx = new ToolCallContext({
        agent,
        tool_call: { function: { name: "fn", arguments: "{}" } },
        result_message: resultMsg,
      });

      expect(ctx.isPreventDefault).toBe(false);
      ctx.preventDefault();
      expect(ctx.isPreventDefault).toBe(true);
    });
  });

  describe("构造函数 - 字段赋值", () => {
    it("应正确保存 agent 引用", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: "1", function: { name: "fn" } });

      const ctx = new ToolCallContext({
        agent,
        tool_call: { function: { name: "fn", arguments: "{}" } },
        resultMessage: resultMsg,
      });

      expect(ctx.agent).toBe(agent);
      expect(ctx.function_call.name).toBe("fn");
      expect(ctx.resultMessage).toBe(resultMsg);
    });

    it("应正确保存统一形状 tool_call 与兼容字段 function_call", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: "call_1", function: { name: "fn" } });

      const ctx = new ToolCallContext({
        agent,
        tool_call: {
          id: "call_1",
          type: "function",
          function: { name: "fn", arguments: '{"x":1}' },
        },
        tool: {} as any,
        resultMessage: resultMsg,
      });

      // 统一形状
      expect(ctx.tool_call.id).toBe("call_1");
      expect(ctx.tool_call.function?.name).toBe("fn");
      // 兼容字段（旧工具实现仍可用）
      expect(ctx.function_call.name).toBe("fn");
      // 匹配到的工具
      expect(ctx.tool).toBeDefined();
      // parsedArgs 由 tool_call.function.arguments 解析
      expect(ctx.parsedArgs).toEqual({ x: 1 });
    });
  });

  describe("向下兼容别名 FunctionCallContext", () => {
    it("应等价于 ToolCallContext（同一个类，可构造 / instanceof / 类型注解）", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: "1", function: { name: "fn" } });

      // 旧 API 仍可 new FunctionCallContext(...)
      const ctx = new FunctionCallContext({
        agent,
        tool_call: { function: { name: "fn", arguments: '{"x":1}' } },
        resultMessage: resultMsg,
      });

      expect(FunctionCallContext).toBe(ToolCallContext);
      expect(ctx).toBeInstanceOf(ToolCallContext);
      expect(ctx).toBeInstanceOf(FunctionCallContext);
      expect(ctx.parsedArgs).toEqual({ x: 1 });
    });
  });
});
