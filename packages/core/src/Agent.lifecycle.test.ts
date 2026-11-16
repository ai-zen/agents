import { describe, it, expect, vi } from "vitest";
import { Agent } from "./Agent.js";
import { AgentError } from "./AgentError.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";
import { Tool } from "./Tool.js";
import type { ToolCallContext } from "./ToolCallContext.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// Mock OpenAI client
// ---------------------------------------------------------------------------

type AnyChunk = any;

function chunk(delta: any, finish_reason: any = null): AnyChunk {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason }],
  };
}

/** 一段普通回答的流 */
function textStream(text: string): AnyChunk[] {
  return [chunk({ content: text }), chunk({}, "stop")];
}

/**
 * 带工具调用的流。
 *
 * 每个调用单独一片 —— 这是厂商的真实形状（`applyChunk` 一次只处理 `delta.tool_calls[0]`，
 * 靠 `index` 归位）。
 */
function toolCallStream(calls: Array<{ id: string; name: string; args?: string }>): AnyChunk[] {
  return [
    ...calls.map((call, index) =>
      chunk({
        tool_calls: [
          {
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.args ?? "{}" },
          },
        ],
      }),
    ),
    chunk({}, "tool_calls"),
  ];
}

function makeStream(chunks: AnyChunk[]): AsyncIterable<ChatCompletionChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c as ChatCompletionChunk;
    },
  };
}

/** 挂起流：signal 一响就结束（已 aborted 则立即结束） */
function makeHangingStream(signal?: AbortSignal): AsyncIterable<AnyChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}

/** 每一轮返回一份固定的 chunk 数组 */
function createMockClient(rounds: AnyChunk[][]) {
  let callCount = 0;
  const create = vi.fn(async (_body: any, _options: any) => {
    const data = rounds[callCount] ?? [];
    callCount++;
    return makeStream(data);
  });
  return { client: { chat: { completions: { create } } } as any, create };
}

/** 轮询等待条件成立（最多等 1s） */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("until: 超时");
    await new Promise((r) => setTimeout(r, 1));
  }
}

function makeIds() {
  let n = 0;
  return () => `id-${++n}`;
}

const user = (content: string): AgentNS.InboxInput => ({
  content,
  source: { kind: "user" },
  priority: "low",
});

// ---------------------------------------------------------------------------

describe("Agent 死活", () => {
  it("start() 的 promise 到死才 resolve", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    let resolved = false;
    const death = agent.start().then(() => (resolved = true));

    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);

    agent.stop();
    await death;
    expect(resolved).toBe(true);
    expect(agent.state).toBe("idle");
  });

  it("重复 start / stop / kill 是空动作", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const a = agent.start();
    const b = agent.start();
    expect(a).toBe(b);

    agent.stop();
    agent.stop();
    agent.kill();
    await a;
  });
});

describe("Agent 投递", () => {
  it("push 落一条 user 消息；跑完之后自己回声（不靠等 promise）", async () => {
    const { client } = createMockClient([textStream("你好")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });
    void agent.start();

    agent.push(user("在吗"));
    await until(() => agent.state === "idle");

    const messages = agent.messages;
    expect(messages.map((m) => m.role)).toEqual([
      AgentNS.Role.User,
      AgentNS.Role.Assistant,
    ]);
    expect(messages[0]!.source).toEqual({ kind: "user" });
    expect(messages[1]!.content).toBe("你好");
    expect(agent.state).toBe("idle");

    agent.stop();
    await agent.start();
  });

  it("钥匙不落地，只是把这一圈叫起来", async () => {
    const { client, create } = createMockClient([textStream("接着答")]);
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      messages: [Message.System("sys"), Message.User("已经装好的问题", { kind: "user" })],
    });
    void agent.start();

    agent.push(); // 拧钥匙：不给正文
    await until(() => agent.state === "idle");

    expect(create).toHaveBeenCalledTimes(1);
    expect(agent.messages.map((m) => m.role)).toEqual([
      AgentNS.Role.System,
      AgentNS.Role.User,
      AgentNS.Role.Assistant,
    ]);
    // 没有多出第二条 user 消息
    expect(agent.messages.filter((m) => m.role === AgentNS.Role.User)).toHaveLength(1);

    agent.stop();
    await agent.start();
  });

  it("关门之后 push 抛 closed", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    agent.stop();
    await agent.start();

    expect(() => agent.push(user("晚了"))).toThrow(AgentError);
    try {
      agent.push(user("晚了"));
    } catch (error) {
      expect((error as AgentError).code).toBe("closed");
    }
  });

  it("kill 作废存量", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    agent.push(user("一"));
    agent.push(user("二"));
    expect(agent.inboxSize).toBe(2);

    agent.kill();
    expect(agent.inboxSize).toBe(0);

    await agent.start();
    expect(agent.messages).toHaveLength(0);
  });
});

describe("Agent 暂停", () => {
  it("abort 掐在途、state 变暂停；resume 之后接着跑", async () => {
    let signal: AbortSignal | undefined;
    const create = vi.fn(async (_body: any, options: any) => {
      signal = options?.signal;
      return makeHangingStream(options?.signal);
    });
    const agent = new Agent({
      client: { chat: { completions: { create } } } as any,
      model: "m",
      newMessageId: makeIds(),
    });
    void agent.start();

    agent.push(user("慢慢来"));
    await until(() => agent.state === "busy");
    await until(() => signal !== undefined);

    agent.abort();
    expect(agent.state).toBe("paused");
    expect(signal!.aborted).toBe(true);

    // 被掐断的那一条定型为 aborted，不是 error
    await until(() => agent.messages.some((m) => m.status === AgentNS.MessageStatus.Aborted));

    agent.resume();
    await until(() => agent.state === "idle");

    agent.stop();
    await agent.start();
  });
});

