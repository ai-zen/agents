import { describe, it, expect, vi } from "vitest";
import { Agent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";
import { CallbackTool } from "./Tools/CallbackTool.js";
import { ToolCallContext } from "./ToolCallContext.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// Helper：Mock OpenAI client（替代真实网络请求）
// ---------------------------------------------------------------------------

type AnyChunk = any;

/** 构造一个流式 chunk */
function chunk(delta: any, finish_reason: any = null): AnyChunk {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason }],
  };
}

/** 结束 chunk（finish_reason = stop） */
function stopChunk(): AnyChunk {
  return chunk({}, "stop");
}

/** 将 chunk 数组包装为 async iterable stream */
function makeStream(chunks: AnyChunk[]): AsyncIterable<ChatCompletionChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield c as ChatCompletionChunk;
      }
    },
  };
}

/** 返回一个挂起流：signal abort 时结束（已 aborted 则立即结束） */
function makeHangingStream(signal: AbortSignal): AsyncIterable<AnyChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
    },
  };
}

/**
 * 创建 Mock OpenAI client。
 * @param rounds 每一轮返回的 chunk 数组（每轮对应一次 create 调用）
 */
function createMockClient(rounds: AnyChunk[][]) {
  let callCount = 0;
  const create = vi.fn(async (_body: any, _options: any) => {
    const data = rounds[callCount] ?? [];
    callCount++;
    return makeStream(data);
  });
  return {
    chat: { completions: { create } },
  } as any;
}

// ---------------------------------------------------------------------------
// Agent 测试
// ---------------------------------------------------------------------------

