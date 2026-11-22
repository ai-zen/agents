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

function chunk(
  delta: any,
  finish_reason: any = null,
  extra: Record<string, unknown> = {},
): AnyChunk {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason }],
    ...extra,
  };
}

/** 一段普通回答的流 */
function textStream(text: string): AnyChunk[] {
  return [chunk({ content: text }), chunk({}, "stop")];
}

/**
 * 带工具调用的流。
 *
 * 每个调用单独一片 —— 这是常见的真实形状（`applyChunk` 也认「一片带多个」并靠 `index` 归位，
 * 那种形状在 `applyChunk.test.ts` 里钉）。
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

/**
 * 等到它**真的停下来**：闲 且 队列空。
 *
 * 只看 `state === "idle"` 不够 —— 状态由外循环的位置决定，push 之后要等外循环头
 * 才变 `working`，所以「刚 push 完就问一次」会立刻通过。
 */
async function settled(agent: Agent): Promise<void> {
  await until(() => agent.state === "idle" && agent.inboxSize === 0);
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

/** 接一次 push，把它抛的 `AgentError` 的码交出来（没抛就是 `undefined`） */
function codeOf(run: () => void): string | undefined {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentError);
    return (error as AgentError).code;
  }
  return undefined;
}

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
    expect(messages.map((m) => m.role)).toEqual([AgentNS.Role.User, AgentNS.Role.Assistant]);
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

  it("push 分得清「输入闸暂时关着」与「agent 已经终结」", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });
    void agent.start();

    // 暂时不收：等一等还能投
    agent.pauseInput();
    expect(codeOf(() => agent.push(user("一")))).toBe("input_paused");

    agent.resumeInput();
    expect(codeOf(() => agent.push(user("二")))).toBeUndefined();

    // 已经终结：再等也不会有人来取
    agent.kill();
    expect(codeOf(() => agent.push(user("三")))).toBe("closed");

    await agent.start();
  });
});

describe("Agent 流末的用量与结束原因", () => {
  /**
   * 这两格**不是增量**：`usage` 与 `finish_reason` 是那次响应的外层字段（`AgentNS.Delta`
   * 里没有它们），由流处理这一侧钉到消息上 —— `applyChunk` 只处理那一片增量本身。
   */
  it("`usage` 与 `finish_reason` 钉在那条 assistant 消息上", async () => {
    const { client } = createMockClient([
      [
        chunk({ content: "好" }),
        chunk({}, "stop", { usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }),
      ],
    ]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });
    void agent.start();

    agent.push(user("问一句"));
    await settled(agent);

    const assistant = agent.messages.at(-1)!;
    expect(assistant.content).toBe("好");
    expect(assistant.finish_reason).toBe(AgentNS.FinishReason.Stop);
    expect(assistant.usage).toEqual({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });

    agent.stop();
    await agent.start();
  });

  it("只有 usage、没有 choices 的片（部分端点如此）照样收下用量", async () => {
    const { client } = createMockClient([
      [
        chunk({ content: "好" }),
        {
          id: "chunk-2",
          object: "chat.completion.chunk",
          created: 0,
          model: "mock",
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        },
      ],
    ]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });
    void agent.start();

    agent.push(user("问一句"));
    await settled(agent);

    // 没有 choices 就没有增量、也没有结束原因，但用量照收
    const assistant = agent.messages.at(-1)!;
    expect(assistant.content).toBe("好");
    expect(assistant.finish_reason).toBeUndefined();
    expect(assistant.usage?.completion_tokens).toBe(2);

    agent.stop();
    await agent.start();
  });
});

