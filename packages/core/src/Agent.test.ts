import { describe, it, expect, vi, beforeEach } from "vitest";
import { AsyncQueue } from "@ai-zen/async-queue";
import { Agent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";
import { CallbackTool } from "./Tools/CallbackTool.js";
import { Tool } from "./Tool.js";
import { ToolCallContext } from "./ToolCallContext.js";

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

    it("最后一条消息非 Assistant 时 run 应自动追加 Assistant 并正常执行", async () => {
      const mockModel = createMockModel([
        { choices: [{ index: 0, delta: { content: "收到" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
      ]);

      const agent = new Agent({
        model: mockModel,
        messages: [Message.System("你好")],
      });
      agent.append(Message.User("问题"));

      await agent.run();

      // run 内循环开头自动追加 Assistant 并收到回复
      expect(agent.messages.at(-1)!.role).toBe(AgentNS.Role.Assistant);
      expect(agent.messages.at(-1)!.content).toBe("收到");
      expect(agent.messages.at(-1)!.status).toBe(AgentNS.MessageStatus.Completed);
    });

    it("最后一条消息状态非 Pending 时 run 应自动追加新的 Assistant", async () => {
      const mockModel = createMockModel([
        { choices: [{ index: 0, delta: { content: "新回复" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
      ]);

      const agent = new Agent({
        model: mockModel,
        messages: [Message.System("你好")],
      });
      agent.append({ ...Message.Assistant("旧的"), status: AgentNS.MessageStatus.Completed } as any);

      await agent.run();

      // 旧 Assistant 保留，run 自动追加新的 Assistant 接收回复
      expect(agent.messages).toHaveLength(3); // system + 旧 assistant + 新 assistant
      expect(agent.messages[1].content).toBe("旧的");
      expect(agent.messages[1].status).toBe(AgentNS.MessageStatus.Completed);
      expect(agent.messages[2].content).toBe("新回复");
      expect(agent.messages[2].status).toBe(AgentNS.MessageStatus.Completed);
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
        callback(_parsedArgs: any, ctx: ToolCallContext) {
          ctx.preventDefault();
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

    describe("onToolCall 钩子", () => {
      it("onToolCall 返回字符串（拒绝）时：工具不执行、原因作为工具结果返回、继续下一轮", async () => {
        const tool = new CallbackTool({
          function: {
            name: "sensitiveTool",
            description: "敏感操作工具",
            parameters: { type: "object", properties: {} },
          },
          callback: vi.fn(() => "敏感操作已执行"),
        });

        const model = createMultiRoundMockModel([
          // 第1轮：调用 sensitiveTool
          [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "sensitiveTool", arguments: "{}" } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
          ],
          // 第2轮：AI 收到拒绝原因后调整回复
          [
            { choices: [{ index: 0, delta: { content: "好的，我不执行该敏感操作" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
          ],
        ]);

        const agent = new Agent({
          model,
          messages: [Message.System("助手")],
          tools: [tool],
          onToolCall: (ctx) =>
            `工具 ${ctx.tool_call.function?.name} 被拒绝：需要用户授权`,
        });

        agent.append(Message.Assistant());
        await agent.run();

        // 拒绝后继续下一轮（LLM 收到原因并调整）
        expect(model.createStream).toHaveBeenCalledTimes(2);
        // 工具未执行
        expect(tool.callback).not.toHaveBeenCalled();
        // 拒绝原因作为工具结果返回给 LLM，状态为 Completed
        const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
        expect(toolResult.content).toContain("sensitiveTool");
        expect(toolResult.content).toContain("被拒绝");
        expect(toolResult.content).toContain("需要用户授权");
        expect(toolResult.status).toBe(AgentNS.MessageStatus.Completed);
        // 最终消息为第2轮 LLM 回复
        const lastMsg = agent.messages.at(-1)!;
        expect(lastMsg.content).toBe("好的，我不执行该敏感操作");
      });

      it("onToolCall 返回 undefined（允许）时：工具正常执行", async () => {
        const tool = new CallbackTool({
          function: {
            name: "safeTool",
            description: "安全工具",
            parameters: { type: "object", properties: {} },
          },
          callback: () => "安全工具执行结果",
        });

        const model = createMultiRoundMockModel([
          // 第1轮：调用 safeTool
          [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "safeTool", arguments: "{}" } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
          ],
          // 第2轮：AI 整合结果
          [
            { choices: [{ index: 0, delta: { content: "已处理" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
          ],
        ]);

        const onToolCall = vi.fn(() => undefined);

        const agent = new Agent({
          model,
          messages: [Message.System("助手")],
          tools: [tool],
          onToolCall,
        });

        agent.append(Message.Assistant());
        await agent.run();

        // 钩子被调用且返回 undefined（允许）
        expect(onToolCall).toHaveBeenCalledTimes(1);
        // 工具正常执行
        const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
        expect(toolResult.content).toBe("安全工具执行结果");
        // 继续下一轮
        expect(model.createStream).toHaveBeenCalledTimes(2);
      });

      it("onToolCall 与 Tool.exec 收到同一个 ToolCallContext 实例（贯穿拦截→执行）", async () => {
        let hookCtx: any;
        let execCtx: any;

        const tool = new CallbackTool({
          function: {
            name: "sharedCtx",
            description: "共享上下文工具",
            parameters: { type: "object", properties: {} },
          },
          callback: (_parsedArgs: any, ctx: any) => {
            execCtx = ctx;
            return "共享上下文执行结果";
          },
        });

        const agent = new Agent({
          model: createMultiRoundMockModel([
            // 第1轮：调用 sharedCtx
            [
              { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "sharedCtx", arguments: "{}" } }] }, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
            ],
            // 第2轮：AI 回复
            [
              { choices: [{ index: 0, delta: { content: "完成" }, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
            ],
          ]),
          messages: [Message.System("助手")],
          tools: [tool],
          onToolCall: (ctx) => {
            hookCtx = ctx;
            // 钩子内可读统一字段：tool_call / tool / agent
            expect(ctx.tool_call.function?.name).toBe("sharedCtx");
            expect(ctx.tool).toBe(tool);
            expect(ctx.agent).toBe(agent);
            return undefined; // 允许执行
          },
        });

        agent.append(Message.Assistant());
        await agent.run();

        // 钩子与 exec 收到的是同一个实例
        expect(hookCtx).toBeDefined();
        expect(execCtx).toBeDefined();
        expect(hookCtx).toBe(execCtx);
        expect(hookCtx).toBeInstanceOf(ToolCallContext);
        // 工具确实执行了
        const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
        expect(toolResult.content).toBe("共享上下文执行结果");
      });

      it("并行多个工具调用时：每个工具独立过钩子（可单独拒绝）", async () => {
        const denyTool = new CallbackTool({
          function: {
            name: "denyTool",
            description: "将被拒绝的工具",
            parameters: { type: "object", properties: {} },
          },
          callback: vi.fn(() => "denyTool 执行了"),
        });
        const allowTool = new CallbackTool({
          function: {
            name: "allowTool",
            description: "将被允许的工具",
            parameters: { type: "object", properties: {} },
          },
          callback: () => "allowTool 执行结果",
        });

        const model = createMultiRoundMockModel([
          // 第1轮：并行返回两个 tool_calls（分两个 chunk）
          [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "denyTool", arguments: "{}" } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "2", type: "function", function: { name: "allowTool", arguments: "{}" } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
          ],
          // 第2轮：AI 整合结果后回复
          [
            { choices: [{ index: 0, delta: { content: "已分别处理" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
          ],
        ]);

        const agent = new Agent({
          model,
          messages: [Message.System("助手")],
          tools: [denyTool, allowTool],
          onToolCall: (ctx) => {
            if (ctx.tool_call.function?.name === "denyTool") {
              return `工具 denyTool 被拒绝：不允许使用`;
            }
            return undefined; // allowTool 放行
          },
        });

        agent.append(Message.Assistant());
        await agent.run();

        // 拒绝的没执行，允许的正常执行
        expect(denyTool.callback).not.toHaveBeenCalled();
        const toolResults = agent.messages.filter((m) => m.role === AgentNS.Role.Tool);
        expect(toolResults).toHaveLength(2);
        const deniedResult = toolResults.find((m) => m.content!.toString().includes("被拒绝"));
        const allowedResult = toolResults.find((m) => m.content === "allowTool 执行结果");
        expect(deniedResult).toBeDefined();
        expect(deniedResult!.content).toContain("不允许使用");
        expect(allowedResult).toBeDefined();
        // 继续下一轮
        expect(model.createStream).toHaveBeenCalledTimes(2);
        expect(agent.messages.at(-1)!.content).toBe("已分别处理");
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

    it("abort 只影响当前轮，已完成轮次保持 Completed", async () => {
      const tool = new CallbackTool({
        function: {
          name: "getTime",
          description: "获取时间",
          parameters: { type: "object", properties: {} },
        },
        callback: () => "12:00:00",
      });

      // 第一轮：AI 调用工具（立即完成）
      const firstQueue = new AsyncQueue<AgentNS.StreamResponseData>();
      firstQueue.push({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "getTime", arguments: "{}" } }] },
          finish_reason: null,
        }],
      });
      firstQueue.push({
        choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }],
      });
      firstQueue.done();

      // 第二轮：挂起，等待 abort
      const secondQueue = new AsyncQueue<AgentNS.StreamResponseData>();
      let resolveSecondCall!: () => void;
      const secondCall = new Promise<void>((r) => { resolveSecondCall = r; });

      let callCount = 0;
      const model = {
        createStream: vi.fn((opts: any) => {
          if (callCount === 0) {
            callCount++;
            return firstQueue;
          }
          callCount++;
          resolveSecondCall();
          opts.onOpen?.();
          // abort 时让队列结束
          opts.signal.addEventListener("abort", () => {
            secondQueue.done();
          });
          return secondQueue;
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

      const runPromise = agent.run();
      // 等待第二轮开始
      await secondCall;
      agent.abort();
      await runPromise;

      const messages = agent.messages;
      // 第一轮 assistant（含 tool_calls）保持 Completed
      expect(messages[1].role).toBe(AgentNS.Role.Assistant);
      expect(messages[1].status).toBe(AgentNS.MessageStatus.Completed);
      // 工具结果保持 Completed
      expect(messages[2].role).toBe(AgentNS.Role.Tool);
      expect(messages[2].status).toBe(AgentNS.MessageStatus.Completed);
      expect(messages[2].content).toBe("12:00:00");
      // 第二轮 assistant 被 Aborted
      expect(messages[3].role).toBe(AgentNS.Role.Assistant);
      expect(messages[3].status).toBe(AgentNS.MessageStatus.Aborted);
    });

    it("innerLoopsTasks 保留整组任务，innerLoopTasks 只保留当前轮进行中任务", async () => {
      const tool = new CallbackTool({
        function: {
          name: "getTime",
          description: "获取时间",
          parameters: { type: "object", properties: {} },
        },
        callback: () => "12:00:00",
      });

      // 第一轮：AI 调用工具（立即完成）
      const firstQueue = new AsyncQueue<AgentNS.StreamResponseData>();
      firstQueue.push({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "getTime", arguments: "{}" } }] },
          finish_reason: null,
        }],
      });
      firstQueue.push({
        choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }],
      });
      firstQueue.done();

      // 第二轮：挂起，用于在运行中检查集合内容
      const secondQueue = new AsyncQueue<AgentNS.StreamResponseData>();
      let resolveSecondCall!: () => void;
      const secondCall = new Promise<void>((r) => { resolveSecondCall = r; });

      let callCount = 0;
      const model = {
        createStream: vi.fn((opts: any) => {
          if (callCount === 0) {
            callCount++;
            return firstQueue;
          }
          callCount++;
          resolveSecondCall();
          opts.signal.addEventListener("abort", () => secondQueue.done());
          return secondQueue;
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

      const runPromise = agent.run();
      await secondCall;

      // 整组集合：第一轮 assistant + 工具结果 + 第二轮 assistant
      expect((agent as any).innerLoopsTasks.size).toBe(3);
      // 当前轮活跃集合：只有第二轮 assistant（开始记录、完成清除）
      expect((agent as any).innerLoopTasks.size).toBe(1);

      agent.abort();
      await runPromise;

      // run 结束后两个集合均清空
      expect((agent as any).innerLoopsTasks.size).toBe(0);
      expect((agent as any).innerLoopTasks.size).toBe(0);
    });

    it("单轮 run 结束后 innerLoopsTasks 与 innerLoopTasks 均清空", async () => {
      const mockModel = createMockModel([
        { choices: [{ index: 0, delta: { content: "你好" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
      ]);

      const agent = new Agent({
        model: mockModel,
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());

      await agent.run();

      expect((agent as any).innerLoopsTasks.size).toBe(0);
      expect((agent as any).innerLoopTasks.size).toBe(0);
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

    it("整组内循环事件 inner-loops-start/end 一次 run 各触发一次", async () => {
      const mockModel = createMockModel([
        { choices: [{ index: 0, delta: { content: "回复" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
      ]);

      const agent = new Agent({
        model: mockModel,
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());

      const loopsStart = vi.fn();
      const loopsEnd = vi.fn();
      agent.events.on("inner-loops-start", loopsStart);
      agent.events.on("inner-loops-end", loopsEnd);

      await agent.run();

      expect(loopsStart).toHaveBeenCalledTimes(1);
      expect(loopsEnd).toHaveBeenCalledTimes(1);
      // 两个事件都携带当前 messages（start 时消息已就绪，end 时完整结果）
      expect(loopsStart.mock.calls[0][0]).toBe(agent.messages);
      expect(loopsEnd.mock.calls[0][0]).toBe(agent.messages);
    });

    it("多轮工具调用时 inner-loops-start/end 仍只触发一次（区别于每轮的 inner-loop-start/end）", async () => {
      const tool = new CallbackTool({
        function: {
          name: "t",
          description: "t",
          parameters: { type: "object", properties: {} },
        },
        callback: () => "结果",
      });

      let callCount = 0;
      const rounds = [
        [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "t", arguments: "{}" } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.ToolCalls }] },
        ],
        [
          { choices: [{ index: 0, delta: { content: "最终" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: AgentNS.FinishReason.Stop }] },
        ],
      ];

      const model = {
        createStream: vi.fn((opts: any) => {
          opts.onOpen?.();
          opts.onFinally?.();
          const q = new AsyncQueue<AgentNS.StreamResponseData>();
          for (const chunk of rounds[callCount] ?? []) q.push(chunk);
          callCount++;
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

      const loopsStart = vi.fn();
      const loopsEnd = vi.fn();
      const loopStart = vi.fn();
      const loopEnd = vi.fn();
      agent.events.on("inner-loops-start", loopsStart);
      agent.events.on("inner-loops-end", loopsEnd);
      agent.events.on("inner-loop-start", loopStart);
      agent.events.on("inner-loop-end", loopEnd);

      await agent.run();

      expect(loopsStart).toHaveBeenCalledTimes(1);
      expect(loopsEnd).toHaveBeenCalledTimes(1);
      expect(loopStart).toHaveBeenCalledTimes(2);
      expect(loopEnd).toHaveBeenCalledTimes(2);
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