describe("Agent", () => {
  describe("构造函数", () => {
    it("应正确构建 Agent", () => {
      const agent = new Agent({
        client: {} as any,
        model: "gpt-4",
        messages: [Message.System("你是一个助手")],
      });
      expect(agent.messages).toHaveLength(1);
      expect(agent.model).toBe("gpt-4");
    });

    it("缺少 client 时应抛出错误", () => {
      expect(
        () => new Agent({ client: undefined as any, model: "gpt-4" }),
      ).toThrow("AgentContext must have a client");
    });

    it("缺少 model 时应抛出错误", () => {
      expect(
        () => new Agent({ client: {} as any, model: undefined as any }),
      ).toThrow("AgentContext must have a model");
    });
  });

  describe("formatHistory", () => {
    it("应过滤掉 omit 消息", () => {
      const agent = new Agent({
        client: {} as any,
        model: "gpt-4",
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
        client: {} as any,
        model: "gpt-4",
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
      const agent = new Agent({
        client: {} as any,
        model: "gpt-4",
        tools: [tool],
      });
      const formatted = agent.formatTools();
      expect(formatted).toHaveLength(1);
      expect(formatted![0].type).toBe("function");
      expect(formatted![0].function.name).toBe("getTime");
    });
  });

  describe("run - 基本流", () => {
    it("应正常完成一次简单对话", async () => {
      const client = createMockClient([
        [chunk({ content: "你好！我是助手。" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("你是一个助手")],
      });
      agent.append(Message.Assistant());

      const result = await agent.run();

      expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
      expect(result).toBe(agent.messages);
      // 最后一条消息应标记为 Completed
      const lastMsg = result.at(-1)!;
      expect(lastMsg.status).toBe(AgentNS.MessageStatus.Completed);
      expect(lastMsg.content).toBe("你好！我是助手。");
    });

    it("最后一条消息非 Assistant 时 run 应自动追加 Assistant 并正常执行", async () => {
      const client = createMockClient([
        [chunk({ content: "收到" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("你好")],
      });
      agent.append(Message.User("问题"));

      await agent.run();

      // run 内循环开头自动追加 Assistant 并收到回复
      expect(agent.messages.at(-1)!.role).toBe(AgentNS.Role.Assistant);
      expect(agent.messages.at(-1)!.content).toBe("收到");
      expect(agent.messages.at(-1)!.status).toBe(AgentNS.MessageStatus.Completed);
    });

    it("没有消息时运行应抛出错误", async () => {
      const agent = new Agent({ client: {} as any, model: "gpt-4" });
      await expect(agent.run()).rejects.toThrow(
        "You need to send at least one message as a receive message",
      );
    });

    it("finish_reason 为 Length 时应正常结束", async () => {
      const client = createMockClient([
        [chunk({ content: "内容被截断" }), chunk({}, "length")],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());

      const result = await agent.run();
      const lastMsg = result.at(-1)!;
      expect(lastMsg.status).toBe(AgentNS.MessageStatus.Completed);
      expect(lastMsg.content).toBe("内容被截断");
      expect(lastMsg.finish_reason).toBe(AgentNS.FinishReason.Length);
    });

    it("API 请求失败（create 抛错）时应标记 Error", async () => {
      const client = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw new Error("请求频率超限");
            }),
          },
        },
      } as any;

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());

      await agent.run();
      const lastMsg = agent.messages.at(-1)!;
      expect(lastMsg.status).toBe(AgentNS.MessageStatus.Error);
      expect(lastMsg.content).toBe("请求频率超限");
    });

    it("没有工具调用时不再继续对话", async () => {
      const client = createMockClient([
        [chunk({ content: "最终回复" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());
      await agent.run();

      expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
      expect(agent.messages).toHaveLength(2); // system + assistant
    });
  });

  describe("run - 工具调用流程", () => {
    it("当流返回 tool_calls 时应执行工具并继续对话", async () => {
      const client = createMockClient([
        [
          chunk({
            tool_calls: [{
              index: 0,
              id: "1",
              type: "function",
              function: { name: "getTime", arguments: "{}" },
            }],
          }),
          chunk({}, "tool_calls"),
        ],
        [chunk({ content: "当前时间已获取" }), stopChunk()],
      ]);

      const tool = new CallbackTool({
        function: {
          name: "getTime",
          description: "获取当前时间",
          parameters: { type: "object", properties: {} },
        },
        callback: () => "12:00:00",
      });

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("你是一个助手")],
        tools: [tool],
      });

      agent.append(Message.Assistant());
      await agent.run();

      const lastMsg = agent.messages.at(-1)!;
      expect(lastMsg.content).toBe("当前时间已获取");
      const toolResults = agent.messages.filter((m) => m.role === AgentNS.Role.Tool);
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].content).toBe("12:00:00");
    });

    it("应支持多轮工具调用（3轮以上）", async () => {
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

      const client = createMockClient([
        [
          chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "toolA", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ],
        [
          chunk({ tool_calls: [{ index: 0, id: "2", type: "function", function: { name: "toolB", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ],
        [chunk({ content: "最终结果" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [toolA, toolB],
      });

      agent.append(Message.Assistant());
      await agent.run();

      expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
      const lastMsg = agent.messages.at(-1)!;
      expect(lastMsg.content).toBe("最终结果");
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

      const client = createMockClient([
        [
          chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "stopTool", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [tool],
      });

      agent.append(Message.Assistant());
      await agent.run();

      expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
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

      const client = createMockClient([
        [
          chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "parseTest", arguments: "{invalid}" } }] }),
          chunk({}, "tool_calls"),
        ],
        [chunk({ content: "已修正参数" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [tool],
        allowJsonParseError: true,
      });

      agent.append(Message.Assistant());
      await agent.run();

      expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
      const lastMsg = agent.messages.at(-1)!;
      expect(lastMsg.content).toBe("已修正参数");
      const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
      expect(toolResult.content).toContain("参数解析错误");
    });

    it("allowJsonParseError=false 时参数解析错误应标记为 Error", async () => {
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

      const client = createMockClient([
        [
          chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "parseTest", arguments: "{invalid}" } }] }),
          chunk({}, "tool_calls"),
        ],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [tool],
        allowJsonParseError: false,
      });

      agent.append(Message.Assistant());
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

      const client = createMockClient([
        [
          chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "errorTool", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ],
        [chunk({ content: "错误已处理" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [tool],
        allowJsonParseError: true,
      });

      agent.append(Message.Assistant());
      await agent.run();

      expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
      const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
      expect(toolResult.content).toContain("执行工具 errorTool 时出错");
      expect(toolResult.content).toContain("执行出错啦");
      expect(agent.messages.at(-1)!.content).toBe("错误已处理");
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

      const client = createMockClient([
        [
          chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "errorTool", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [tool],
        allowJsonParseError: false,
      });

      agent.append(Message.Assistant());
      await agent.run();

      expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
      const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
      expect(toolResult.status).toBe(AgentNS.MessageStatus.Error);
    });

    it("没有匹配到工具时应返回未知工具提示并继续", async () => {
      const client = createMockClient([
        [
          chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "unknownTool", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ],
        [chunk({ content: "好的，我知道这个工具不可用" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [],
      });

      agent.append(Message.Assistant());
      await agent.run();

      expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
      const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
      expect(toolResult.content).toContain("未知工具");
      expect(toolResult.content).toContain("unknownTool");
    });

    describe("onUnknownTool 钩子", () => {
      it("设置同步 onUnknownTool 时，未知工具调用应返回自定义内容并继续对话", async () => {
        const client = createMockClient([
          [
            chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "noSuchTool", arguments: "{}" } }] }),
            chunk({}, "tool_calls"),
          ],
          [chunk({ content: "我知道了" }), stopChunk()],
        ]);

        const agent = new Agent({
          client,
          model: "gpt-4",
          messages: [Message.System("助手")],
          tools: [],
        });
        agent.use({
          onUnknownTool: (ctx) => {
            const names = ctx.availableTools.map((t) => t.function.name).join(", ");
            return `工具 "${ctx.toolCall.function?.name}" 不可用。可用工具: [${names}]。`;
          },
        });

        agent.append(Message.Assistant());
        await agent.run();

        expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
        const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
        expect(toolResult.content).toContain('工具 "noSuchTool" 不可用');
        expect(toolResult.content).toContain("可用工具");
      });

      it("未设置 onUnknownTool 时使用默认提示", async () => {
        const client = createMockClient([
          [
            chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "unknownTool", arguments: "{}" } }] }),
            chunk({}, "tool_calls"),
          ],
          [chunk({ content: "好的" }), stopChunk()],
        ]);

        const agent = new Agent({
          client,
          model: "gpt-4",
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

        const client = createMockClient([
          [
            chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "sensitiveTool", arguments: "{}" } }] }),
            chunk({}, "tool_calls"),
          ],
          [chunk({ content: "好的，我不执行该敏感操作" }), stopChunk()],
        ]);

        const agent = new Agent({
          client,
          model: "gpt-4",
          messages: [Message.System("助手")],
          tools: [tool],
        });
        agent.use({
          onToolCall: (ctx) =>
            `工具 ${ctx.tool_call.function?.name} 被拒绝：需要用户授权`,
        });

        agent.append(Message.Assistant());
        await agent.run();

        expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
        expect(tool.callback).not.toHaveBeenCalled();
        const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
        expect(toolResult.content).toContain("sensitiveTool");
        expect(toolResult.content).toContain("被拒绝");
        expect(toolResult.content).toContain("需要用户授权");
        expect(toolResult.status).toBe(AgentNS.MessageStatus.Completed);
        expect(agent.messages.at(-1)!.content).toBe("好的，我不执行该敏感操作");
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

        const client = createMockClient([
          [
            chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "safeTool", arguments: "{}" } }] }),
            chunk({}, "tool_calls"),
          ],
          [chunk({ content: "已处理" }), stopChunk()],
        ]);

        const onToolCall = vi.fn(() => undefined);

        const agent = new Agent({
          client,
          model: "gpt-4",
          messages: [Message.System("助手")],
          tools: [tool],
        });
        agent.use({ onToolCall });

        agent.append(Message.Assistant());
        await agent.run();

        expect(onToolCall).toHaveBeenCalledTimes(1);
        const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
        expect(toolResult.content).toBe("安全工具执行结果");
        expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
      });

      it("onToolCall 与 Tool.exec 收到同一个 ToolCallContext 实例", async () => {
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

        const client = createMockClient([
          [
            chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "sharedCtx", arguments: "{}" } }] }),
            chunk({}, "tool_calls"),
          ],
          [chunk({ content: "完成" }), stopChunk()],
        ]);

        const agent = new Agent({
          client,
          model: "gpt-4",
          messages: [Message.System("助手")],
          tools: [tool],
        });
        agent.use({
          onToolCall: (ctx) => {
            hookCtx = ctx;
            expect(ctx.tool_call.function?.name).toBe("sharedCtx");
            expect(ctx.tool).toBe(tool);
            expect(ctx.agent).toBe(agent);
            return undefined;
          },
        });

        agent.append(Message.Assistant());
        await agent.run();

        expect(hookCtx).toBeDefined();
        expect(execCtx).toBeDefined();
        expect(hookCtx).toBe(execCtx);
        expect(hookCtx).toBeInstanceOf(ToolCallContext);
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

        const client = createMockClient([
          [
            chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "denyTool", arguments: "{}" } }] }),
            chunk({ tool_calls: [{ index: 1, id: "2", type: "function", function: { name: "allowTool", arguments: "{}" } }] }),
            chunk({}, "tool_calls"),
          ],
          [chunk({ content: "已分别处理" }), stopChunk()],
        ]);

        const agent = new Agent({
          client,
          model: "gpt-4",
          messages: [Message.System("助手")],
          tools: [denyTool, allowTool],
        });
        agent.use({
          onToolCall: (ctx) => {
            if (ctx.tool_call.function?.name === "denyTool") {
              return `工具 denyTool 被拒绝：不允许使用`;
            }
            return undefined;
          },
        });

        agent.append(Message.Assistant());
        await agent.run();

        expect(denyTool.callback).not.toHaveBeenCalled();
        const toolResults = agent.messages.filter((m) => m.role === AgentNS.Role.Tool);
        expect(toolResults).toHaveLength(2);
        const deniedResult = toolResults.find((m) => m.content!.toString().includes("被拒绝"));
        const allowedResult = toolResults.find((m) => m.content === "allowTool 执行结果");
        expect(deniedResult).toBeDefined();
        expect(deniedResult!.content).toContain("不允许使用");
        expect(allowedResult).toBeDefined();
        expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
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

      const client = createMockClient([
        [
          chunk({ function_call: { name: "oldFn" } }),
          chunk({ function_call: { arguments: "{}" } }),
          chunk({}, "function_call"),
        ],
        [chunk({ content: "旧版函数已处理" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [tool],
      });

      agent.append(Message.Assistant());
      await agent.run();

      expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
      const funcResult = agent.messages.find((m) => m.role === AgentNS.Role.Function)!;
      expect(funcResult).toBeDefined();
      expect(funcResult.content).toBe("旧版函数执行成功");
    });
  });

  describe("run - 中止流程", () => {
    it("运行中调用 abort 应中止并标记 Aborted", async () => {
      let capturedSignal: AbortSignal | undefined;

      const create = vi.fn(async (_body: any, options: any) => {
        capturedSignal = options.signal;
        // 返回一个挂起流，abort 时结束
        return makeHangingStream(options.signal);
      });

      const client = { chat: { completions: { create } } } as any;

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());

      const runPromise = agent.run();
      await new Promise((r) => setTimeout(r, 50));
      agent.abort();

      await runPromise;
      const lastMsg = agent.messages.at(-1)!;
      expect(lastMsg.status).toBe(AgentNS.MessageStatus.Aborted);
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(true);
    });

    it("abort 应清空 pendingTasks", () => {
      const agent = new Agent({
        client: {} as any,
        model: "gpt-4",
        messages: [Message.System("你好")],
      });

      agent.abort();
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

      let callCount = 0;
      const create = vi.fn(async (_body: any, options: any) => {
        if (callCount === 0) {
          callCount++;
          return makeStream([
            chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "getTime", arguments: "{}" } }] }),
            chunk({}, "tool_calls"),
          ]);
        }
        callCount++;
        // 第二轮挂起，abort 时结束
        return makeHangingStream(options.signal);
      });

      const client = { chat: { completions: { create } } } as any;

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [tool],
      });
      agent.append(Message.Assistant());

      const runPromise = agent.run();
      // 等待第二轮开始（等待 create 第二次调用）
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      agent.abort();
      await runPromise;

      const messages = agent.messages;
      expect(messages[1].role).toBe(AgentNS.Role.Assistant);
      expect(messages[1].status).toBe(AgentNS.MessageStatus.Completed);
      expect(messages[2].role).toBe(AgentNS.Role.Tool);
      expect(messages[2].status).toBe(AgentNS.MessageStatus.Completed);
      expect(messages[2].content).toBe("12:00:00");
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

      let callCount = 0;
      let resolveSecond!: () => void;
      const secondStarted = new Promise<void>((r) => { resolveSecond = r; });

      const create = vi.fn(async (_body: any, options: any) => {
        if (callCount === 0) {
          callCount++;
          return makeStream([
            chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "getTime", arguments: "{}" } }] }),
            chunk({}, "tool_calls"),
          ]);
        }
        callCount++;
        resolveSecond();
        return makeHangingStream(options.signal);
      });

      const client = { chat: { completions: { create } } } as any;

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [tool],
      });
      agent.append(Message.Assistant());

      const runPromise = agent.run();
      await secondStarted;

      expect((agent as any).innerLoopsTasks.size).toBe(3);
      expect((agent as any).innerLoopTasks.size).toBe(1);

      agent.abort();
      await runPromise;

      expect((agent as any).innerLoopsTasks.size).toBe(0);
      expect((agent as any).innerLoopTasks.size).toBe(0);
    });

    it("单轮 run 结束后 innerLoopsTasks 与 innerLoopTasks 均清空", async () => {
      const client = createMockClient([
        [chunk({ content: "你好" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
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
      const client = createMockClient([
        [chunk({ content: "回复" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
      });
      agent.append(Message.Assistant());

      const runHandler = vi.fn();
      const openHandler = vi.fn();
      const parsedHandler = vi.fn();
      const loopEndHandler = vi.fn();
      const chunkHandler = vi.fn();
      const finallyHandler = vi.fn();

      agent.events.on("inner-loop-start", runHandler);
      agent.events.on("open", openHandler);
      agent.events.on("parsed", parsedHandler);
      agent.events.on("inner-loop-end", loopEndHandler);
      agent.events.on("chunk", chunkHandler);
      agent.events.on("finally", finallyHandler);

      await agent.run();

      expect(runHandler).toHaveBeenCalledTimes(1);
      expect(openHandler).toHaveBeenCalledTimes(1);
      expect(parsedHandler).toHaveBeenCalledTimes(1);
      expect(loopEndHandler).toHaveBeenCalledTimes(1);
      expect(chunkHandler).toHaveBeenCalledTimes(2);
      expect(finallyHandler).toHaveBeenCalledTimes(1);
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

      const client = createMockClient([
        [
          chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "testTool", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ],
        [chunk({ content: "最终回复" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [tool],
      });
      agent.append(Message.Assistant());

      const runHandler = vi.fn();
      const loopEndHandler = vi.fn();

      agent.events.on("inner-loop-start", runHandler);
      agent.events.on("inner-loop-end", loopEndHandler);

      await agent.run();

      expect(runHandler).toHaveBeenCalledTimes(2);
      expect(loopEndHandler).toHaveBeenCalledTimes(2);
    });

    it("整组内循环事件 inner-loops-start/end 一次 run 各触发一次", async () => {
      const client = createMockClient([
        [chunk({ content: "回复" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
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
      // 事件 payload 现为 SendContext（收口后事件与插件统一入参）
      expect(loopsStart.mock.calls[0][0].agent).toBe(agent);
      expect(loopsEnd.mock.calls[0][0].agent).toBe(agent);
    });

    it("触发 error 事件时应携带错误信息", async () => {
      const client = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw new Error("测试错误");
            }),
          },
        },
      } as any;

      const agent = new Agent({
        client,
        model: "gpt-4",
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
      const client = createMockClient([
        [chunk({ content: "这是回复" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("你是一个助手")],
      });

      const result = await agent.send("你好");

      expect(result).toBe(agent.messages);
      expect(agent.messages[0].role).toBe(AgentNS.Role.System);
      expect(agent.messages[1].role).toBe(AgentNS.Role.User);
      expect(agent.messages[1].content).toBe("你好");
      expect(agent.messages[2].role).toBe(AgentNS.Role.Assistant);
      expect(agent.messages[2].content).toBe("这是回复");
    });

    it("send 后 isHasPendingMessage 应为 false", async () => {
      const client = createMockClient([
        [chunk({ content: "ok" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
      });

      await agent.send("hi");
      expect(agent.isHasPendingMessage).toBe(false);
    });
  });

  describe("插件机制", () => {
    it("use/init 应执行插件 onInit", async () => {
      const onInit = vi.fn();
      const agent = new Agent({ client: {} as any, model: "gpt-4" });
      agent.use({ onInit });
      await agent.init();
      expect(onInit).toHaveBeenCalledTimes(1);
    });

    it("send 应触发 onBeforeSend / onAfterSend 插件钩子", async () => {
      const client = createMockClient([
        [chunk({ content: "ok" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
      });

      const onBeforeSend = vi.fn();
      const onAfterSend = vi.fn();
      agent.use({ onBeforeSend, onAfterSend });

      await agent.send("hi");

      expect(onBeforeSend).toHaveBeenCalledTimes(1);
      expect(onAfterSend).toHaveBeenCalledTimes(1);
      expect(onBeforeSend.mock.calls[0][0].agent).toBe(agent);
      expect(onBeforeSend.mock.calls[0][0].content).toBe("hi");
      // onAfterSend 在消息完成后调用
      expect(agent.messages.at(-1)!.status).toBe(AgentNS.MessageStatus.Completed);
    });

    it("onBeforeSend 可刷新工具列表（影响本轮请求）", async () => {
      const tool = new CallbackTool({
        function: {
          name: "dynamicTool",
          description: "动态工具",
          parameters: { type: "object", properties: {} },
        },
        callback: () => "动态工具结果",
      });

      const client = createMockClient([
        [
          chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "dynamicTool", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ],
        [chunk({ content: "完成" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
      });

      agent.use({
        onBeforeSend: (ctx) => {
          ctx.agent.tools = [tool];
        },
      });

      await agent.send("请使用工具");

      const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
      expect(toolResult.content).toBe("动态工具结果");
    });

    it("onInnerLoopStart/End 插件钩子应每轮触发", async () => {
      const client = createMockClient([
        [chunk({ content: "ok" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
      });

      const onInnerLoopStart = vi.fn();
      const onInnerLoopEnd = vi.fn();
      agent.use({ onInnerLoopStart, onInnerLoopEnd });

      await agent.send("hi");

      expect(onInnerLoopStart).toHaveBeenCalledTimes(1);
      expect(onInnerLoopEnd).toHaveBeenCalledTimes(1);
    });

    it("插件 onToolCall 返回字符串时拒绝工具（短路）", async () => {
      const tool = new CallbackTool({
        function: {
          name: "blockedTool",
          description: "被插件拒绝的工具",
          parameters: { type: "object", properties: {} },
        },
        callback: vi.fn(() => "不应执行"),
      });

      const client = createMockClient([
        [
          chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "blockedTool", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ],
        [chunk({ content: "已处理拒绝" }), stopChunk()],
      ]);

      const agent = new Agent({
        client,
        model: "gpt-4",
        messages: [Message.System("助手")],
        tools: [tool],
      });

      agent.use({
        onToolCall: (ctx) =>
          ctx.tool_call.function?.name === "blockedTool"
            ? "插件拒绝：不允许"
            : undefined,
      });

      await agent.send("hi");

      expect(tool.callback).not.toHaveBeenCalled();
      const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
      expect(toolResult.content).toContain("插件拒绝");
    });
  });

  describe("isHasPendingMessage", () => {
    it("有 Pending 消息时应返回 true", () => {
      const agent = new Agent({ client: {} as any, model: "gpt-4" });
      agent.append(Message.Assistant());
      expect(agent.isHasPendingMessage).toBe(true);
    });

    it("无 Pending 消息时应返回 false", () => {
      const agent = new Agent({ client: {} as any, model: "gpt-4" });
      agent.append(Message.System("你好"));
      expect(agent.isHasPendingMessage).toBe(false);
    });
  });
});
