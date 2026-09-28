import { describe, it, expect, vi } from "vitest";
import { AgentTool } from "./AgentTool.js";
import { Agent } from "../Agent.js";
import { Message } from "../Message.js";
import { AgentNS } from "../AgentNS.js";
import { ToolCallContext } from "../ToolCallContext.js";

// Helper: 创建 mock OpenAI client，始终返回固定文本
function createMockClient(responseText = "mock回复") {
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield {
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "mock",
        choices: [{ index: 0, delta: { content: responseText }, finish_reason: null }],
      };
      yield {
        id: "chunk-2",
        object: "chat.completion.chunk",
        created: 0,
        model: "mock",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
    },
  };
  const create = vi.fn(async () => stream);
  return { chat: { completions: { create } } } as any;
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
          client: {} as any,
          model: "gpt-4",
          messages: [Message.System("你好"), Message.Assistant("回复")],
        });
      }).toThrow("AgentTool must end with a user message.");
    });

    it("应正确构造", () => {
      const client = createMockClient();
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
        client,
        model: "gpt-4",
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

      const result = AgentTool.injectArgs.call(
        { constructor: { name: "AgentTool" } },
        messages,
        { city: "北京", date: "2024-01-15" },
      );

      expect(result[0].content).toBe("你是天气助手");
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

      expect(Array.isArray(result[0].content)).toBe(true);
      expect((result[0].content as AgentNS.MessageContentSection[])[0].type).toBe("text");
    });
  });

  describe("exec", () => {
    it("应执行子 Agent 并返回结果", async () => {
      const client = createMockClient('{"temperature":25,"weather":"晴天"}');
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
        client,
        model: "gpt-4",
        messages: [
          Message.System("你是天气助手，返回 JSON"),
          Message.User("请告诉我 {{ city }} 的天气"),
        ],
      });

      const agent = new Agent({
        client: createMockClient(),
        model: "gpt-4",
        messages: [Message.System("主助手")],
        tools: [tool],
      });

      const ctx = new ToolCallContext({
        agent,
        tool_call: {
          function: {
            name: "getWeather",
            arguments: '{"city":"北京"}',
          },
        },
        resultMessage: Message.Tool({ id: "1", function: { name: "getWeather" } }),
      });

      const result = await tool.exec(ctx);
      expect(result).toBe('{"temperature":25,"weather":"晴天"}');
    });

    it("子 Agent 执行时应在 agent.events 上触发 sub-agent-start 事件", async () => {
      const tool = new AgentTool({
        function: {
          name: "testFn",
          description: "测试",
          parameters: { type: "object", properties: {}, required: [] },
        },
        client: createMockClient("子Agent回复"),
        model: "gpt-4",
        messages: [Message.User("你好")],
      });

      const agent = new Agent({
        client: createMockClient(),
        model: "gpt-4",
        messages: [Message.System("主助手")],
        tools: [tool],
      });

      const subAgentHandler = vi.fn();
      agent.events.on("sub-agent-start", subAgentHandler);

      const ctx = new ToolCallContext({
        agent,
        tool_call: { function: { name: "testFn", arguments: "{}" } },
        resultMessage: Message.Tool({ id: "1", function: { name: "testFn" } }),
      });

      await tool.exec(ctx);

      expect(subAgentHandler).toHaveBeenCalledTimes(1);
      // 载荷区分主/子 Agent：agent = 主（宿主），subAgent = 子
      const payload = subAgentHandler.mock.calls[0][0];
      expect(payload.agent).toBe(agent);
      expect(payload.subAgent).toBeInstanceOf(Agent);
      expect(payload.subAgent).not.toBe(agent);
      expect(payload.toolCallContext).toBe(ctx);
    });

    it("外层 signal abort 时联动中止子 Agent", async () => {
      // 子 Agent client：返回挂起流，收到 signal abort 时结束
      const subCreate = vi.fn(async (_body: any, options: any) => {
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve());
            });
          },
        };
      });
      const subClient = { chat: { completions: { create: subCreate } } } as any;

      const tool = new AgentTool({
        function: {
          name: "hangFn",
          description: "挂起",
          parameters: { type: "object", properties: {}, required: [] },
        },
        client: subClient,
        model: "gpt-4",
        messages: [Message.User("你好")],
      });

      const agent = new Agent({
        client: createMockClient(),
        model: "gpt-4",
        messages: [Message.System("主助手")],
        tools: [tool],
      });

      const controller = new AbortController();
      const ctx = new ToolCallContext({
        agent,
        tool_call: { function: { name: "hangFn", arguments: "{}" } },
        resultMessage: Message.Tool({ id: "1", function: { name: "hangFn" } }),
        signal: controller.signal,
      });

      // 并发执行 exec，中途 abort
      const execPromise = tool.exec(ctx);
      await new Promise((r) => setTimeout(r, 30));
      controller.abort();

      // 不应挂起：abort 后子 Agent 被联动中止，exec 能正常 resolve 返回
      await execPromise;
    });
  });

  describe("子 Agent 委派边界钩子", () => {
    function buildTool(client: any) {
      return new AgentTool({
        function: {
          name: "testFn",
          description: "测试",
          parameters: { type: "object", properties: {}, required: [] },
        },
        client,
        model: "gpt-4",
        messages: [Message.User("你好")],
      });
    }

    function buildHost(tool: AgentTool) {
      return new Agent({
        client: createMockClient(),
        model: "gpt-4",
        messages: [Message.System("主助手")],
        tools: [tool],
      });
    }

    function buildCtx(host: Agent) {
      return new ToolCallContext({
        agent: host,
        tool_call: { function: { name: "testFn", arguments: "{}" } },
        resultMessage: Message.Tool({ id: "1", function: { name: "testFn" } }),
      });
    }

    it("onSubAgentStart 放行后正常执行，载荷区分主/子 Agent", async () => {
      const tool = buildTool(createMockClient("子Agent回复"));
      const host = buildHost(tool);

      const seen: any[] = [];
      host.use({ onSubAgentStart: (c) => { seen.push(c); } });

      const ctx = buildCtx(host);
      const result = await tool.exec(ctx);

      expect(seen).toHaveLength(1);
      expect(seen[0].agent).toBe(host);
      expect(seen[0].subAgent).toBeInstanceOf(Agent);
      expect(seen[0].subAgent).not.toBe(host);
      expect(seen[0].toolCallContext).toBe(ctx);
      expect(result).toBe("子Agent回复");
    });

    it("onSubAgentStart 返回字符串时拒绝委派：子 Agent 不运行、原因作为工具结果", async () => {
      const subClient = createMockClient("子Agent回复");
      const tool = buildTool(subClient);
      const host = buildHost(tool);

      const endHook = vi.fn();
      host.use({ onSubAgentStart: () => "额度已用尽", onSubAgentEnd: endHook });
      const eventHandler = vi.fn();
      host.events.on("sub-agent-start", eventHandler);

      const result = await tool.exec(buildCtx(host));

      expect(result).toBe("额度已用尽");
      expect(subClient.chat.completions.create).not.toHaveBeenCalled();
      expect(endHook).not.toHaveBeenCalled();
      // 即使被拒绝，非阻塞事件依然广播
      expect(eventHandler).toHaveBeenCalledTimes(1);
    });

    it("多个插件按注册顺序分发，任一返回字符串即短路", async () => {
      const tool = buildTool(createMockClient());
      const host = buildHost(tool);

      const second = vi.fn();
      host.use({ onSubAgentStart: () => "拒绝A" });
      host.use({ onSubAgentStart: second });

      const result = await tool.exec(buildCtx(host));

      expect(result).toBe("拒绝A");
      expect(second).not.toHaveBeenCalled();
    });

    it("onSubAgentEnd 在子 Agent 完成后触发，返回字符串仅短路后续插件", async () => {
      const tool = buildTool(createMockClient("子Agent回复"));
      const host = buildHost(tool);

      const order: string[] = [];
      const second = vi.fn();
      // dispatchHook 先广播事件、再按序阻塞调用插件
      host.events.on("sub-agent-end", () => order.push("event"));
      host.use({ onSubAgentEnd: () => { order.push("first"); return "结束提示"; } });
      host.use({ onSubAgentEnd: second });

      const result = await tool.exec(buildCtx(host));

      expect(order).toEqual(["event", "first"]);
      expect(second).not.toHaveBeenCalled();
      // 子 Agent 已运行完成，返回字符串不影响工具结果
      expect(result).toBe("子Agent回复");
    });
  });
});