describe("Agent 死亡事件", () => {
  it("没 start() 过也不吞事件：stop() 发一条 stopped，kill() 不再补一条", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const seen: string[] = [];
    agent.on("stopped", () => seen.push("stopped"));
    agent.on("killed", () => seen.push("killed"));

    agent.stop();
    agent.stop();
    expect(seen).toEqual(["stopped"]);

    // kill() 之后不再补发 stopped：一个 agent 只有一条「死」
    agent.kill();
    agent.kill();
    expect(seen).toEqual(["stopped"]);

    // 之后才 start()：外循环立刻跑到出口，但不会再报第二条
    await agent.start();
    expect(seen).toEqual(["stopped"]);
  });

  it("没 start() 过就 kill()：只发一条 killed", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const seen: string[] = [];
    agent.on("stopped", () => seen.push("stopped"));
    agent.on("killed", () => seen.push("killed"));

    agent.kill();
    expect(seen).toEqual(["killed"]);

    await agent.start();
    agent.stop();
    expect(seen).toEqual(["killed"]);
  });

  it("先关门、后 start()：存量跑完后 state 仍然是 idle（不会卡在 working 上）", async () => {
    const { client } = createMockClient([textStream("还是答了")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const seen: string[] = [];
    agent.on("stopped", () => seen.push("stopped"));

    agent.push(user("这一条还在队里"));
    agent.stop();
    // 没起来过：只能由本体当场说
    expect(seen).toEqual(["stopped"]);

    // 起来之后存量照跑（关门是「以后不再收」，不是「手上这些不跑」）
    await agent.start();

    expect(agent.messages.at(-1)!.content).toBe("还是答了");
    expect(agent.state).toBe("idle");
    expect(seen).toEqual(["stopped"]);
  });

  it("死在干活的中途：`killed` 回调里 state 已经是 idle，之后不再有 state:idle", async () => {
    const create = vi.fn(async (_body: any, options: any) => makeHangingStream(options?.signal));
    const agent = new Agent({
      client: { chat: { completions: { create } } } as any,
      model: "m",
      newMessageId: makeIds(),
    });

    let stateAtDeath: string | undefined;
    let idleAfterDeath = 0;
    let dead = false;
    agent.on("killed", () => {
      stateAtDeath = agent.state;
      dead = true;
    });
    agent.on("state:idle", () => {
      if (dead) idleAfterDeath += 1;
    });

    const death = agent.start();
    agent.push(user("慢慢来"));
    await until(() => agent.state === "working");

    agent.kill();
    await death;

    // 订阅方在「死」那一刻读到的已经是死后那一格（不是 working）
    expect(stateAtDeath).toBe("idle");
    // 死后的 agent 不再冒状态事件
    expect(idleAfterDeath).toBe(0);
    expect(agent.state).toBe("idle");
  });

  it("关门放完血才死：`stopped` 那一刻同样是 idle，之后不再有 state:idle", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const create = vi.fn(async () => {
      await gate;
      return makeStream(textStream("答完了"));
    });
    const agent = new Agent({
      client: { chat: { completions: { create } } } as any,
      model: "m",
      newMessageId: makeIds(),
    });

    let stateAtDeath: string | undefined;
    let idleAfterDeath = 0;
    let dead = false;
    agent.on("stopped", () => {
      stateAtDeath = agent.state;
      dead = true;
    });
    agent.on("state:idle", () => {
      if (dead) idleAfterDeath += 1;
    });

    const death = agent.start();
    agent.push(user("问一句"));
    await until(() => agent.state === "working");

    agent.stop();
    // 关门了但存量还在跑：此刻还没死，所以还没报 stopped
    expect(stateAtDeath).toBeUndefined();
    release();
    await death;

    expect(stateAtDeath).toBe("idle");
    expect(idleAfterDeath).toBe(0);
    // 存量真的跑完了才死
    expect(agent.messages.at(-1)!.content).toBe("答完了");
  });
});

