import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatGPT, ChatGPTTypes } from "./ChatGPT.js";
import { AgentNS } from "../../AgentNS.js";
import { AsyncQueue } from "@ai-zen/async-queue";

// Mock fetchEventSource
vi.mock("@ai-zen/node-fetch-event-source", () => ({
  EventStreamContentType: "text/event-stream",
  fetchEventSource: vi.fn(),
}));

import { fetchEventSource, EventStreamContentType } from "@ai-zen/node-fetch-event-source";

function createDefaultModel() {
  return new ChatGPT({
    model_config: { temperature: 0.7 },
    request_config: {
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-test",
      },
      body: { model: "gpt-4" },
    },
  });
}

describe("ChatGPT Model", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("构造函数与配置", () => {
    it("应正确设置模型属性", () => {
      const model = createDefaultModel();
      expect(model.code).toBe("chatgpt");
      expect(model.title).toBe("ChatGPT");
      expect(model.name).toBe("ChatGPT");
      expect(model.IS_SUPPORT_FUNCTION_CALL).toBe(true);
      expect(model.IS_SUPPORT_TOOLS_CALL).toBe(true);
      expect(model.IS_SUPPORT_IMAGE_CONTENT).toBe(true);
    });

    it("缺少 model_config 时 createCompletion 应抛出错误", async () => {
      const model = new ChatGPT({ request_config: {} as any });
      await expect(
        model.createCompletion({ messages: [], tools: [] }),
      ).rejects.toThrow("ChatGPT config not set");
    });

    it("缺少 request_config 时 createCompletion 应抛出错误", async () => {
      const model = new ChatGPT({ model_config: {} as any });
      await expect(
        model.createCompletion({ messages: [], tools: [] }),
      ).rejects.toThrow("ChatGPT request not set");
    });
  });

  describe("formatTools", () => {
    it("tools 为空或 undefined 时应返回空对象", () => {
      const model = createDefaultModel();
      expect(model.formatTools(undefined)).toEqual({});
      expect(model.formatTools([])).toEqual({});
    });

    it("应注入 strict: true 到每个 tool", () => {
      const model = createDefaultModel();
      const tools: AgentNS.ToolDefine[] = [
        {
          type: "function",
          function: {
            name: "getWeather",
            description: "获取天气",
            parameters: { type: "object", properties: {} },
          },
        },
      ];
      const result = model.formatTools(tools);
      expect(result).toHaveProperty("tools");
      expect(result).toHaveProperty("tool_choice", "auto");
      expect((result as any).tools[0].function.strict).toBe(true);
    });

    it("IS_SUPPORT_TOOLS_CALL=false 时回退到 functions", () => {
      const model = createDefaultModel();
      model.IS_SUPPORT_TOOLS_CALL = false;

      const tools: AgentNS.ToolDefine[] = [
        {
          type: "function",
          function: {
            name: "getWeather",
            description: "获取天气",
            parameters: { type: "object", properties: {} },
          },
        },
      ];
      const result = model.formatTools(tools);
      expect(result).toHaveProperty("functions");
      expect(result).toHaveProperty("function_call", "auto");
      expect((result as any).functions[0].name).toBe("getWeather");
    });

    it("IS_SUPPORT_TOOLS_CALL 和 IS_SUPPORT_FUNCTION_CALL 都 false 时返回空对象", () => {
      const model = createDefaultModel();
      model.IS_SUPPORT_TOOLS_CALL = false;
      model.IS_SUPPORT_FUNCTION_CALL = false;

      const tools: AgentNS.ToolDefine[] = [
        {
          type: "function",
          function: {
            name: "test",
            description: "test",
            parameters: { type: "object", properties: {} },
          },
        },
      ];
      expect(model.formatTools(tools)).toEqual({});
    });
  });

  describe("formatFinalResponse", () => {
    it("应正确映射所有 finish_reason", () => {
      const model = createDefaultModel();

      expect(model.formatFinalResponse(null)).toBe(AgentNS.FinishReason.Stop);
      expect(model.formatFinalResponse(ChatGPTTypes.FinishReason.Stop)).toBe(AgentNS.FinishReason.Stop);
      expect(model.formatFinalResponse(ChatGPTTypes.FinishReason.Length)).toBe(AgentNS.FinishReason.Length);
      expect(model.formatFinalResponse(ChatGPTTypes.FinishReason.ContentFilter)).toBe(AgentNS.FinishReason.ContentFilter);
      expect(model.formatFinalResponse(ChatGPTTypes.FinishReason.FunctionCall)).toBe(AgentNS.FinishReason.FunctionCall);
      expect(model.formatFinalResponse(ChatGPTTypes.FinishReason.ToolCalls)).toBe(AgentNS.FinishReason.ToolCalls);
    });

    it("未识别的 finish_reason 应返回 Unknown", () => {
      const model = createDefaultModel();
      expect(model.formatFinalResponse("some_unknown_reason" as any)).toBe(AgentNS.FinishReason.Unknown);
    });
  });

  describe("formatRole", () => {
    it("应正确映射所有角色", () => {
      const model = createDefaultModel();

      expect(model.formatRole(ChatGPTTypes.Role.System)).toBe(AgentNS.Role.System);
      expect(model.formatRole(ChatGPTTypes.Role.User)).toBe(AgentNS.Role.User);
      expect(model.formatRole(ChatGPTTypes.Role.Assistant)).toBe(AgentNS.Role.Assistant);
      expect(model.formatRole(ChatGPTTypes.Role.Function)).toBe(AgentNS.Role.Function);
      expect(model.formatRole(ChatGPTTypes.Role.Tool)).toBe(AgentNS.Role.Tool);
    });

    it("未识别的角色应返回 Unknown", () => {
      const model = createDefaultModel();
      expect(model.formatRole("unknown_role" as any)).toBe(AgentNS.Role.Unknown);
    });
  });

  describe("formatData", () => {
    it("应正确格式化非流式响应", () => {
      const model = createDefaultModel();
      const rawData: ChatGPTTypes.ResponseData = {
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1677652288,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: ChatGPTTypes.Role.Assistant,
              content: "你好！我是助手。",
            },
            finish_reason: ChatGPTTypes.FinishReason.Stop,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      };

      const result = model.formatData(rawData);
      expect(result.id).toBe("chatcmpl-123");
      expect(result.choices).toHaveLength(1);
      expect(result.choices![0].message!.role).toBe(AgentNS.Role.Assistant);
      expect(result.choices![0].message!.content).toBe("你好！我是助手。");
      expect(result.choices![0].finish_reason).toBe(AgentNS.FinishReason.Stop);
    });

    it("应处理 choices 为空的响应", () => {
      const model = createDefaultModel();
      const result = model.formatData({} as any);
      expect(result.choices).toBeUndefined();
    });

    it("应处理带 tool_calls 的 assistant 消息", () => {
      const model = createDefaultModel();
      const rawData: ChatGPTTypes.ResponseData = {
        id: "chatcmpl-456",
        object: "chat.completion",
        created: 1677652288,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: ChatGPTTypes.Role.Assistant,
              content: null as any,
              tool_calls: [
                {
                  id: "1",
                  type: "function",
                  function: { name: "getWeather", arguments: '{"city":"北京"}' },
                },
              ],
            },
            finish_reason: ChatGPTTypes.FinishReason.ToolCalls,
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
      };

      const result = model.formatData(rawData);
      const toolCalls = result.choices![0].message!.tool_calls;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls![0].function!.name).toBe("getWeather");
      expect(result.choices![0].finish_reason).toBe(AgentNS.FinishReason.ToolCalls);
    });
  });

  describe("formatSteamData", () => {
    it("应正确格式化流式数据", () => {
      const model = createDefaultModel();
      const rawData: ChatGPTTypes.StreamResponseData = {
        id: "chatcmpl-789",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            delta: {
              role: ChatGPTTypes.Role.Assistant,
              content: "你好",
            },
            finish_reason: null,
          },
        ],
        usage: null,
      };

      const result = model.formatSteamData(rawData);
      expect(result.choices![0].delta!.role).toBe(AgentNS.Role.Assistant);
      expect(result.choices![0].delta!.content).toBe("你好");
      expect(result.choices![0].finish_reason).toBe(AgentNS.FinishReason.Stop);
    });
  });

  describe("createCompletion (mock fetch)", () => {
    it("应成功发起请求并返回格式化数据", async () => {
      const model = createDefaultModel();
      const mockResponse = {
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1677652288,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "你好！我是助手。" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue(mockResponse),
      }));

      const result = await model.createCompletion({
        messages: [{ role: AgentNS.Role.User, content: "你好" }],
        tools: [],
      });

      expect(result.id).toBe("chatcmpl-123");
      expect(result.choices![0].message!.content).toBe("你好！我是助手。");
      expect(result.choices![0].message!.role).toBe(AgentNS.Role.Assistant);
    });

    it("fetch 出错时应抛出 FatalError", async () => {
      const model = createDefaultModel();

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network failure")));

      await expect(
        model.createCompletion({ messages: [], tools: [] }),
      ).rejects.toThrow("Network failure");
    });
  });

  describe("createStream (mock fetchEventSource)", () => {
    it("应成功建立流并接收数据", async () => {
      const model = createDefaultModel();

      const mockFetchEventSource = vi.mocked(fetchEventSource);
      mockFetchEventSource.mockImplementation((_url, options: any) => {
        const response = {
          ok: true,
          headers: new Map([["content-type", "text/event-stream"]]),
        };

        // 模拟 onopen
        options.onopen(response);

        // 模拟 onmessage - 发送数据块
        options.onmessage({ data: JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1677652288,
          model: "gpt-4",
          choices: [{ index: 0, delta: { content: "你好" }, finish_reason: null }],
        })});

        // 模拟完成信号
        options.onmessage({ data: "[DONE]" });

        // Promise resolve 后会在 .finally() 中调用 onFinally
        return Promise.resolve();
      });

      const onOpen = vi.fn();
      const onError = vi.fn();
      const onFinally = vi.fn();

      const stream = model.createStream({
        messages: [{ role: AgentNS.Role.User, content: "你好" }],
        tools: [],
        onOpen,
        onError,
        onFinally,
      });

      const chunks: AgentNS.StreamResponseData[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      // onFinally 在 fetchEventSource 返回的 Promise 的 .finally() 中调用
      // 由于 stream.done() 先被调用，等待队列消费完即可
      // 但 onFinally 是异步调用的，这里检查 chunks 内容
      expect(chunks).toHaveLength(1);
      expect(chunks[0].choices![0].delta!.content).toBe("你好");
    });

    it("流式响应含 tool_calls 时应正确解析", async () => {
      const model = createDefaultModel();

      const mockFetchEventSource = vi.mocked(fetchEventSource);
      mockFetchEventSource.mockImplementation((_url, options: any) => {
        options.onopen({
          ok: true,
          headers: new Map([["content-type", "text/event-stream"]]),
        });

        options.onmessage({ data: JSON.stringify({
          id: "chatcmpl-2",
          object: "chat.completion.chunk",
          created: 1677652288,
          model: "gpt-4",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "1",
                type: "function",
                function: { name: "getWeather", arguments: '{"city":"北京"}' },
              }],
            },
            finish_reason: "tool_calls",
          }],
        })});

        options.onmessage({ data: "[DONE]" });
        options.onFinally?.();
        return Promise.resolve();
      });

      const stream = model.createStream({
        messages: [{ role: AgentNS.Role.User as any, content: "北京天气如何？" }],
        tools: [],
      });

      const chunks: AgentNS.StreamResponseData[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      const toolCalls = chunks[0].choices![0].delta!.tool_calls;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls![0].function!.name).toBe("getWeather");
    });

    it("fetchEventSource 返回 rejected promise 时应触发 onError 和 onFinally", async () => {
      const model = createDefaultModel();

      const mockFetchEventSource = vi.mocked(fetchEventSource);
      const networkError = new Error("Network failure");
      mockFetchEventSource.mockRejectedValue(networkError);

      const onError = vi.fn();
      const onFinally = vi.fn();

      model.createStream({
        messages: [],
        tools: [],
        onError,
        onFinally,
      });

      // 等待微任务让 Promise 链执行完
      await new Promise((r) => setTimeout(r, 50));

      // onError 在源码的 .catch() 中被调用
      expect(onError).toHaveBeenCalledWith(networkError);
      expect(onFinally).toHaveBeenCalled();
    });
  });
});
