import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentTool } from "./AgentTool.js";
import { Agent } from "../Agent.js";
import { Message } from "../Message.js";
import { AgentNS } from "../AgentNS.js";
import { FunctionCallContext } from "../FunctionCallContext.js";
import { AsyncQueue } from "@ai-zen/async-queue";

// Helper: 创建 mock 模型，始终返回固定文本
function createMockModel(responseText = "mock回复") {
  const queue = new AsyncQueue<AgentNS.StreamResponseData>();
  queue.push({
    choices: [{
      index: 0,
      delta: { content: responseText },
      finish_reason: null,
    }],
  });
  queue.push({
    choices: [{
      index: 0,
      delta: {},
      finish_reason: AgentNS.FinishReason.Stop,
    }],
  });
  queue.done();

  return {
    createStream: vi.fn(() => queue),
    createCompletion: vi.fn(),
    code: "mock-model",
    title: "Mock Model",
    type: "chat_completion",
    name: "MockModel",
    model_config: {},
    request_config: { url: "https://test.com", headers: {}, body: {} },
  } as any;
}

describe("AgentTool", () => {
  describe("构造函数", () => {
    it("缺少 function 应抛出错误", () => {
      expect(() => {
        new AgentTool({} as any);
      }).toThrow("AgentTool must have a function");
    });

    it("最后一条消息不是 User 时应抛出错误", () => {
      expect(() => {
        new AgentTool({
          function: {
            name: "test",
            description: "test",
            parameters: { type: "object", properties: {}, required: [] },
          },
          model: {} as any,
          messages: [Message.System("你好"), Message.Assistant("回复")],
        });
      }).toThrow("AgentTool must end with a user message.");
    });

    it("应正确构造", () => {
      const model = createMockModel();
      const tool = new AgentTool({
        function: {
          name: "getWeather",
          description: "获取天气",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "城市" },
            },
            required: ["city"],
          },
        },
        model,
        messages: [
          Message.System("你是天气助手"),
          Message.User("请告诉我 {{ city }} 的天气"),
        ],
      });

      expect(tool.function.name).toBe("getWeather");
      expect(tool.type).toBe("function");
      expect(tool.messages).toHaveLength(2);
    });
  });

  describe("replaceStringWithValues", () => {
    it("应替换模板中的变量", () => {
      const result = AgentTool.replaceStringWithValues(
        "你好 {{ name }}，今天{{ date }}的天气是{{ weather }}",
        { name: "张三", date: "2024-01-01", weather: "晴天" },
      );
      expect(result).toBe("你好 张三，今天2024-01-01的天气是晴天");
    });

    it("未提供的变量应保持原样", () => {
      const result = AgentTool.replaceStringWithValues(
        "你好 {{ name }}",
        {},
      );
      expect(result).toBe("你好 {{ name }}");
    });

    it("变量名支持大小写和下划线", () => {
      const result = AgentTool.replaceStringWithValues(
        "{{user_name}} 今年 {{ age }} 岁",
        { user_name: "李四", age: "25" },
      );
      expect(result).toBe("李四 今年 25 岁");
    });
  });

  describe("injectArgs", () => {
    it("应注入参数到消息内容中", () => {
      const messages = [
        Message.System("你是天气助手"),
        Message.User("请告诉我 {{ city }} 在 {{ date }} 的天气"),
      ];

      // injectArgs 是静态方法，但需要通过实例访问（protected），这里直接用原型
      const result = AgentTool.injectArgs.call(
        { constructor: { name: "AgentTool" } },
        messages,
        { city: "北京", date: "2024-01-15" },
      );

      expect(result[0].content).toBe("你是天气助手"); // system 不变
      expect(result[1].content).toBe("请告诉我 北京 在 2024-01-15 的天气");
    });

    it("应深拷贝消息列表，不修改原始数据", () => {
      const originalContent = "请告诉我 {{ city }} 的天气";
      const messages = [Message.User(originalContent)];

      AgentTool.injectArgs.call(
        { constructor: { name: "AgentTool" } },
        messages,
        { city: "上海" },
      );

      expect(messages[0].content).toBe(originalContent);
    });

    it("非字符串内容应保持不变", () => {
      const sections: AgentNS.MessageContentSection[] = [
        { type: "text", text: "描述 {{ city }}" },
        { type: "image_url", image_url: { url: "https://example.com/img.png" } },
      ];
      const messages = [Message.User(sections)];

      const result = AgentTool.injectArgs.call(
        { constructor: { name: "AgentTool" } },
        messages,
        { city: "广州" },
      );

      // 数组内容不做替换（injectArgs 对数组类型 content 不做替换）
      expect(Array.isArray(result[0].content)).toBe(true);
      expect((result[0].content as AgentNS.MessageContentSection[])[0].type).toBe("text");
    });
  });

  describe("exec", () => {
    it("应执行子 Agent 并返回结果", async () => {
      const model = createMockModel('{"temperature":25,"weather":"晴天"}');
      const tool = new AgentTool({
        function: {
          name: "getWeather",
          description: "获取天气",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "城市" },
            },
            required: ["city"],
          },
        },
        model,
        messages: [
          Message.System("你是天气助手，返回 JSON"),
          Message.User("请告诉我 {{ city }} 的天气"),
        ],
      });

      const agent = new Agent({
        model: createMockModel(),
        messages: [Message.System("主助手")],
        tools: [tool],
      });

      const ctx = new FunctionCallContext({
        agent,
        function_call: {
          name: "getWeather",
          arguments: '{"city":"北京"}',
        },
        result_message: Message.Tool({ id: "1", function: { name: "getWeather" } }),
      });

      const result = await tool.exec(ctx);
      expect(result).toBe('{"temperature":25,"weather":"晴天"}');
    });

    it("子 Agent 执行时应在 agent.events 上触发 sub-agent 事件", async () => {
      const model = createMockModel("子Agent回复");
      const tool = new AgentTool({
        function: {
          name: "testFn",
          description: "测试",
          parameters: { type: "object", properties: {}, required: [] },
        },
        model,
        messages: [Message.User("你好")],
      });

      const agent = new Agent({
        model: createMockModel(),
        messages: [Message.System("主助手")],
        tools: [tool],
      });

      const subAgentHandler = vi.fn();
      agent.events.on("sub-agent", subAgentHandler);

      const ctx = new FunctionCallContext({
        agent,
        function_call: { name: "testFn", arguments: "{}" },
        result_message: Message.Tool({ id: "1", function: { name: "testFn" } }),
      });

      await tool.exec(ctx);

      expect(subAgentHandler).toHaveBeenCalledTimes(1);
      expect(subAgentHandler.mock.calls[0][0].agent).toBeDefined();
    });
  });
});