describe("Agent 中断", () => {
  it("abort 有自己的事实：闸已经关着也照发（拿闸猜不出「谁按的停」）", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });
    void agent.start();

    const seen: string[] = [];
    agent.on("aborted", () => seen.push("aborted"));
    agent.on("output:paused", () => seen.push("output:paused"));

    agent.pauseOutput();
    agent.abort();
    agent.abort();

    // 闸那一下只有第一次翻得动（后面一声不响），但「按了停」发生几次就是几条事实
    expect(seen).toEqual(["output:paused", "aborted", "aborted"]);

    agent.kill();
    await agent.start();
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

describe("Agent 工具段里按中断", () => {
  it("工具跑到一半 abort：这一批到此为止，不再向模型要下一圈", async () => {
    let toolStarted = false;
    class Hanging extends Tool {
      function = { name: "hang", description: "h", parameters: {} } as any;
      async exec(ctx: ToolCallContext) {
        toolStarted = true;
        const signal = ctx.signal;
        // 上下文的 `signal` 是可选的：缺了它就只能干等，宁可当场炸也不要挂成超时
        if (signal === undefined) throw new Error("工具调用上下文里没有 signal");
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return "不该被用到";
      }
    }

    const { client, create } = createMockClient([
      toolCallStream([{ id: "c1", name: "hang" }]),
      textStream("接着把话说完"),
    ]);
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      tools: [new Hanging()],
    });
    void agent.start();

    agent.push(user("跑个会挂住的工具"));
    await until(() => toolStarted);
    agent.abort();

    // 等这一批真的收尾（工具消息定型、队列空、回到闲）
    await settled(agent);
    expect(create).toHaveBeenCalledTimes(1);
    expect(agent.messages.some((m) => m.content === "接着把话说完")).toBe(false);
    // 那条 tool 消息定型为 aborted，不是「跑完了」
    expect(agent.messages.find((m) => m.role === AgentNS.Role.Tool)!.status).toBe(
      AgentNS.MessageStatus.Aborted,
    );

    agent.kill();
    await agent.start();
  });
});

describe("Agent send：投递并等到空闲，但不关门", () => {
  it("跑到空闲就返回，**不关门** —— agent 还站着、还能接着跑下一趟", async () => {
    const { client, create } = createMockClient([textStream("一次性结果")]);
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      lifetime: "one-shot",
      messages: [Message.System("sys"), Message.User("干件事", { kind: "agent", label: "测试" })],
    });

    const messages = await agent.send();

    expect(create).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)!.content).toBe("一次性结果");
    // 不关门：输入闸还在、循环还在等下一件事（与 `runOnce` 那一步差的就是这个）
    expect(agent.isInputPaused).toBe(false);
    expect(agent.started).toBe(true);
    expect(agent.state).toBe("idle");

    agent.kill();
    await agent.start();
  });

  it("「等闲」不是一步通过：这一批跑完之前不返回", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const create = vi.fn(async () => {
      await gate;
      return makeStream(textStream("迟到的结果"));
    });
    const agent = new Agent({
      client: { chat: { completions: { create } } } as any,
      model: "m",
      newMessageId: makeIds(),
      lifetime: "one-shot",
      messages: [Message.User("干件事", { kind: "user" })],
    });

    let returned = false;
    const done = agent.send().then((messages) => {
      returned = true;
      return messages;
    });

    await until(() => agent.state === "working");
    // 这一批还在飞：不能假装「已经等到了」
    expect(returned).toBe(false);

    release();
    const messages = await done;
    expect(messages.at(-1)!.content).toBe("迟到的结果");

    agent.kill();
    await agent.start();
  });

  it("没有燃料就抛裸 Error（与 runOnce 同一个判据）", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds(), lifetime: "one-shot" });

    await expect(agent.send()).rejects.toThrow(/messages 是空的/);
  });

  it("常驻 agent 不许 send：常驻会话没有「等到跑完」这回事", async () => {
    const { client } = createMockClient([]);
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      messages: [Message.User("x", { kind: "user" })],
    });

    await expect(agent.send()).rejects.toThrow(/常驻会话没有/);
  });
});

