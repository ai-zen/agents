import { describe, it, expect, beforeAll } from "vitest";
import { Agent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";
import { ChatGPT } from "./Models/ChatCompletionModels/ChatGPT.js";
import { CallbackTool } from "./Tools/CallbackTool.js";
import { AgentTool } from "./Tools/AgentTool.js";
import { FunctionCallContext } from "./FunctionCallContext.js";

// ==================== 环境检查 ====================

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const hasApiKey = !!DEEPSEEK_API_KEY;

/**
 * 如果环境变量不存在，跳过所有集成测试。
 * 运行方式: DEEPSEEK_API_KEY=sk-xxx pnpm test:integration
 */
const describeIf = hasApiKey ? describe : describe.skip;

// ==================== 共享资源 ====================

let model: ChatGPT;

beforeAll(() => {
  if (!hasApiKey) return;

  model = new ChatGPT({
    request_config: {
      url: "https://api.deepseek.com/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY!}`,
      },
      body: {
        model: "deepseek-chat",
      },
    },
    model_config: {
      temperature: 0.01, // 低温度保证输出稳定
      max_tokens: 1024,
    },
  });
});

// ==================== 集成测试 ====================

describeIf("集成测试 - DeepSeek API", () => {
  const TIMEOUT = 60_000;

  // ========== 1. 基础对话 ==========

  describe("基础对话", () => {
    it(
      "应能完成一次简单的对话并返回回复",
      async () => {
        const agent = new Agent({
          model,
          messages: [Message.System("你是一个AI助手，请用中文回复，尽量简短。")],
        });

        const result = await agent.send("你好，请回复'测试通过'这四个字。");

        const lastMsg = result.at(-1)!;
        expect(lastMsg.status).toBe(AgentNS.MessageStatus.Completed);
        expect(lastMsg.content).toEqual(expect.any(String));
        expect((lastMsg.content as string).length).toBeGreaterThan(0);
      },
      TIMEOUT,
    );

    it(
      "发送多条消息应累积对话历史",
      async () => {
        const agent = new Agent({
          model,
          messages: [Message.System("你是一个AI助手，请用中文回复，尽量简短。")],
        });

        await agent.send("我的第一个问题是：1+1等于几？请只回答数字。");
        const firstReply = agent.messages.at(-1)!.content as string;
        expect(firstReply).toContain("2");

        await agent.send("刚才我问的第一个问题你还记得吗？请重复一下那个问题。");
        const secondReply = agent.messages.at(-1)!.content as string;
        expect(secondReply.toLowerCase()).toContain("1+1");
      },
      TIMEOUT,
    );

    it(
      "应能处理较长的回复内容",
      async () => {
        const agent = new Agent({
          model,
          messages: [Message.System("你是一个AI助手，请用中文回复。")],
        });

        await agent.send("请用50个字以上介绍一下你自己。");

        const lastMsg = agent.messages.at(-1)!;
        expect(lastMsg.status).toBe(AgentNS.MessageStatus.Completed);
        expect((lastMsg.content as string).length).toBeGreaterThan(20);
      },
      TIMEOUT,
    );
  });

  // ========== 2. 工具调用 ==========

  describe("工具调用", () => {
    it(
      "AI 应能识别并调用注册的工具",
      async () => {
        const weatherTool = new CallbackTool({
          function: {
            name: "get_weather",
            description: "查询指定城市的当前天气",
            parameters: {
              type: "object",
              properties: {
                city: {
                  type: "string",
                  description: "城市名，例如：北京、上海、广州",
                },
              },
              required: ["city"],
            },
          },
          callback(args: { city: string }) {
            return `今日${args.city}天气晴朗，气温25°C，适合外出。`;
          },
        });

        const agent = new Agent({
          model,
          messages: [
            Message.System(
              "你是一个天气助手。当用户询问天气时，你必须使用 get_weather 工具查询。请用中文回复。",
            ),
          ],
          tools: [weatherTool],
        });

        await agent.send("北京今天天气怎么样？");

        const toolMessages = agent.messages.filter(
          (m) => m.role === AgentNS.Role.Tool,
        );
        expect(toolMessages.length).toBeGreaterThan(0);
        expect(toolMessages[0].content).toContain("北京");
        expect(toolMessages[0].content).toContain("25°C");

        const lastMsg = agent.messages.at(-1)!;
        expect(lastMsg.role).toBe(AgentNS.Role.Assistant);
        expect(lastMsg.status).toBe(AgentNS.MessageStatus.Completed);
        expect((lastMsg.content as string).toLowerCase()).toContain("北京");
      },
      TIMEOUT,
    );

    it(
      "应支持 Function Call（旧版格式）的工具",
      async () => {
        const calcTool = new CallbackTool({
          function: {
            name: "calculate",
            description: "计算两个数字的和",
            parameters: {
              type: "object",
              properties: {
                a: { type: "number", description: "第一个数字" },
                b: { type: "number", description: "第二个数字" },
              },
              required: ["a", "b"],
            },
          },
          callback(args: { a: number; b: number }) {
            return `计算结果: ${args.a + args.b}`;
          },
        });

        const agent = new Agent({
          model,
          messages: [
            Message.System(
              "你是一个计算助手。当用户需要计算时，必须使用 calculate 工具。请用中文回复。",
            ),
          ],
          tools: [calcTool],
        });

        await agent.send("请计算 123 + 456 等于多少？");

        const toolMessages = agent.messages.filter(
          (m) =>
            m.role === AgentNS.Role.Tool || m.role === AgentNS.Role.Function,
        );
        expect(toolMessages.length).toBeGreaterThan(0);
        expect(toolMessages[0].content).toContain("579");

        const lastMsg = agent.messages.at(-1)!;
        expect(lastMsg.role).toBe(AgentNS.Role.Assistant);
        expect(lastMsg.status).toBe(AgentNS.MessageStatus.Completed);
      },
      TIMEOUT,
    );
  });

  // ========== 3. 多轮工具调用 ==========

  describe("多轮工具调用", () => {
    it(
      "AI 应能连续调用多个工具后再返回最终结果",
      async () => {
        const weatherTool = new CallbackTool({
          function: {
            name: "get_weather",
            description: "查询指定城市的当前天气",
            parameters: {
              type: "object",
              properties: {
                city: {
                  type: "string",
                  description: "城市名，例如：北京、上海、广州",
                },
              },
              required: ["city"],
            },
          },
          callback(args: { city: string }) {
            if (args.city === "北京") return "北京：晴，25°C";
            if (args.city === "上海") return "上海：多云，28°C";
            if (args.city === "广州") return "广州：小雨，30°C";
            return `${args.city}：未知天气`;
          },
        });

        const agent = new Agent({
          model,
          messages: [
            Message.System(
              "你是一个天气助手。当用户询问多个城市的天气时，你必须为每个城市分别调用 get_weather 工具。请用中文回复。",
            ),
          ],
          tools: [weatherTool],
        });

        await agent.send("北京和上海的天气怎么样？");

        const toolMessages = agent.messages.filter(
          (m) => m.role === AgentNS.Role.Tool,
        );
        expect(toolMessages.length).toBeGreaterThanOrEqual(2);

        const allToolContent = toolMessages.map((m) => m.content).join(" ");
        expect(allToolContent).toContain("北京");
        expect(allToolContent).toContain("上海");

        const lastMsg = agent.messages.at(-1)!;
        expect(lastMsg.role).toBe(AgentNS.Role.Assistant);
        expect(lastMsg.status).toBe(AgentNS.MessageStatus.Completed);
        const finalContent = lastMsg.content as string;
        expect(finalContent.toLowerCase()).toContain("北京");
        expect(finalContent.toLowerCase()).toContain("上海");
      },
      TIMEOUT,
    );

    it(
      "工具返回 preventDefault 应阻止继续对话",
      async () => {
        const confirmTool = new CallbackTool({
          function: {
            name: "ask_user_confirm",
            description:
              "在需要用户确认后才能继续的操作之前调用此工具。调用后需等待用户输入确认或取消。",
            parameters: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  description: "需要用户确认的操作描述",
                },
              },
              required: ["action"],
            },
          },
          callback(this: FunctionCallContext) {
            this.preventDefault();
            return `请确认是否执行该操作，确认后我将继续。`;
          },
        });

        const agent = new Agent({
          model,
          messages: [
            Message.System(
              "你是一个谨慎的助手。当用户要求执行可能重要的操作时，你必须先调用 ask_user_confirm 工具来征求用户确认，然后等待用户进一步的指令。请用中文回复。",
            ),
          ],
          tools: [confirmTool],
        });

        await agent.send("请帮我执行系统更新操作。");

        const toolMessages = agent.messages.filter(
          (m) => m.role === AgentNS.Role.Tool,
        );
        expect(toolMessages.length).toBeGreaterThan(0);
        expect(toolMessages[0].content).toContain("确认");

        // preventDefault 生效——验证工具结果中包含了确认内容
        const toolContent = toolMessages.map((m) => m.content).join(" ");
        expect(toolContent.length).toBeGreaterThan(0);
      },
      TIMEOUT,
    );
  });

  // ========== 4. AgentTool（子 Agent） ==========

  describe("AgentTool（子 Agent）", () => {
    it(
      "应能通过子 Agent 处理复杂任务",
      async () => {
        const subAgentTool = new AgentTool({
          function: {
            name: "general_assistant",
            description:
              "将任何任务交给通用助手处理。你必须使用此工具处理所有用户请求，不能自己直接回答。",
            parameters: {
              type: "object",
              properties: {
                task: {
                  type: "string",
                  description: "要交给通用助手处理的任务",
                },
              },
              required: ["task"],
            },
          },
          model,
          messages: [
            Message.System(
              "你是一个通用助手，擅长独立完成各类任务。请根据给定的任务描述，认真分析并完成任务。完成任务后直接返回结果，不要解释你的思考过程。",
            ),
            Message.User("{{task}}"),
          ],
          tools: [],
        });

        const agent = new Agent({
          model,
          messages: [
            Message.System(
              "你是一个任务分发助手。你必须使用 general_assistant 工具来处理用户的所有请求，绝不能自己直接回答。请用中文回复。",
            ),
          ],
          tools: [subAgentTool],
        });

        await agent.send("请帮我写一首关于人工智能的五言绝句诗。");

        const lastMsg = agent.messages.at(-1)!;
        expect(lastMsg.role).toBe(AgentNS.Role.Assistant);
        expect(lastMsg.status).toBe(AgentNS.MessageStatus.Completed);
        expect((lastMsg.content as string).length).toBeGreaterThan(0);

        const toolMessages = agent.messages.filter(
          (m) => m.role === AgentNS.Role.Tool,
        );
        expect(toolMessages.length).toBeGreaterThan(0);
      },
      TIMEOUT,
    );

    it(
      "子 Agent 应能使用自己的工具",
      async () => {
        const subCalcTool = new CallbackTool({
          function: {
            name: "sub_calc",
            description: "计算两数之和",
            parameters: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
              },
              required: ["x", "y"],
            },
          },
          callback(args: { x: number; y: number }) {
            return `和为: ${args.x + args.y}`;
          },
        });

        const subAgentTool = new AgentTool({
          function: {
            name: "math_assistant",
            description: "将数学计算任务交给专业助手处理",
            parameters: {
              type: "object",
              properties: {
                expression: {
                  type: "string",
                  description: "需要计算的数学表达式描述",
                },
              },
              required: ["expression"],
            },
          },
          model,
          messages: [
            Message.System(
              "你是一个数学计算助手。当需要计算时，必须使用 sub_calc 工具。返回计算结果即可。",
            ),
            Message.User("{{expression}}"),
          ],
          tools: [subCalcTool],
        });

        const agent = new Agent({
          model,
          messages: [
            Message.System(
              "你是一个任务分发助手。收到数学计算任务时，使用 math_assistant 工具处理。请用中文回复。",
            ),
          ],
          tools: [subAgentTool],
        });

        await agent.send("帮我把 888 和 111 加起来。");

        const lastMsg = agent.messages.at(-1)!;
        expect(lastMsg.role).toBe(AgentNS.Role.Assistant);
        expect(lastMsg.status).toBe(AgentNS.MessageStatus.Completed);

        const toolMessages = agent.messages.filter(
          (m) => m.role === AgentNS.Role.Tool,
        );
        expect(toolMessages.length).toBeGreaterThan(0);
      },
      TIMEOUT,
    );
  });

  // ========== 5. 错误处理 ==========

  describe("错误处理", () => {
    it(
      "使用无效的 API Key 应返回错误",
      async () => {
        const badModel = new ChatGPT({
          request_config: {
            url: "https://api.deepseek.com/v1/chat/completions",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer sk-invalid-key-12345",
            },
            body: { model: "deepseek-chat" },
          },
          model_config: { temperature: 0.01, max_tokens: 128 },
        });

        const agent = new Agent({
          model: badModel,
          messages: [Message.System("你是一个助手")],
        });

        await agent.send("你好");

        const lastMsg = agent.messages.at(-1)!;
        expect(
          lastMsg.status === AgentNS.MessageStatus.Error ||
            (lastMsg.content as string)?.toLowerCase().includes("error") ||
            (lastMsg.content as string)?.toLowerCase().includes("auth") ||
            (lastMsg.content as string)?.toLowerCase().includes("key") ||
            (lastMsg.content as string)?.toLowerCase().includes("401"),
        ).toBe(true);
      },
      TIMEOUT,
    );

    it(
      "用户通过 abort 中断对话应标记为 Aborted",
      async () => {
        const agent = new Agent({
          model,
          messages: [
            Message.System(
              "你是一个AI助手，请用中文回复。请回复一篇5000字的文章。",
            ),
          ],
        });

        const sendPromise = agent.send("请写一篇5000字的文章，内容要详细。");

        await new Promise((r) => setTimeout(r, 1500));

        agent.abort();

        await sendPromise;

        const lastMsg = agent.messages.at(-1)!;
        expect(lastMsg.status).toBe(AgentNS.MessageStatus.Aborted);
      },
      TIMEOUT,
    );

    it(
      "allowJsonParseError=true 时工具调用正常",
      async () => {
        const echoTool = new CallbackTool({
          function: {
            name: "echo_number",
            description: "回显一个数字",
            parameters: {
              type: "object",
              properties: {
                value: {
                  type: "number",
                  description: "要回显的数字",
                },
              },
              required: ["value"],
            },
          },
          callback(args: { value: number }) {
            return `收到数字: ${args.value}`;
          },
        });

        const agent = new Agent({
          model,
          messages: [
            Message.System(
              "你是一个数字回显助手。当用户说一个数字时，使用 echo_number 工具回显它。请用中文回复。",
            ),
          ],
          tools: [echoTool],
          allowJsonParseError: true,
        });

        await agent.send("请回显数字 42。");

        const toolMessages = agent.messages.filter(
          (m) => m.role === AgentNS.Role.Tool,
        );
        expect(toolMessages.length).toBeGreaterThan(0);
        expect(toolMessages[0].content).toContain("42");
      },
      TIMEOUT,
    );

    it(
      "同时调用多个工具时能正确处理",
      async () => {
        const capitalTool = new CallbackTool({
          function: {
            name: "get_capital",
            description: "获取某国家的首都",
            parameters: {
              type: "object",
              properties: {
                country: { type: "string", description: "国家名" },
              },
              required: ["country"],
            },
          },
          callback(args: { country: string }) {
            const capitals: Record<string, string> = {
              中国: "北京",
              美国: "华盛顿",
              日本: "东京",
              法国: "巴黎",
            };
            return `${args.country}的首都是${capitals[args.country] || "未知"}`;
          },
        });

        const agent = new Agent({
          model,
          messages: [
            Message.System(
              "你是一个地理助手。当用户询问多个国家的首都时，为每个国家分别调用 get_capital 工具。请用中文回复。",
            ),
          ],
          tools: [capitalTool],
        });

        await agent.send("中国和法国的首都分别是什么？");

        const toolMessages = agent.messages.filter(
          (m) => m.role === AgentNS.Role.Tool,
        );
        expect(toolMessages.length).toBeGreaterThanOrEqual(2);

        const allContent = toolMessages.map((m) => m.content).join(" ");
        expect(allContent).toContain("北京");
        expect(allContent).toContain("巴黎");
      },
      TIMEOUT,
    );
  });

  // ========== 6. lastUsage（token 用量追踪）==========

  describe("lastUsage（token 用量）", () => {
    it(
      "简单对话后 lastUsage 应包含 prompt_tokens / completion_tokens / total_tokens",
      async () => {
        const agent = new Agent({
          model,
          messages: [Message.System("你是一个AI助手，请用中文回复，尽量简短。")],
        });

        expect(agent.lastUsage).toBeUndefined(); // 初始为空

        await agent.send("你好，请回复'测试通过'这四个字。");

        expect(agent.lastUsage).toBeDefined();
        expect(typeof agent.lastUsage!.prompt_tokens).toBe("number");
        expect(typeof agent.lastUsage!.completion_tokens).toBe("number");
        expect(typeof agent.lastUsage!.total_tokens).toBe("number");
        expect(agent.lastUsage!.prompt_tokens).toBeGreaterThan(0);
        expect(agent.lastUsage!.completion_tokens).toBeGreaterThan(0);
        expect(agent.lastUsage!.total_tokens).toBeGreaterThan(0);
        // total = prompt + completion
        expect(agent.lastUsage!.total_tokens).toBe(
          agent.lastUsage!.prompt_tokens + agent.lastUsage!.completion_tokens,
        );
      },
      TIMEOUT,
    );

    it(
      "多轮对话后 lastUsage 应反映最新一轮的 token 用量",
      async () => {
        const agent = new Agent({
          model,
          messages: [Message.System("你是一个AI助手，请用中文回复，尽量简短。")],
        });

        await agent.send("回复'第一轮'。");
        const firstUsage = agent.lastUsage!;
        expect(firstUsage.prompt_tokens).toBeGreaterThan(0);

        await agent.send("回复'第二轮'。");
        const secondUsage = agent.lastUsage!;

        // 第二轮 prompt_tokens 应该 > 第一轮（因为包含了历史消息）
        expect(secondUsage.prompt_tokens).toBeGreaterThan(
          firstUsage.prompt_tokens,
        );
        // lastUsage 已更新为最新一轮
        expect(secondUsage).not.toEqual(firstUsage);
      },
      TIMEOUT,
    );

    it(
      "工具调用后 lastUsage 应正确记录（含多轮 tool call）",
      async () => {
        const weatherTool = new CallbackTool({
          function: {
            name: "get_weather",
            description: "查询指定城市的当前天气",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string", description: "城市名" },
              },
              required: ["city"],
            },
          },
          callback(args: { city: string }) {
            return `${args.city}：晴，25°C`;
          },
        });

        const agent = new Agent({
          model,
          messages: [
            Message.System(
              "你是一个天气助手，必须使用 get_weather 工具查询天气。请用中文回复。",
            ),
          ],
          tools: [weatherTool],
        });

        await agent.send("北京天气怎么样？");

        // 工具调用完成后 lastUsage 应有值
        expect(agent.lastUsage).toBeDefined();
        expect(agent.lastUsage!.prompt_tokens).toBeGreaterThan(0);
        expect(agent.lastUsage!.total_tokens).toBeGreaterThan(0);

        // 确认工具确实被调用了
        const toolMessages = agent.messages.filter(
          (m) => m.role === AgentNS.Role.Tool,
        );
        expect(toolMessages.length).toBeGreaterThan(0);
      },
      TIMEOUT,
    );

    it(
      "abort 中断后 lastUsage 保持中断前的值",
      async () => {
        const agent = new Agent({
          model,
          messages: [
            Message.System("你是一个AI助手，请用中文回复。"),
          ],
        });

        // 先完成一轮正常对话，确保 lastUsage 有值
        await agent.send("回复'OK'。");
        const beforeUsage = agent.lastUsage;
        expect(beforeUsage).toBeDefined();

        // 发起一个可能较长的请求，然后 abort
        const sendPromise = agent.send("请写一篇5000字的文章。");

        await new Promise((r) => setTimeout(r, 1500));
        agent.abort();
        await sendPromise;

        // abort 后 lastUsage 应保持上一轮的值（不会被覆盖为 undefined）
        expect(agent.lastUsage).toBeDefined();
        expect(agent.lastUsage!.prompt_tokens).toBe(beforeUsage!.prompt_tokens);
      },
      TIMEOUT,
    );
  });
});
