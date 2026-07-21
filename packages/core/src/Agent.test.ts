import { describe, it, expect, vi, beforeEach } from "vitest";
import { AsyncQueue } from "@ai-zen/async-queue";
import { Agent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";
import { CallbackTool } from "./Tools/CallbackTool.js";
import { Tool } from "./Tool.js";
import { FunctionCallContext } from "./FunctionCallContext.js";

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

/**
 * 创建一个支持多轮调用的 mock 模型
 * @param rounds 每一轮返回的数据数组，每轮是一个 StreamResponseData[] 数组
 */
function createMultiRoundMockModel(
  rounds: AgentNS.StreamResponseData[][],
) {
  let callCount = 0;
  const createStream = vi.fn(() => {
    const data = rounds[callCount];
    callCount++;
    if (!data) {
      const q = new AsyncQueue<AgentNS.StreamResponseData>();
      q.done();
      return q;
    }
    const queue = new AsyncQueue<AgentNS.StreamResponseData>();
    for (const chunk of data) {
      queue.push(chunk);
    }
    queue.done();
    return queue;
  });

  return {
    createStream,
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

    it("没有消息时运行应抛出错误", async () => {
      const agent = new Agent({ model: {} as any });
      await expect(agent.run()).rejects.toThrow(
        "You need to send at least one message as a receive message",
      );
    });

    it("finish_reason 为 Length 时应正常结束", async () => {
      const mockModel = createMockModel([
        {
          choices: [{
            index: 0,
            delta: { content: "内容被截断" },
            finish_reason: null,
          }],
        },
        {
          choices: [{
            index: 0,
            delta: {},
            finish_reason: AgentNS.FinishReason.Length,
          }],
        },
      ]);

      const agent = new Agent({
        model: mockModel,
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());

      const result = await agent.run();
      const lastMsg = result.at(-1)!;
      expect(lastMsg.status).toBe(AgentNS.MessageStatus.Completed);
      expect(lastMsg.content).toBe("内容被截断");
      expect(lastMsg.finish_reason).toBe(AgentNS.FinishReason.Length);
    });

    it("流式返回 error 时应抛出异常并标记 Error", async () => {
      const queue = new AsyncQueue<AgentNS.StreamResponseData>();
      queue.push({ error: { code: "rate_limit", message: "请求频率超限" } });
      queue.done();

      const model = {
        createStream: vi.fn(() => queue),
        createCompletion: vi.fn(),
        code: "mock",
        title: "Mock",
        type: ModelType.ChatCompletion,
        name: "Mock",
        model_config: {},
        request_config: { url: "https://test.com", headers: {}, body: {} },
      } as any;

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());

      const result = await agent.run();
      const lastMsg = agent.messages.at(-1)!;
      expect(lastMsg.status).toBe(AgentNS.MessageStatus.Error);
      expect(lastMsg.content).toBe("请求频率超限");
    });

    it("没有工具调用时不再继续对话", async () => {
      const mockModel = createMockModel([
        {
          choices: [{
            index: 0,
            delta: { content: "最终回复" },
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
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());
      await agent.run();

      // 只有一轮对话，createStream 只调用一次
      expect(mockModel.createStream).toHaveBeenCalledTimes(1);
      expect(agent.messages).toHaveLength(2); // system + assistant
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
                    id: "1",
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

    it("应支持多轮工具调用（3轮以上）", async () => {
      // 模拟3轮工具调用：
      // 第1轮：调用 toolA
      // 第2轮：调用 toolB
      // 第3轮：返回最终结果
      const toolA = new CallbackTool({
        function: {
          name: "toolA",
          description: "工具A",
          parameters: { type: "object", properties: {} },
        },
        callback: () => "A的结果",
      });

      const toolB = new CallbackTool({
        function: {
          name: "toolB",
          description: "工具B",
          parameters: { type: "object", properties: {} },
        },
        callback: () => "B的结果",
      });

      const model = createMultiRoundMockModel([
        // 第1轮：调用 toolA
        [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "toolA", arguments: "{}" } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
        ],
        // 第2轮：调用 toolB
        [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "2", type: "function", function: { name: "toolB", arguments: "{}" } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
        ],
        // 第3轮：最终回复
        [
          { choices: [{ index: 0, delta: { content: "最终结果" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
        ],
      ]);

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
        tools: [toolA, toolB],
      });

      agent.append(Message.Assistant());
      await agent.run();

      // createStream 应被调用3次（3轮对话）
      expect(model.createStream).toHaveBeenCalledTimes(3);
      // 最终消息应为 "最终结果"
      const lastMsg = agent.messages.at(-1)!;
      expect(lastMsg.content).toBe("最终结果");
      // 应有2条 tool 结果消息
      const toolResults = agent.messages.filter((m) => m.role === AgentNS.Role.Tool);
      expect(toolResults).toHaveLength(2);
      expect(toolResults[0].content).toBe("A的结果");
      expect(toolResults[1].content).toBe("B的结果");
    });

    it("调用 preventDefault 时应阻止继续对话", async () => {
      const tool = new CallbackTool({
        function: {
          name: "stopTool",
          description: "阻止继续",
          parameters: { type: "object", properties: {} },
        },
        callback(this: FunctionCallContext) {
          this.preventDefault();
          return "已停止";
        },
      });

      const model = createMultiRoundMockModel([
        // 第1轮：调用 stopTool
        [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "stopTool", arguments: "{}" } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
        ],
      ]);

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
        tools: [tool],
      });

      agent.append(Message.Assistant());
      await agent.run();

      // 虽然只有一轮但应该不再继续（preventDefault 阻止了）
      expect(model.createStream).toHaveBeenCalledTimes(1);
      const toolResults = agent.messages.filter((m) => m.role === AgentNS.Role.Tool);
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].content).toBe("已停止");
    });

    it("allowJsonParseError=true 时参数解析错误应返回给 AI 并继续对话", async () => {
      const tool = new CallbackTool({
        function: {
          name: "parseTest",
          description: "解析测试",
          parameters: {
            type: "object",
            properties: { x: { type: "number" } },
            required: ["x"],
          },
        },
        callback: (args: any) => `值: ${args.x}`,
      });

      const model = createMultiRoundMockModel([
        // 第1轮：返回非法 JSON 参数的 tool_calls
        [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "parseTest", arguments: "{invalid}" } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
        ],
        // 第2轮：AI 修正后返回文本
        [
          { choices: [{ index: 0, delta: { content: "已修正参数" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
        ],
      ]);

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
        tools: [tool],
        allowJsonParseError: true,
      });

      agent.append(Message.Assistant());
      await agent.run();

      // 应继续对话（第2轮）
      expect(model.createStream).toHaveBeenCalledTimes(2);
      const lastMsg = agent.messages.at(-1)!;
      expect(lastMsg.content).toBe("已修正参数");
      // 工具结果消息应包含解析错误信息
      const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
      expect(toolResult.content).toContain("参数解析错误");
    });

    it("allowJsonParseError=false 时参数解析错误应抛出异常", async () => {
      const tool = new CallbackTool({
        function: {
          name: "parseTest",
          description: "解析测试",
          parameters: {
            type: "object",
            properties: { x: { type: "number" } },
            required: ["x"],
          },
        },
        callback: (args: any) => `值: ${args.x}`,
      });

      const queue = new AsyncQueue<AgentNS.StreamResponseData>();
      queue.push({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "parseTest", arguments: "{invalid}" } }],
          },
          finish_reason: null,
        }],
      });
      queue.push({
        choices: [{
          index: 0,
          delta: {},
          finish_reason: AgentNS.FinishReason.ToolCalls,
        }],
      });
      queue.done();

      const model = {
        createStream: vi.fn(() => queue),
        createCompletion: vi.fn(),
        code: "mock",
        title: "Mock",
        type: ModelType.ChatCompletion,
        name: "Mock",
        model_config: {},
        request_config: { url: "https://test.com", headers: {}, body: {} },
      } as any;

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
        tools: [tool],
        allowJsonParseError: false,
      });

      agent.append(Message.Assistant());

      // 不会抛出异常到外部，因为 handleToolCall 内部 catch 了，但会标记为 Error
      await agent.run();
      const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool);
      expect(toolResult).toBeDefined();
      expect(toolResult!.status).toBe(AgentNS.MessageStatus.Error);
    });

    it("工具执行中抛出异常且 allowJsonParseError=true 时应返回错误描述并继续", async () => {
      const tool = new CallbackTool({
        function: {
          name: "errorTool",
          description: "会出错的工具",
          parameters: { type: "object", properties: {} },
        },
        callback: () => {
          throw new Error("执行出错啦");
        },
      });

      const model = createMultiRoundMockModel([
        // 第1轮：调用 errorTool
        [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "errorTool", arguments: "{}" } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
        ],
        // 第2轮：AI 返回修正后的结果
        [
          { choices: [{ index: 0, delta: { content: "错误已处理" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
        ],
      ]);

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
        tools: [tool],
        allowJsonParseError: true,
      });

      agent.append(Message.Assistant());
      await agent.run();

      expect(model.createStream).toHaveBeenCalledTimes(2);
      const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
      expect(toolResult.content).toContain("执行工具 errorTool 时出错");
      expect(toolResult.content).toContain("执行出错啦");
      const lastMsg = agent.messages.at(-1)!;
      expect(lastMsg.content).toBe("错误已处理");
    });

    it("工具执行中抛出异常且 allowJsonParseError=false 时应标记为 Error 且不继续", async () => {
      const tool = new CallbackTool({
        function: {
          name: "errorTool",
          description: "会出错的工具",
          parameters: { type: "object", properties: {} },
        },
        callback: () => {
          throw new Error("严重错误");
        },
      });

      const queue = new AsyncQueue<AgentNS.StreamResponseData>();
      queue.push({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "errorTool", arguments: "{}" } }],
          },
          finish_reason: null,
        }],
      });
      queue.push({
        choices: [{
          index: 0,
          delta: {},
          finish_reason: AgentNS.FinishReason.ToolCalls,
        }],
      });
      queue.done();

      const model = {
        createStream: vi.fn(() => queue),
        createCompletion: vi.fn(),
        code: "mock",
        title: "Mock",
        type: ModelType.ChatCompletion,
        name: "Mock",
        model_config: {},
        request_config: { url: "https://test.com", headers: {}, body: {} },
      } as any;

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
        tools: [tool],
        allowJsonParseError: false,
      });

      agent.append(Message.Assistant());
      await agent.run();

      // 不会继续对话（prevent_default 为 true）
      expect(model.createStream).toHaveBeenCalledTimes(1);
      const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
      expect(toolResult.status).toBe(AgentNS.MessageStatus.Error);
    });

    it("没有匹配到工具时应返回未知工具提示并继续", async () => {
      const model = createMultiRoundMockModel([
        // 第1轮：调用一个未注册的工具
        [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "unknownTool", arguments: "{}" } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
        ],
        // 第2轮：AI 确认
        [
          { choices: [{ index: 0, delta: { content: "好的，我知道这个工具不可用" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
        ],
      ]);

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
        tools: [], // 没有注册任何工具
      });

      agent.append(Message.Assistant());
      await agent.run();

      expect(model.createStream).toHaveBeenCalledTimes(2);
      const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
      expect(toolResult.content).toContain("未知工具");
      expect(toolResult.content).toContain("unknownTool");
    });

    describe("onUnknownTool 钩子", () => {
      it("设置同步 onUnknownTool 时，未知工具调用应返回自定义内容并继续对话", async () => {
        const model = createMultiRoundMockModel([
          // 第1轮：调用未注册的工具
          [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "noSuchTool", arguments: "{}" } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
          ],
          // 第2轮：AI 回复
          [
            { choices: [{ index: 0, delta: { content: "我知道了" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
          ],
        ]);

        const agent = new Agent({
          model,
          messages: [Message.System("助手")],
          tools: [],
          onUnknownTool: (ctx) => {
            const names = ctx.availableTools.map((t) => t.function.name).join(", ");
            return `工具 "${ctx.toolCall.function?.name}" 不可用。可用工具: [${names}]。`;
          },
        });

        agent.append(Message.Assistant());
        await agent.run();

        expect(model.createStream).toHaveBeenCalledTimes(2);
        const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
        expect(toolResult.content).toContain('工具 "noSuchTool" 不可用');
        expect(toolResult.content).toContain("可用工具");
      });

      it("设置异步 onUnknownTool 时，未知工具调用应返回自定义内容并继续对话", async () => {
        const model = createMultiRoundMockModel([
          // 第1轮：调用未注册的工具
          [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "asyncUnknown", arguments: "{}" } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
          ],
          // 第2轮：AI 回复
          [
            { choices: [{ index: 0, delta: { content: "收到" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
          ],
        ]);

        const agent = new Agent({
          model,
          messages: [Message.System("助手")],
          tools: [],
          onUnknownTool: async (ctx) => {
            // 模拟异步操作，如查询日志或调用外部服务
            await new Promise((r) => setTimeout(r, 10));
            return `异步检查：工具 "${ctx.toolCall.function?.name}" 不存在。已记录到审计日志。`;
          },
        });

        agent.append(Message.Assistant());
        await agent.run();

        expect(model.createStream).toHaveBeenCalledTimes(2);
        const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
        expect(toolResult.content).toContain("异步检查");
        expect(toolResult.content).toContain("asyncUnknown");
        expect(toolResult.content).toContain("审计日志");
      });

      it("onUnknownTool 中 availableTools 应包含当前注册的工具列表", async () => {
        const readTool = new CallbackTool({
          function: { name: "readFile", description: "读文件", parameters: { type: "object", properties: {} } },
          callback: () => "文件内容",
        });
        const writeTool = new CallbackTool({
          function: { name: "writeFile", description: "写文件", parameters: { type: "object", properties: {} } },
          callback: () => "写入成功",
        });

        const capturedNames: string[] = [];
        const model = createMultiRoundMockModel([
          // 第1轮：调用未注册的工具
          [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "deleteFile", arguments: "{}" } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
          ],
          // 第2轮：AI 回复
          [
            { choices: [{ index: 0, delta: { content: "抱歉，我没有删除工具" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
          ],
        ]);

        const agent = new Agent({
          model,
          messages: [Message.System("助手")],
          tools: [readTool, writeTool],
          onUnknownTool: (ctx) => {
            capturedNames.push(...ctx.availableTools.map((t) => t.function.name));
            return `不可用，可用工具: ${ctx.availableTools.map((t) => t.function.name).join(", ")}`;
          },
        });

        agent.append(Message.Assistant());
        await agent.run();

        expect(capturedNames).toContain("readFile");
        expect(capturedNames).toContain("writeFile");
        expect(capturedNames).not.toContain("deleteFile");
        expect(model.createStream).toHaveBeenCalledTimes(2);
      });

      it("onUnknownTool 返回的内容不应影响后续正常工具调用", async () => {
        const readTool = new CallbackTool({
          function: { name: "readFile", description: "读文件", parameters: { type: "object", properties: {} } },
          callback: () => "文件内容",
        });

        // 注意：parseStreamData 每个 chunk 只处理 delta.tool_calls[0]，
        // 因此多个 tool_calls 需要分布在多个独立的 chunk 中
        const model = createMultiRoundMockModel([
          // 第1轮：依次返回两个 tool_calls（分两个 chunk）
          [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "unknownX", arguments: "{}" } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "2", type: "function", function: { name: "readFile", arguments: "{}" } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
          ],
          // 第2轮：AI 整合结果后回复
          [
            { choices: [{ index: 0, delta: { content: "已处理" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
          ],
        ]);

        const agent = new Agent({
          model,
          messages: [Message.System("助手")],
          tools: [readTool],
          onUnknownTool: (ctx) => `工具 "${ctx.toolCall.function?.name}" 不存在`,
        });

        agent.append(Message.Assistant());
        await agent.run();

        expect(model.createStream).toHaveBeenCalledTimes(2);
        const toolResults = agent.messages.filter((m) => m.role === AgentNS.Role.Tool);
        // 并行调用，应有 2 条工具结果
        expect(toolResults).toHaveLength(2);
        const unknownResult = toolResults.find((m) => m.content!.toString().includes("unknownX"));
        const knownResult = toolResults.find((m) => m.content === "文件内容");
        expect(unknownResult).toBeDefined();
        expect(knownResult).toBeDefined();
      });

      it("未设置 onUnknownTool 时使用默认提示（向后兼容）", async () => {
        const model = createMultiRoundMockModel([
          [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "unknownTool", arguments: "{}" } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
          ],
          [
            { choices: [{ index: 0, delta: { content: "好的" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
          ],
        ]);

        // 不设置 onUnknownTool，使用默认行为
        const agent = new Agent({
          model,
          messages: [Message.System("助手")],
          tools: [],
        });

        agent.append(Message.Assistant());
        await agent.run();

        const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
        expect(toolResult.content).toBe("未知工具: unknownTool，没有找到对应的工具实现。");
      });
    });

    it("function_call（旧版）格式也应正常处理", async () => {
      const tool = new CallbackTool({
        function: {
          name: "oldFn",
          description: "旧版函数调用",
          parameters: { type: "object", properties: {} },
        },
        callback: () => "旧版函数执行成功",
      });

      const model = createMultiRoundMockModel([
        // 第1轮：返回 function_call（旧版格式）
        // 注意：parseStreamData 中 function_call.arguments 会拼接，
        // 所以 arguments 必须在单独一个 chunk 中完整传入，不能分多个 chunk
        [
          { choices: [{ index: 0, delta: { function_call: { name: "oldFn" } }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { function_call: { arguments: "{}" } }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.FunctionCall }] },
        ],
        // 第2轮：返回最终结果
        [
          { choices: [{ index: 0, delta: { content: "旧版函数已处理" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
        ],
      ]);

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
        tools: [tool],
      });

      agent.append(Message.Assistant());
      await agent.run();

      expect(model.createStream).toHaveBeenCalledTimes(2);
      const funcResult = agent.messages.find((m) => m.role === AgentNS.Role.Function)!;
      expect(funcResult).toBeDefined();
      expect(funcResult.content).toBe("旧版函数执行成功");
    });
  });

  describe("run - 中止流程", () => {
    it("运行中调用 abort 应中止并标记 Aborted", async () => {
      // 创建一个永远不会完成的流（不调用 done()）
      const queue = new AsyncQueue<AgentNS.StreamResponseData>();

      let capturedSignal: AbortSignal | undefined;
      const model = {
        createStream: vi.fn((opts: any) => {
          capturedSignal = opts.signal;
          opts.onOpen?.();
          // 注册 abort 事件监听，当 abort 时让队列结束
          opts.signal.addEventListener("abort", () => {
            queue.done();
          });
          return queue;
        }),
        createCompletion: vi.fn(),
        code: "mock",
        title: "Mock",
        type: ModelType.ChatCompletion,
        name: "Mock",
        model_config: {},
        request_config: { url: "https://test.com", headers: {}, body: {} },
      } as any;

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());

      // 并发执行 run 和 abort
      const runPromise = agent.run();

      // 等待一下确保 run 已经开始
      await new Promise((r) => setTimeout(r, 50));
      agent.abort();

      await runPromise;
      const lastMsg = agent.messages.at(-1)!;
      expect(lastMsg.status).toBe(AgentNS.MessageStatus.Aborted);
    });

    it("abort 应清空 pendingTasks", () => {
      const agent = new Agent({
        model: {} as any,
        messages: [Message.System("你好")],
      });

      agent.abort();
      // 不抛异常即可
      expect(true).toBe(true);
    });
  });

  describe("run - 事件系统", () => {
    it("应触发 inner-loop-start、open、parsed、finally 事件", async () => {
      // 使用一个会调用 onOpen 回调的 mock 模型
      const queue = new AsyncQueue<AgentNS.StreamResponseData>();
      queue.push({ choices: [{ index: 0, delta: { content: "回复" }, finish_reason: null }] });
      queue.push({ choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] });
      queue.done();

      const model = {
        createStream: vi.fn((opts: any) => {
          opts.onOpen?.();
          opts.onFinally?.();
          return queue;
        }),
        createCompletion: vi.fn(),
        code: "mock",
        title: "Mock",
        type: ModelType.ChatCompletion,
        name: "Mock",
        model_config: {},
        request_config: { url: "https://test.com", headers: {}, body: {} },
      } as any;

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());

      const runHandler = vi.fn();
      const openHandler = vi.fn();
      const parsedHandler = vi.fn();
      const loopEndHandler = vi.fn();
      const chunkHandler = vi.fn();

      agent.events.on("inner-loop-start", runHandler);
      agent.events.on("open", openHandler);
      agent.events.on("parsed", parsedHandler);
      agent.events.on("inner-loop-end", loopEndHandler);
      agent.events.on("chunk", chunkHandler);

      await agent.run();

      expect(runHandler).toHaveBeenCalledTimes(1);
      expect(openHandler).toHaveBeenCalledTimes(1);
      expect(parsedHandler).toHaveBeenCalledTimes(1);
      expect(loopEndHandler).toHaveBeenCalledTimes(1);
      expect(chunkHandler).toHaveBeenCalledTimes(2);
    });

    it("工具调用多轮时应每轮都触发事件", async () => {
      const tool = new CallbackTool({
        function: {
          name: "testTool",
          description: "测试",
          parameters: { type: "object", properties: {} },
        },
        callback: () => "结果",
      });

      let callCount = 0;
      const rounds = [
        [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "testTool", arguments: "{}" } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
        ],
        [
          { choices: [{ index: 0, delta: { content: "最终回复" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
        ],
      ];

      const model = {
        createStream: vi.fn((opts: any) => {
          opts.onOpen?.();
          opts.onFinally?.();
          const data = rounds[callCount];
          callCount++;
          const q = new AsyncQueue<AgentNS.StreamResponseData>();
          for (const chunk of data) {
            q.push(chunk);
          }
          q.done();
          return q;
        }),
        createCompletion: vi.fn(),
        code: "mock",
        title: "Mock",
        type: ModelType.ChatCompletion,
        name: "Mock",
        model_config: {},
        request_config: { url: "https://test.com", headers: {}, body: {} },
      } as any;

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
        tools: [tool],
      });
      agent.append(Message.Assistant());

      const runHandler = vi.fn();
      const finallyHandler = vi.fn();

      agent.events.on("inner-loop-start", runHandler);
      agent.events.on("inner-loop-end", finallyHandler);

      await agent.run();

      // 2轮对话应各触发一次
      expect(runHandler).toHaveBeenCalledTimes(2);
      expect(finallyHandler).toHaveBeenCalledTimes(2);
    });

    it("触发 error 事件时应携带错误信息", async () => {
      const queue = new AsyncQueue<AgentNS.StreamResponseData>();
      queue.push({ error: { code: "error", message: "测试错误" } });
      queue.done();

      const model = {
        createStream: vi.fn(() => queue),
        createCompletion: vi.fn(),
        code: "mock",
        title: "Mock",
        type: ModelType.ChatCompletion,
        name: "Mock",
        model_config: {},
        request_config: { url: "https://test.com", headers: {}, body: {} },
      } as any;

      const agent = new Agent({
        model,
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());

      const errorHandler = vi.fn();
      agent.events.on("error", errorHandler);

      await agent.run();

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler.mock.calls[0][0].message).toBe("测试错误");
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

    it("send 后 isHasPendingMessage 应为 false", async () => {
      const mockModel = createMockModel([
        { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
      ]);

      const agent = new Agent({
        model: mockModel,
        messages: [Message.System("助手")],
      });

      await agent.send("hi");
      expect(agent.isHasPendingMessage).toBe(false);
    });
  });

  describe("isHasPendingMessage", () => {
    it("有 Pending 消息时应返回 true", () => {
      const agent = new Agent({ model: {} as any });
      agent.append(Message.Assistant());
      expect(agent.isHasPendingMessage).toBe(true);
    });

    it("无 Pending 消息时应返回 false", () => {
      const agent = new Agent({ model: {} as any });
      agent.append(Message.System("你好"));
      expect(agent.isHasPendingMessage).toBe(false);
    });
  });
});
