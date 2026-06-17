import { describe, it, expect, vi, beforeEach } from "vitest";
import { AsyncQueue } from "@ai-zen/async-queue";
import { Agent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";
import { CallbackTool } from "./Tools/CallbackTool.js";
import { Tool } from "./Tool.js";

// ---- Helper: 创建 Mock 模型 ----
function createMockModel(streamData: AgentNS.StreamResponseData[] = []) {
  const queue = new AsyncQueue<AgentNS.StreamResponseData>();
  // 将数据推入队列
  for (const data of streamData) {
    queue.push(data);
  }
  queue.done();

  return {
    createStream: vi.fn(() => queue),
    createCompletion: vi.fn(),
    code: "mock-model",
    title: "Mock Model",
    type: ModelType.ChatCompletion,
    name: "MockModel",
    model_config: {},
    request_config: { url: "https://test.com", headers: {}, body: {} },
  } as any;
}

// 避免导入 ModelType 枚举
enum ModelType {
  ChatCompletion = "chat_completion",
}

describe("Agent", () => {
  describe("构造函数", () => {
    it("应正确构建 Agent", () => {
      const agent = new Agent({
        model: {} as any,
        messages: [Message.System("你是一个助手")],
      });
      expect(agent.messages).toHaveLength(1);
      expect(agent.model).toBeDefined();
    });
  });

  describe("formatHistory", () => {
    it("应过滤掉 omit 消息", () => {
      const agent = new Agent({
        model: {} as any,
        messages: [
          Message.System("你好"),
          { ...Message.User("可见消息"), omit: false },
          { ...Message.User("隐藏消息"), omit: true },
        ] as any,
      });
      const history = agent.formatHistory();
      expect(history).toHaveLength(2);
      expect(history[0].role).toBe(AgentNS.Role.System);
    });

    it("应过滤掉非 completed 状态的消息", () => {
      const agent = new Agent({
        model: {} as any,
        messages: [
          Message.System("你好"),
          { ...Message.User("已完成"), status: AgentNS.MessageStatus.Completed },
          { ...Message.User("待处理"), status: AgentNS.MessageStatus.Pending },
        ] as any,
      });
      const history = agent.formatHistory();
      expect(history).toHaveLength(2);
    });
  });

  describe("formatTools", () => {
    it("应将工具格式化为 API 可接受的格式", () => {
      const tool = new CallbackTool({
        function: {
          name: "getTime",
          description: "获取时间",
          parameters: { type: "object", properties: {} },
        },
        callback: () => "12:00",
      });
      const agent = new Agent({ model: {} as any, tools: [tool] });
      const formatted = agent.formatTools();
      expect(formatted).toHaveLength(1);
      expect(formatted[0].type).toBe("function");
      expect(formatted[0].function.name).toBe("getTime");
    });
  });

  describe("run - 基本流", () => {
    it("应正常完成一次简单对话", async () => {
      const mockModel = createMockModel([
        {
          choices: [
            {
              index: 0,
              delta: { content: "你好！我是助手。" },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { content: "" },
              finish_reason: AgentNS.FinishReason.Stop,
            },
          ],
        },
      ]);

      const agent = new Agent({
        model: mockModel,
        messages: [Message.System("你是一个助手")],
      });
      agent.append(Message.Assistant());

      const result = await agent.run();

      expect(mockModel.createStream).toHaveBeenCalledTimes(1);
      expect(result).toBe(agent.messages);
      // 最后一条消息应标记为 Completed
      const lastMsg = result.at(-1)!;
      expect(lastMsg.status).toBe(AgentNS.MessageStatus.Completed);
      expect(lastMsg.content).toBe("你好！我是助手。");
    });

    it("最后一条消息非 Assistant 时应抛出错误", async () => {
      const agent = new Agent({
        model: {} as any,
        messages: [Message.System("你好")],
      });
      agent.append(Message.User("问题"));

      await expect(agent.run()).rejects.toThrow(
        "The last message will serve as the receiving message, and its role can only be assistant.",
      );
    });

    it("最后一条消息状态非 Pending 时应抛出错误", async () => {
      const agent = new Agent({
        model: {} as any,
        messages: [Message.System("你好")],
      });
      agent.append({ ...Message.Assistant(), status: AgentNS.MessageStatus.Completed } as any);

      await expect(agent.run()).rejects.toThrow(
        "The last message will serve as the receiving message, and its status can only be pending.",
      );
    });
  });

  describe("run - 工具调用流程", () => {
    it("当流返回 tool_calls 时应执行工具并继续对话", async () => {
      // 模拟两轮对话：
      // 第一轮：AI 调用工具 getTime
      // 第二轮：AI 返回最终结果
      const model = {
        createStream: vi.fn()
          .mockImplementationOnce(() => {
            // 第一轮：返回 tool_calls
            const q = new AsyncQueue<AgentNS.StreamResponseData>();
            q.push({
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 1,
                    type: "function",
                    function: { name: "getTime", arguments: "{}" },
                  }],
                },
                finish_reason: null,
              }],
            });
            q.push({
              choices: [{
                index: 0,
                delta: {},
                finish_reason: AgentNS.FinishReason.ToolCalls,
              }],
            });
            q.done();
            return q;
          })
          .mockImplementationOnce(() => {
            // 第二轮：返回文本
            const q = new AsyncQueue<AgentNS.StreamResponseData>();
            q.push({
              choices: [{
                index: 0,
                delta: { content: "当前时间已获取" },
                finish_reason: null,
              }],
            });
            q.push({
              choices: [{
                index: 0,
                delta: {},
                finish_reason: AgentNS.FinishReason.Stop,
              }],
            });
            q.done();
            return q;
          }),
        createCompletion: vi.fn(),
        code: "mock",
        title: "Mock",
        type: ModelType.ChatCompletion,
        name: "Mock",
      } as any;

      const tool = new CallbackTool({
        function: {
          name: "getTime",
          description: "获取当前时间",
          parameters: { type: "object", properties: {} },
        },
        callback: () => "12:00:00",
      });

      const agent = new Agent({
        model,
        messages: [Message.System("你是一个助手")],
        tools: [tool],
      });

      agent.append(Message.Assistant());
      await agent.run();

      // 最终消息应有结果文本
      const lastMsg = agent.messages.at(-1)!;
      expect(lastMsg.content).toBe("当前时间已获取");
      // 应有一条工具结果消息在中间
      const toolResults = agent.messages.filter((m) => m.role === AgentNS.Role.Tool);
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].content).toBe("12:00:00");
    });
  });

  describe("send", () => {
    it("应自动创建 User + Assistant 消息并运行", async () => {
      const mockModel = createMockModel([
        {
          choices: [{
            index: 0,
            delta: { content: "这是回复" },
            finish_reason: null,
          }],
        },
        {
          choices: [{
            index: 0,
            delta: {},
            finish_reason: AgentNS.FinishReason.Stop,
          }],
        },
      ]);

      const agent = new Agent({
        model: mockModel,
        messages: [Message.System("你是一个助手")],
      });

      const result = await agent.send("你好");

      expect(result).toBe(agent.messages);
      // 消息顺序: System → User → Assistant
      expect(agent.messages[0].role).toBe(AgentNS.Role.System);
      expect(agent.messages[1].role).toBe(AgentNS.Role.User);
      expect(agent.messages[1].content).toBe("你好");
      expect(agent.messages[2].role).toBe(AgentNS.Role.Assistant);
      expect(agent.messages[2].content).toBe("这是回复");
    });
  });

  describe("abort", () => {
    it("应中止所有待处理任务", () => {
      const agent = new Agent({
        model: {} as any,
        messages: [Message.System("你好")],
      });

      // 直接测试 abort 方法不报错即可
      expect(() => agent.abort()).not.toThrow();
    });
  });
});