describe("Agent runOnce", () => {
  it("「等闲」不是一步通过：这一批跑完之前不会关门", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const create = vi.fn(async () => {
      await gate;
      return makeStream(textStream("一次性结果"));
    });
    const agent = new Agent({
      client: { chat: { completions: { create } } } as any,
      model: "m",
      newMessageId: makeIds(),
      lifetime: "one-shot",
      messages: [Message.System("sys"), Message.User("干件事", { kind: "agent", label: "测试" })],
    });

    const done = agent.runOnce();

    // 这一批真的开始了（请求在飞，状态已经是 working）……
    await until(() => agent.state === "working");
    await until(() => create.mock.calls.length === 1);
    // ……而 `runOnce` 还在等它跑完：门没关（还在等闲，不是一 push 完就一步通过）
    expect(agent.isInputPaused).toBe(false);

    release();
    const messages = await done;

    expect(messages.at(-1)!.content).toBe("一次性结果");
    // 跑完才关门
    expect(agent.isInputPaused).toBe(true);
  });

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
    // core 不给它加前缀：正文就是钩子返回的那个字符串（那句话是写给模型读的）
    expect(toolMsg.content).toBe("这个工具现在不许用");
    expect(denieds).toHaveLength(1);
    expect(denieds[0].hook).toBe("onToolStart");
    expect(denieds[0].detail.toolCall.function.name).toBe("echo");

    agent.stop();
    await agent.start();
  });

  it("未知工具走 onUnknownTool，**不**走 onToolStart", async () => {
    class Echo extends Tool {
      function = { name: "echo", description: "e", parameters: {} } as any;
      async exec() {
        return "不该跑";
      }
    }
    const { client } = createMockClient([
      toolCallStream([{ id: "c1", name: "nope" }]),
      textStream("好"),
    ]);
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      tools: [new Echo()],
    });

    const seen: string[] = [];
    const ctxs: any[] = [];
    agent.use({
      onToolStart: () => {
        seen.push("onToolStart");
      },
      onUnknownTool: (ctx) => {
        seen.push("onUnknownTool");
        ctxs.push(ctx);
      },
    });

    void agent.start();
    agent.push(user("跑一下"));
    await settled(agent);

    // 两个钩子正交：工具不存在时只问「怎么回应它」，不问「要不要开始跑」
    expect(seen).toEqual(["onUnknownTool"]);
    expect(ctxs[0].toolCall.function.name).toBe("nope");
    // 可用工具给全了 —— 插件靠它判「某个工具在不在」，不必自己去别处捞
    expect(ctxs[0].availableTools.map((t: any) => t.function.name)).toEqual(["echo"]);

    agent.stop();
    await agent.start();
  });

  it("已知工具走 onToolStart，**不**走 onUnknownTool", async () => {
    class Echo extends Tool {
      function = { name: "echo", description: "e", parameters: {} } as any;
      async exec() {
        return "echo 的结果";
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

    const seen: string[] = [];
    agent.use({
      onToolStart: () => {
        seen.push("onToolStart");
      },
      onUnknownTool: () => {
        seen.push("onUnknownTool");
      },
    });

    void agent.start();
    agent.push(user("跑一下"));
    await settled(agent);

    expect(seen).toEqual(["onToolStart"]);
    const toolMsg = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
    expect(toolMsg.content).toBe("echo 的结果");

    agent.stop();
    await agent.start();
  });

  it("onUnknownTool 返回 string：tool 消息正文就是它，denied 事件报的是 onUnknownTool", async () => {
    const { client } = createMockClient([
      toolCallStream([{ id: "c1", name: "nope" }]),
      textStream("好"),
    ]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const denieds: any[] = [];
    agent.on("denied", (payload) => denieds.push(payload));
    agent.use({ onUnknownTool: () => "没有这个工具，试试 call_mcp_tool" });

    void agent.start();
    agent.push(user("跑一下"));
    await settled(agent);

    const toolMsg = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
    expect(toolMsg.content).toBe("没有这个工具，试试 call_mcp_tool");
    expect(denieds).toHaveLength(1);
    // 如实报是哪一道门拒的（下游按这个字段统计，报错钩子名会把人引偏）
    expect(denieds[0].hook).toBe("onUnknownTool");
    expect(denieds[0].detail.toolCall.function.name).toBe("nope");

    agent.stop();
    await agent.start();
  });

  it("onUnknownTool 返回 undefined：走默认「未知工具」文案，且不发 denied", async () => {
    const { client } = createMockClient([
      toolCallStream([{ id: "c1", name: "nope" }]),
      textStream("好"),
    ]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const denieds: any[] = [];
    agent.on("denied", (payload) => denieds.push(payload));
    agent.use({ onUnknownTool: () => undefined });

    void agent.start();
    agent.push(user("跑一下"));
    await settled(agent);

    const toolMsg = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
    expect(toolMsg.content).toBe("未知工具: nope，没有找到对应的工具实现。");
    expect(denieds).toHaveLength(0);

    agent.stop();
    await agent.start();
  });

  it("未知工具 + 参数也写坏了：回给模型的是「未知工具」，**不是**「参数解析错误」", async () => {
    const { client } = createMockClient([
      toolCallStream([{ id: "c1", name: "nope", args: "{这不是 JSON" }]),
      textStream("好"),
    ]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    void agent.start();
    agent.push(user("跑一下"));
    await settled(agent);

    const toolMsg = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
    // 工具**不存在优先**：让它去修参数格式 = 让它修一个根本不存在的工具的参数，永远修不好
    expect(toolMsg.content).toBe("未知工具: nope，没有找到对应的工具实现。");
    expect(toolMsg.content).not.toContain("参数解析错误");

    agent.stop();
    await agent.start();
  });

  it("onToolEnd 只对**存在的**工具发：未知工具不发（成对的钩子要成对）", async () => {
    class Echo extends Tool {
      function = { name: "echo", description: "e", parameters: {} } as any;
      async exec() {
        return "echo 的结果";
      }
    }
    // 两轮：先调一个不存在的工具，再调一个存在的 —— 同一条路上两边的表现都钉住
    const { client } = createMockClient([
      toolCallStream([{ id: "c1", name: "nope" }]),
      toolCallStream([{ id: "c2", name: "echo" }]),
      textStream("好"),
    ]);
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      tools: [new Echo()],
    });

    const starts: string[] = [];
    const ends: string[] = [];
    agent.use({
      onToolStart: ({ toolCall }) => {
        starts.push(toolCall.tool_call.function?.name ?? "?");
      },
      onToolEnd: ({ toolCall }) => {
        ends.push(toolCall.tool_call.function?.name ?? "?");
      },
    });

    void agent.start();
    agent.push(user("跑两下"));
    await settled(agent);

    // 未知工具那一次：`onToolStart` 不该来，`onToolEnd` 也不该来（没有 start 的 end
    // 会让计时 / 配对计数 / 工具卡片这类插件收尾一件没开始的事，而且 `ctx.tool` 还是 undefined）
    expect(starts).toEqual(["echo"]);
    expect(ends).toEqual(["echo"]);

    agent.stop();
    await agent.start();
  });

  it("toolStarted 只对**存在的**工具发：未知工具不发（与 onToolStart 同一道门）", async () => {
    class Echo extends Tool {
      function = { name: "echo", description: "e", parameters: {} } as any;
      async exec() {
        return "echo 的结果";
      }
    }
    const { client } = createMockClient([
      toolCallStream([{ id: "c1", name: "nope" }]),
      toolCallStream([{ id: "c2", name: "echo" }]),
      textStream("好"),
    ]);
    const agent = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      tools: [new Echo()],
    });

    const started: string[] = [];
    agent.on("toolStarted", (payload) => started.push(payload.toolCall.function?.name ?? "?"));

    void agent.start();
    agent.push(user("跑两下"));
    await settled(agent);

    // 未知工具从来没跑过：发一条 start 只会让拿它建「工具调用卡片」的订阅方凭空多一张
    expect(started).toEqual(["echo"]);

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

  it("非门钩子返回 string 不短路：后面插件的同名钩子照样跑", async () => {
    const { client } = createMockClient([textStream("正常")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const calls: string[] = [];
    // `onOuterLoopStart` 不是门：它返回的那个字符串没人读，不该把后面的插件跳掉
    agent.use({ onOuterLoopStart: () => "这句话没人读" });
    agent.use({
      onOuterLoopStart: () => {
        calls.push("second");
      },
    });

    void agent.start();
    agent.push(user("说话"));
    await settled(agent);

    expect(calls).toEqual(["second"]);
    expect(agent.messages.at(-1)!.content).toBe("正常");

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

  it("inboxAdded：投进来的每一条都报一次，带的是那一条（含钥匙）", () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const added: any[] = [];
    agent.on("inboxAdded", (payload) => added.push(payload));

    agent.push(user("一句"));
    agent.push(); // 钥匙：没有正文

    expect(added).toHaveLength(2);
    // 载荷就是队列里那一条：`createdAt` / `source` / 正文都在
    expect(added[0].entry.content).toBe("一句");
    expect(added[0].entry.source).toEqual({ kind: "user" });
    expect(typeof added[0].entry.createdAt).toBe("string");
    expect(added[1].entry.content).toBeUndefined();
    // 投进来还没有人取走：队列里就是这两条
    expect(agent.inboxPending).toHaveLength(2);

    agent.kill();
  });

  it("inboxCleared：清空时报一次，带被丢掉的那些；本来就空就什么都不报", () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const cleared: any[] = [];
    agent.on("inboxCleared", (payload) => cleared.push(payload));

    // 空队列清一次不算变化
    expect(agent.clearInbox()).toEqual([]);
    expect(cleared).toHaveLength(0);

    agent.push(user("一"));
    agent.push(user("二"));
    const dropped = agent.clearInbox();

    expect(dropped).toHaveLength(2);
    expect(cleared).toHaveLength(1);
    // 带的就是丢掉的那两条，原顺序
    expect(cleared[0].entries).toHaveLength(2);
    expect(cleared[0].entries[0].content).toBe("一");
    expect(cleared[0].entries[1].content).toBe("二");
    expect(agent.inboxPending).toHaveLength(0);

    agent.kill();
  });

  it("inboxTaken 在落地之后报，带的是被取走的那些条目（含钥匙）", async () => {
    const { client } = createMockClient([textStream("好")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const taken: any[] = [];
    const addedBefore: number[] = [];
    const order: string[] = [];
    agent.on("messageAdded", (payload) => {
      const message = (payload as { message?: AgentNS.Message }).message;
      if (message?.role === AgentNS.Role.User) order.push("messageAdded");
    });
    agent.on("inboxTaken", (payload) => {
      order.push("inboxTaken");
      taken.push(payload);
      // 落地必须先发生：报这一刻，消息已经在了
      addedBefore.push(agent.messages.filter((m) => m.role === AgentNS.Role.User).length);
    });

    agent.push(user("一句"));
    agent.push(); // 钥匙

    void agent.start();
    await until(() => taken.length > 0);
    await settled(agent);

    expect(taken).toHaveLength(1);
    // 两条都被取走了：一条带正文、一条是钥匙
    expect(taken[0].entries).toHaveLength(2);
    expect(taken[0].entries[1].content).toBeUndefined();
    // 报之前那条 user 消息已经落地了，事件次序也是落地在前
    expect(addedBefore[0]).toBe(1);
    expect(order).toEqual(["messageAdded", "inboxTaken"]);
    // 队列已空
    expect(agent.inboxPending).toHaveLength(0);

    agent.stop();
    await agent.start();
  });
});

// ---------------------------------------------------------------------------
// 恢复：把旧的条目原样放回队列（PRD 4.12）
// ---------------------------------------------------------------------------

describe("Agent 恢复：把旧条目原样放回", () => {
  /**
   * 一条「上一次存下来」的条目：`createdAt` 是很久以前那一刻，来源不是用户本人。
   *
   * 这两点是有意的 —— 它们正是「恢复 ≠ 投递」会被看出来的地方：投递会盖新的时间，而
   * `{kind:"user"}` 这个来源也不加注释行。
   */
  const stored: AgentNS.InboxEntryWithContent = {
    messageId: "早先那条",
    createdAt: "2026-01-02T03:04:05.000Z",
    priority: "high",
    source: { kind: "agent", label: "补测试" },
    content: [{ type: "text", text: "把测试补上" }],
  };

  it("原样放回：四个字段一个不重算，且不发 inboxAdded", () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const added: any[] = [];
    agent.on("inboxAdded", (payload) => added.push(payload));

    agent.restore([stored]);

    // 队列里就是存下来的那一条：id / 时间 / 来源 / 正文一格都没被换掉
    expect(agent.inboxPending).toEqual([stored]);
    // 恢复不是新变化：库里那一行已经在，再发 `inboxAdded` 就会插出第二行
    expect(added).toHaveLength(0);

    agent.kill();
  });

  it("放回之后被取走：落地用的是存下来的 messageId 与 createdAt", async () => {
    const { client } = createMockClient([textStream("补好了")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    void agent.start();
    agent.restore([stored]);
    await settled(agent);

    const landed = agent.messages[0]!;
    // id 用条目自带的那一个（客户端先画的就是它）
    expect(landed.id).toBe("早先那条");
    // 来源注释里那一刻时间是条目自己的 createdAt —— 不是「重启那一刻」（段序也没变：注释在前）
    const sections = landed.content as AgentNS.MessageContentSection[];
    expect(sections[0]).toMatchObject({ type: "text" });
    expect((sections[0] as { text: string }).text).toContain("2026-01-02T03:04:05.000Z");
    expect(sections[1]).toEqual({ type: "text", text: "把测试补上" });

    agent.stop();
    await agent.start();
  });

  it("顺序就是存下来的那个顺序（一条都不挪）", () => {
    const { client } = createMockClient([]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    agent.restore([
      { ...stored, messageId: "第一条", content: "第一句" },
      { ...stored, messageId: "第二条", content: "第二句" },
      // 钥匙也在放回之列：它同样是一条「当时排着、没人取走」的条目
      { createdAt: "2026-01-02T03:04:06.000Z", priority: "low", content: undefined },
    ]);

    expect(agent.inboxPending.map((entry) => entry.content)).toEqual([
      "第一句",
      "第二句",
      undefined,
    ]);

    agent.kill();
  });

  it("该拒的三种：一次性 agent / 已经关门 / 形状不全（一条不合格就一条都不放）", () => {
    const { client } = createMockClient([]);
    const oneShot = new Agent({
      client,
      model: "m",
      newMessageId: makeIds(),
      lifetime: "one-shot",
    });
    // 一次性 agent 的寿命在调用栈里：没有「重启之后接着等」这回事
    expect(() => oneShot.restore([stored])).toThrow(Error);
    expect(() => oneShot.restore([stored])).not.toThrow(AgentError);

    const closed = new Agent({ client, model: "m", newMessageId: makeIds() });
    closed.stop();
    expect(codeOf(() => closed.restore([stored]))).toBe("closed");

    const healthy = new Agent({ client, model: "m", newMessageId: makeIds() });
    // 半截条目：宁可当场炸，也不要把半截数据装进队列
    const broken = [
      { createdAt: "", priority: "low" as const, content: undefined },
      { createdAt: "2026-01-02T03:04:05.000Z", priority: "high" as const, content: "没有来源" },
    ] as unknown as AgentNS.InboxEntry[];
    expect(() => healthy.restore([broken[0]!])).toThrow(Error);
    expect(() => healthy.restore([broken[1]!])).toThrow(Error);
    // 好的坏的混在一起时一条都不放：队列不装半截数据，也不装「合格的另一半」
    expect(() => healthy.restore([stored, broken[0]!])).toThrow(Error);
    expect(healthy.inboxPending).toHaveLength(0);

    healthy.kill();
    void oneShot.start();
  });
});
