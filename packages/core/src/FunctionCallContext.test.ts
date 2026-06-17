import { describe, it, expect, vi } from "vitest";
import { FunctionCallContext } from "./FunctionCallContext.js";
import { Agent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";

// 创建一个最小可用的 Agent mock
function createMockAgent(): Agent {
  return new Agent({
    model: {} as any,
    messages: [Message.System("测试助手")],
    tools: [],
  });
}

describe("FunctionCallContext", () => {
  describe("构造函数 - JSON 解析", () => {
    it("应正确解析合法 JSON 参数", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: 1, function: { name: "fn" } });

      const ctx = new FunctionCallContext({
        agent,
        function_call: { name: "fn", arguments: '{"city":"北京","count":3}' },
        result_message: resultMsg,
      });

      expect(ctx.parsed_args).toEqual({ city: "北京", count: 3 });
      expect(ctx.parse_error).toBeUndefined();
    });

    it("解析失败且 allowJsonParseError=true 时不应抛出异常", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: 1, function: { name: "fn" } });

      const ctx = new FunctionCallContext({
        agent,
        function_call: { name: "fn", arguments: "{invalid json}" },
        result_message: resultMsg,
        allowJsonParseError: true,
      });

      expect(ctx.parsed_args).toBeUndefined();
      expect(ctx.parse_error).toBeDefined();
      expect(typeof ctx.parse_error).toBe("string");
    });

    it("解析失败且 allowJsonParseError=false 时应抛出异常", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: 1, function: { name: "fn" } });

      expect(() => {
        new FunctionCallContext({
          agent,
          function_call: { name: "fn", arguments: "{invalid}" },
          result_message: resultMsg,
          allowJsonParseError: false,
        });
      }).toThrow();
    });

    it("arguments 为 undefined 时 parsed_args 应为 undefined", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: 1, function: { name: "fn" } });

      const ctx = new FunctionCallContext({
        agent,
        function_call: { name: "fn" },
        result_message: resultMsg,
      });

      expect(ctx.parsed_args).toBeUndefined();
      expect(ctx.parse_error).toBeUndefined();
    });
  });

  describe("preventDefault", () => {
    it("调用后 is_prevent_default 应变为 true", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: 1, function: { name: "fn" } });

      const ctx = new FunctionCallContext({
        agent,
        function_call: { name: "fn", arguments: "{}" },
        result_message: resultMsg,
      });

      expect(ctx.is_prevent_default).toBe(false);
      ctx.preventDefault();
      expect(ctx.is_prevent_default).toBe(true);
    });
  });

  describe("构造函数 - 字段赋值", () => {
    it("应正确保存 agent 引用", () => {
      const agent = createMockAgent();
      const resultMsg = Message.Tool({ id: 1, function: { name: "fn" } });

      const ctx = new FunctionCallContext({
        agent,
        function_call: { name: "fn", arguments: "{}" },
        result_message: resultMsg,
      });

      expect(ctx.agent).toBe(agent);
      expect(ctx.function_call.name).toBe("fn");
      expect(ctx.result_message).toBe(resultMsg);
    });
  });
});
