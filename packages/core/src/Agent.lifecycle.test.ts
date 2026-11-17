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
/**
 * 等到它**真的停下来**：闲 且 队列空。
 *
 * 只看 `state === "idle"` 不够了 —— 状态由外循环的位置决定，push 之后要等外循环头
 * 才变 `working`，所以「刚 push 完就问一次」会立刻通过。
 */
async function settled(agent: Agent): Promise<void> {
  await until(() => agent.state === "idle" && agent.inboxSize === 0);
}

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
    await settled(agent);

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
    await settled(agent);

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

describe("Agent 关输入", () => {
  it("pauseInput 之后投递进不来；resumeInput 之后又进得来", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });
    void agent.start();

    let paused = 0;
    let resumed = 0;
    agent.on("input:paused", () => (paused += 1));
    agent.on("input:resumed", () => (resumed += 1));

    agent.pauseInput();
    // 幂等：再关一次不再发事件
    agent.pauseInput();
    expect(agent.isInputPaused).toBe(true);
    expect(paused).toBe(1);
    expect(() => agent.push(user("进不来"))).toThrow(AgentError);

    agent.resumeInput();
    agent.resumeInput();
    expect(agent.isInputPaused).toBe(false);
    expect(resumed).toBe(1);
    expect(() => agent.push(user("又进来了"))).not.toThrow();

    agent.kill();
    await agent.start();
  });

  it("两道闸互不相干：关输入不动排队区，关输出不动投递", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });
    void agent.start();

    agent.push(user("一"));
    agent.push(user("二"));

    agent.pauseInput();
    // 关的是「还收不收」，不是「取不取」：排队区一件不动，输出闸也没翻
    expect(agent.inboxSize).toBe(2);
    expect(agent.isOutputPaused).toBe(false);

    agent.pauseOutput();
    agent.resumeInput();
    expect(agent.isOutputPaused).toBe(true);
    expect(() => agent.push(user("三"))).not.toThrow();

    agent.kill();
    await agent.start();
  });

  it("关门之后不许再开输入闸：投进去也没人取了", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    let paused = 0;
    let resumed = 0;
    agent.on("input:paused", () => (paused += 1));
    agent.on("input:resumed", () => (resumed += 1));

    agent.stop();
    // 关门本来就走过这道闸，于是事件也只有这一条（不多发）
    expect(agent.isInputPaused).toBe(true);
    expect(paused).toBe(1);

    agent.resumeInput();
    expect(agent.isInputPaused).toBe(true);
    expect(resumed).toBe(0);

    await agent.start();
  });
});