describe("Agent 错误", () => {
  it("请求失败：message.error 与 failed 事件是同一个实例，content 不被污染", async () => {
    const create = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const agent = new Agent({
      client: { chat: { completions: { create } } } as any,
      model: "m",
      newMessageId: makeIds(),
    });

    const failed: Array<{ error: AgentError | Error; message?: AgentNS.Message }> = [];
    agent.on("failed", (payload) => failed.push(payload));

    void agent.start();
    agent.push(user("在吗"));
    // 出错之后 state 会回到 idle：出错不终结 agent
    await until(() => agent.state === "idle");

    const assistant = agent.messages.at(-1)!;
    expect(assistant.status).toBe(AgentNS.MessageStatus.Error);
    expect(assistant.error).toBeInstanceOf(AgentError);
    expect(assistant.error!.code).toBe("request-failed");
    // 错误文本绝不进 content
    expect(assistant.content).toBeUndefined();

    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toBe(assistant.error);

    agent.stop();
    await agent.start();
  });
});

describe("Agent 修复", () => {
  it("进圈开头把 aborted 的半截消息真删，并补 messageRemoved", async () => {
    const { client } = createMockClient([textStream("这次正常")]);
    const half: AgentNS.Message = new Message({
      id: "half",
      role: AgentNS.Role.Assistant,
      content: "说到一半",
      status: AgentNS.MessageStatus.Aborted,
    });
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      messages: [Message.User("问题", { kind: "user" }), half],
    });

    const removed: AgentNS.Message[] = [];
    agent.on("messageRemoved", ({ message }) => removed.push(message));

    void agent.start();
    agent.push(user("接着问"));
    await until(() => agent.state === "idle");

    expect(agent.messages.some((m) => m.id === "half")).toBe(false);
    expect(removed.map((m) => m.id)).toEqual(["half"]);

    agent.stop();
    await agent.start();
  });
});

describe("Agent 工具", () => {
  it("按调用顺序落地 tool 消息，即使完成顺序相反", async () => {
    class Slow extends Tool {
      function = { name: "slow", description: "s", parameters: {} } as any;
      async exec(_ctx: ToolCallContext) {
        await new Promise((r) => setTimeout(r, 20));
        return "slow-done";
      }
    }
    class Fast extends Tool {
      function = { name: "fast", description: "f", parameters: {} } as any;
      async exec(_ctx: ToolCallContext) {
        return "fast-done";
      }
    }

    const { client } = createMockClient([
      toolCallStream([
        { id: "c1", name: "slow" },
        { id: "c2", name: "fast" },
      ]),
      textStream("都跑完了"),
    ]);

    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      tools: [new Slow(), new Fast()],
    });
    void agent.start();

    agent.push(user("跑两个工具"));
    await until(() => agent.state === "idle");

    const toolMessages = agent.messages.filter((m) => m.role === AgentNS.Role.Tool);
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    expect(toolMessages.map((m) => m.content)).toEqual(["slow-done", "fast-done"]);
    expect(agent.messages.at(-1)!.content).toBe("都跑完了");

    agent.stop();
    await agent.start();
  });
});

describe("Agent runOnce", () => {
  it("跑一次就死，把消息交回来", async () => {
    const { client, create } = createMockClient([textStream("一次性结果")]);
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      lifetime: "one-shot",
      messages: [Message.System("sys"), Message.User("干件事", { kind: "agent", label: "测试" })],
    });

    const messages = await agent.runOnce();

    expect(create).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)!.content).toBe("一次性结果");
    // 死了就死透
    expect(() => agent.push(user("还想再来一次"))).toThrow(AgentError);
  });

  it("没有燃料就抛裸 Error", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds(), lifetime: "one-shot" });

    await expect(agent.runOnce()).rejects.toThrow(/messages 是空的/);
  });

  it("已经 start() 过就抛裸 Error", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      lifetime: "one-shot",
      messages: [Message.User("x", { kind: "user" })],
    });
    void agent.start();

    await expect(agent.runOnce()).rejects.toThrow(/只能用在还没 start/);

    agent.kill();
    await agent.start();
  });

  it("常驻 agent 不许 runOnce", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      messages: [Message.User("x", { kind: "user" })],
    });

    await expect(agent.runOnce()).rejects.toThrow(/lifetime/);
  });

  it("一次性 agent 开跑即关收：第二次投递抛 closed", async () => {
    let signal: AbortSignal | undefined;
    const create = vi.fn(async (_body: any, options: any) => {
      signal = options?.signal;
      return makeHangingStream(options?.signal);
    });
    const agent = new Agent({
      client: { chat: { completions: { create } } } as any,
      model: "m",
      newMessageId: makeIds(),
      lifetime: "one-shot",
      messages: [Message.User("干件事", { kind: "user" })],
    });

    void agent.start();
    agent.push(); // 这一次是发起它的那一次
    await until(() => agent.state === "busy");

    expect(() => agent.push(user("偷偷再塞一条"))).toThrow(AgentError);

    agent.kill();
    await agent.start();
  });
});