describe("Agent 不取件", () => {
  it("abort 掐在途、从此不收件；resumeOutput 之后接着跑", async () => {
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
    await until(() => agent.state === "working");
    await until(() => signal !== undefined);

    agent.abort();
    // 开关翻成不取件了，而 state 那一格还停在 working：两处状态各说各的（这批跑完才报闲）
    expect(agent.isOutputPaused).toBe(true);
    expect(agent.state).toBe("working");
    expect(signal!.aborted).toBe(true);

    // 被掐断的那一条定型为 aborted，不是 error
    await until(() => agent.messages.some((m) => m.status === AgentNS.MessageStatus.Aborted));

    agent.resumeOutput();
    await settled(agent);

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
    await settled(agent);

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
    await settled(agent);

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
    await settled(agent);

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
    await until(() => agent.state === "working");

    expect(() => agent.push(user("偷偷再塞一条"))).toThrow(AgentError);

    agent.kill();
    await agent.start();
  });

  it("onToolStart 拒：tool 消息正文就是那个字符串，且补 denied 事件", async () => {
    class Echo extends Tool {
      function = { name: "echo", description: "e", parameters: {} } as any;
      async exec() {
        return "不该跑";
      }
    }
    const { client } = createMockClient([
      toolCallStream([{ id: "c1", name: "echo" }]),
      textStream("好"),
    ]);
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      tools: [new Echo()],
    });

    const denieds: any[] = [];
    agent.on("denied", (payload) => denieds.push(payload));
    agent.use({ onToolStart: () => "这个工具现在不许用" });

    void agent.start();
    agent.push(user("跑一下"));
    await settled(agent);

    const toolMsg = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
    // 不再被 core 套上「工具 X 被拒绝：」的前缀 —— 那句文案本来就是写给模型读的
    expect(toolMsg.content).toBe("这个工具现在不许用");
    expect(denieds).toHaveLength(1);
    expect(denieds[0].hook).toBe("onToolStart");
    expect(denieds[0].detail.toolCall.function.name).toBe("echo");

    agent.stop();
    await agent.start();
  });

  it("门钩子抛错按「拒」处理（fail-closed），并把错报成 failed", async () => {
    class Echo extends Tool {
      function = { name: "echo", description: "e", parameters: {} } as any;
      async exec() {
        return "不该跑";
      }
    }
    const { client } = createMockClient([
      toolCallStream([{ id: "c1", name: "echo" }]),
      textStream("好"),
    ]);
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      tools: [new Echo()],
    });

    const failed: any[] = [];
    agent.on("failed", (payload) => failed.push(payload));
    agent.use({
      onToolStart: () => {
        throw new Error("护栏写崩了");
      },
    });

    void agent.start();
    agent.push(user("跑一下"));
    await settled(agent);

    const toolMsg = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
    expect(toolMsg.content).toContain("护栏写崩了");
    expect(failed.some((p) => String(p.error.message).includes("护栏写崩了"))).toBe(true);

    agent.stop();
    await agent.start();
  });

  it("非门钩子抛错当它没说话（fail-open），这一圈照跑", async () => {
    const { client } = createMockClient([textStream("依旧正常")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const failed: any[] = [];
    agent.on("failed", (payload) => failed.push(payload));
    agent.use({
      onOuterLoopStart: () => {
        throw new Error("刷工具失败了");
      },
    });

    void agent.start();
    agent.push(user("说话"));
    await settled(agent);

    expect(agent.messages.at(-1)!.content).toBe("依旧正常");
    expect(failed).toHaveLength(1);

    agent.stop();
    await agent.start();
  });

  it("inboxPending 给出还没取走的条目，且一个都不取走", () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    agent.push(user("一"));
    agent.push(); // 钥匙：没有正文

    const pending = agent.inboxPending;
    expect(pending).toHaveLength(2);
    expect(pending[0]!.content).toBe("一");
    expect(pending[1]!.content).toBeUndefined();
    // 看一眼不取走
    expect(agent.inboxSize).toBe(2);
    expect(agent.inboxPending).toHaveLength(2);

    agent.kill();
  });

  it("inboxTaken 在落地之后报，带的是被取走的那些条目（含钥匙）", () => {
    const { client } = createMockClient([textStream("好")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const taken: any[] = [];
    const addedBefore: number[] = [];
    agent.on("inboxTaken", (payload) => {
      taken.push(payload);
      // 落地必须先发生：报告这一刻，消息已经在了
      addedBefore.push(agent.messages.filter((m) => m.role === AgentNS.Role.User).length);
    });

    agent.push(user("一句"));
    agent.push(); // 钥匙

    return (async () => {
      void agent.start();
      await until(() => taken.length > 0); await settled(agent);

      expect(taken).toHaveLength(1);
      // 两条都被取走了：一条带正文、一条是钥匙
      expect(taken[0].entries).toHaveLength(2);
      expect(taken[0].entries[1].content).toBeUndefined();
      // 报之前那条 user 消息已经落地了
      expect(addedBefore[0]).toBe(1);
      // 队列已空
      expect(agent.inboxPending).toHaveLength(0);

      agent.stop();
      await agent.start();
    })();
  });
});
