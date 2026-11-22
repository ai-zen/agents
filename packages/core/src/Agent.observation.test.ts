import { describe, it, expect, vi } from "vitest";
import { Agent, type AgentEvents, type DeniedEvent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import { CallbackTool } from "./Tools/CallbackTool.js";
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

/** 一条普通回答的流：两片，于是 `delta` 也正好发两次 */
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

/**
 * 掐得住的流：第一片照常给出，之后停在闸上，`release()` 一响才把剩下的片吐完。
 *
 * 中断与杀死这两个用例都要「正收着流的时候动手」，所以需要一个停得住的流 —— 它只停在那儿，
 * 不参与别处任何判断。
 */
function makeGatedStream(chunks: AnyChunk[]): {
  stream: AsyncIterable<ChatCompletionChunk>;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream: AsyncIterable<ChatCompletionChunk> = {
    async *[Symbol.asyncIterator]() {
      yield chunks[0] as ChatCompletionChunk;
      await gate;
      for (const c of chunks.slice(1)) yield c as ChatCompletionChunk;
    },
  };
  return { stream, release };
}

/** 每次投递按顺序给出下一份流：给 chunk 数组就包成流，给现成的流就直接用（没有下一份就是空流） */
function createMockClient(deliveries: Array<AnyChunk[] | AsyncIterable<ChatCompletionChunk>>) {
  let callCount = 0;
  const create = vi.fn(async (_body: any, _options: any) => {
    const delivery = deliveries[callCount] ?? [];
    callCount++;
    return Array.isArray(delivery) ? makeStream(delivery) : delivery;
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

/** 反复问一遍条件成立没有（最多等 1s） */
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

/**
 * 事件表里的**全部**名字：键与值是同一个字。
 *
 * 写成这张穷尽表而不是手抄一串字符串：`AgentEvents` 上多一个事件、这里少一格就过不了编译
 * —— 「一条事实都没漏听」是第五个用例的前提，漏听一条，那条断言就不再成立。
 */
const ALL_EVENTS: { readonly [K in keyof AgentEvents]: K } = {
  started: "started",
  stopped: "stopped",
  killed: "killed",
  "state:idle": "state:idle",
  "state:working": "state:working",
  "output:paused": "output:paused",
  "output:resumed": "output:resumed",
  "input:paused": "input:paused",
  "input:resumed": "input:resumed",
  aborted: "aborted",
  inboxAdded: "inboxAdded",
  inboxTaken: "inboxTaken",
  inboxCleared: "inboxCleared",
  messageAdded: "messageAdded",
  messageChanged: "messageChanged",
  messageRemoved: "messageRemoved",
  messageFinished: "messageFinished",
  delta: "delta",
  requestSent: "requestSent",
  responseFinished: "responseFinished",
  turnStarted: "turnStarted",
  turnFinished: "turnFinished",
  toolStarted: "toolStarted",
  toolFinished: "toolFinished",
  subAgentStarted: "subAgentStarted",
  subAgentFinished: "subAgentFinished",
  denied: "denied",
  failed: "failed",
  observerFailed: "observerFailed",
};

/** 全部名字，按表里的顺序 */
const ALL_EVENT_NAMES = Object.values(ALL_EVENTS);

/**
 * 把所有事件按到达顺序记进一个数组（返回那个数组本身，用例最后拿它判次序）。
 *
 * 记的是**名字**：这些用例问的都是「哪几条、什么顺序」，载荷在看具体那几条时另订。
 */
function recordAllEvents(agent: Agent): string[] {
  const names: string[] = [];
  for (const name of ALL_EVENT_NAMES) agent.on(name, () => names.push(name));
  return names;
}

// ---------------------------------------------------------------------------

describe("一趟请求的边界", () => {
  it("一趟里五条事实的次序", async () => {
    const { client } = createMockClient([textStream("答了")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const names = recordAllEvents(agent);
    // 开始 / 结束那一刻那条 assistant 是什么样：交出来的必须是同一个活对象，不是快照。
    // 状态在收到那一下当场记下来 —— 事后读到的永远是终值（活对象不是快照）
    const boundaries: Array<{
      at: string;
      message: AgentNS.Message;
      status?: AgentNS.MessageStatus;
    }> = [];
    agent.on("turnStarted", (payload) =>
      boundaries.push({ at: "开始", message: payload.message, status: payload.message.status }),
    );
    agent.on("turnFinished", (payload) =>
      boundaries.push({ at: "结束", message: payload.message, status: payload.message.status }),
    );

    void agent.start();
    agent.push(user("说话"));
    await settled(agent);

    // 一条占位（`messageAdded`）+ 四条边界事实：这一趟从「有了那条占位」到「它定型」的全程
    const boundary = names.filter(
      (name) =>
        name === "turnStarted" ||
        name === "requestSent" ||
        name === "responseFinished" ||
        name === "turnFinished",
    );
    expect(boundary).toEqual(["turnStarted", "requestSent", "responseFinished", "turnFinished"]);

    // `turnStarted` 排在 `runTurn` 之前：占位先进历史，它才说话
    expect(names.indexOf("messageAdded")).toBeLessThan(names.indexOf("turnStarted"));
    // 收流结束在 `turnFinished` 之前：那一趟的全部事实都落在这一对之间
    expect(names.indexOf("responseFinished")).toBeLessThan(names.indexOf("turnFinished"));

    // 开始那一刻它还是 `pending`，结束那一刻它已经定型；
    // 两下交的是同一个实例、也就是历史里那一条
    expect(boundaries.map((entry) => entry.at)).toEqual(["开始", "结束"]);
    expect(boundaries.map((entry) => entry.status)).toEqual([
      AgentNS.MessageStatus.Pending,
      AgentNS.MessageStatus.Completed,
    ]);
    expect(boundaries[0]!.message).toBe(boundaries[1]!.message);
    expect(boundaries[1]!.message).toBe(agent.messages.at(-1));

    agent.stop();
    await agent.start();
  });

  it("带工具的那一趟：turnFinished 排在工具之后", async () => {
    const echo = new CallbackTool({
      function: {
        name: "echo",
        description: "把收到的文本原样送回来",
        parameters: { type: "object", properties: {} },
      },
      callback: (parsedArgs: any) => `回声：${parsedArgs?.text ?? ""}`,
    });

    const { client } = createMockClient([
      toolCallStream([{ id: "c1", name: "echo", args: '{"text":"你好"}' }]),
      textStream("收尾"),
    ]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds(), tools: [echo] });

    const names = recordAllEvents(agent);

    void agent.start();
    agent.push(user("跑个工具"));
    await settled(agent);

    // 第一趟的尾巴排在它引出的工具之后：工具跑完、钩子跑完，才说「这一趟结束」
    expect(names.indexOf("toolFinished")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("toolFinished")).toBeLessThan(names.indexOf("turnFinished"));

    // 模型要了两次答复（第一趟带工具调用、第二趟收尾），所以头与尾各两条，而且成对先后
    expect(names.filter((name) => name === "turnStarted" || name === "turnFinished")).toEqual([
      "turnStarted",
      "turnFinished",
      "turnStarted",
      "turnFinished",
    ]);

    agent.stop();
    await agent.start();
  });

  it("被拒的那一趟没有头也没有尾", async () => {
    const { client, create } = createMockClient([textStream("不该跑")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });
    agent.use({ onInnerLoopStart: () => "这一趟不跑" });

    const names = recordAllEvents(agent);
    const denials: DeniedEvent[] = [];
    agent.on("denied", (payload) => denials.push(payload));

    void agent.start();
    agent.push(user("说话"));
    await settled(agent);

    // 拒在造 assistant 占位之前：没有占位就是没有事实，一对事件都不发
    expect(names).not.toContain("turnStarted");
    expect(names).not.toContain("turnFinished");
    expect(agent.messages.some((message) => message.role === AgentNS.Role.Assistant)).toBe(false);
    // 模型一次都没被叫
    expect(create).not.toHaveBeenCalled();

    // 「这次没跑」本身仍是听得见的一格事实，理由就是钩子返回的那个字符串
    expect(denials).toHaveLength(1);
    expect(denials[0]!.hook).toBe("onInnerLoopStart");
    expect(denials[0]!.reason).toBe("这一趟不跑");

    agent.stop();
    await agent.start();
  });

  it("中断那一趟照样有尾", async () => {
    const gated = makeGatedStream([
      chunk({ content: "前半" }),
      chunk({ content: "后半" }),
      chunk({}, "stop"),
    ]);
    const { client } = createMockClient([gated.stream]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const names = recordAllEvents(agent);

    void agent.start();
    agent.push(user("说话"));
    // 等到第一片真的进来：这时这一趟已经在收流了
    await until(() => names.includes("delta"));

    agent.abort();
    gated.release();
    await settled(agent);

    expect(names).toContain("turnStarted");
    // 中断的那一趟一定有尾巴：订阅者要靠它结算用量、冲刷这一笔
    expect(names.filter((name) => name === "turnFinished")).toHaveLength(1);

    const assistant = agent.messages.find((message) => message.role === AgentNS.Role.Assistant)!;
    expect(assistant.status).toBe(AgentNS.MessageStatus.Aborted);

    agent.stop();
    await agent.start();
  });
});

describe("定稿", () => {
  /** 收到一条 `messageFinished` 就记下那条消息与它**那一刻**的状态（活对象事后读到的是终值） */
  function recordFinished(
    agent: Agent,
  ): Array<{ message: AgentNS.Message; status?: AgentNS.MessageStatus }> {
    const finished: Array<{ message: AgentNS.Message; status?: AgentNS.MessageStatus }> = [];
    agent.on("messageFinished", (payload) =>
      finished.push({ message: payload.message, status: payload.message.status }),
    );
    return finished;
  }

  it("流式期间一次都不发，收尾发一条", async () => {
    const { client } = createMockClient([textStream("答了")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const names = recordAllEvents(agent);
    const finished = recordFinished(agent);

    // 这一轮**只拧一把钥匙**、history 空着：于是这一轮里落地的消息只有那条 assistant 占位，
    // 「整轮里只有一条」才是一句能直接钉的话（用户说的话那一条由下面那个用例单独管）。
    void agent.start();
    agent.push();
    await settled(agent);

    // 流式期间一片都不发：两片 delta 之后才有那一条
    expect(names.filter((name) => name === "delta")).toHaveLength(2);
    expect(finished).toHaveLength(1);

    const assistant = agent.messages.find((message) => message.role === AgentNS.Role.Assistant)!;
    expect(finished[0]!.message).toBe(assistant);
    expect(finished[0]!.status).toBe(AgentNS.MessageStatus.Completed);

    // 位置：最后一片 delta 之后，`responseFinished` 之后（「到此为止」排在「现在变成了这样」之后）
    const at = names.indexOf("messageFinished");
    expect(at).toBeGreaterThan(names.lastIndexOf("delta"));
    expect(at).toBeGreaterThan(names.indexOf("responseFinished"));

    agent.stop();
    await agent.start();
  });

  it("用户说的话也有一条", async () => {
    const { client } = createMockClient([textStream("答了")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const names = recordAllEvents(agent);
    const finished = recordFinished(agent);

    void agent.start();
    agent.push(user("说话"));
    await settled(agent);

    const said = agent.messages.find((message) => message.role === AgentNS.Role.User)!;

    // 出生就是终版：`messageAdded` 之后**紧接着**就是它（同一次 `append` 里发出去的两条）
    expect(names.indexOf("messageFinished")).toBe(names.indexOf("messageAdded") + 1);
    // 同一条消息恰一条：后面（修尾、收尾）不会再报一次
    expect(finished.filter((entry) => entry.message === said)).toHaveLength(1);
    expect(finished.find((entry) => entry.message === said)!.status).toBe(
      AgentNS.MessageStatus.Completed,
    );

    agent.stop();
    await agent.start();
  });

  it("中断的那一条也有", async () => {
    const gated = makeGatedStream([
      chunk({ content: "前半" }),
      chunk({ content: "后半" }),
      chunk({}, "stop"),
    ]);
    const { client } = createMockClient([gated.stream]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const names = recordAllEvents(agent);
    const finished = recordFinished(agent);

    void agent.start();
    agent.push(user("说话"));
    await until(() => names.includes("delta"));

    // 第二片之前掐住：这一趟的收尾落在中断之后
    agent.abort();
    gated.release();
    await settled(agent);

    const assistant = agent.messages.find((message) => message.role === AgentNS.Role.Assistant)!;
    // 中断也是一种落定：定稿照样有，恰一条，那一刻的状态就是 `aborted`
    expect(finished.filter((entry) => entry.message === assistant)).toHaveLength(1);
    expect(finished.find((entry) => entry.message === assistant)!.status).toBe(
      AgentNS.MessageStatus.Aborted,
    );

    agent.stop();
    await agent.start();
  });
});

describe("序号与时刻", () => {
  /** 把收到的每一条事实的「名字 + 序号 + 时刻」按到达顺序记下来 */
  function recordFacts(agent: Agent): Array<{ name: string; seq: number; at: string }> {
    const facts: Array<{ name: string; seq: number; at: string }> = [];
    for (const name of ALL_EVENT_NAMES) {
      agent.on(name, (payload) => facts.push({ name, seq: payload.seq, at: payload.at }));
    }
    return facts;
  }

  it("从 1 开始、连续、不重不掉", async () => {
    const echo = new CallbackTool({
      function: {
        name: "echo",
        description: "把收到的文本原样送回来",
        parameters: { type: "object", properties: {} },
      },
      callback: (parsedArgs: any) => `回声：${parsedArgs?.text ?? ""}`,
    });

    // 带一次工具调用：两趟请求、一条 tool 消息，事件比只有文字那一趟多得多
    const { client } = createMockClient([
      toolCallStream([{ id: "c1", name: "echo", args: '{"text":"你好"}' }]),
      textStream("收尾"),
    ]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds(), tools: [echo] });

    const facts = recordFacts(agent);

    void agent.start();
    agent.push(user("跑个工具"));
    await settled(agent);

    // 工具那一趟真的发生了（不然这一条问的事件太少）
    expect(facts.some((fact) => fact.name === "toolFinished")).toBe(true);

    // 序号是这个执行体自己的那一条链：1、2、3……不重、不掉、不跳
    const seqs = facts.map((fact) => fact.seq);
    expect(seqs[0]).toBe(1);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));

    // 时刻：每一条都解析得出
    expect(facts.every((fact) => !Number.isNaN(Date.parse(fact.at)))).toBe(true);

    agent.stop();
    await agent.start();
  });

  it("死了之后序号不再往前走，也就不再有事实", async () => {
    const gated = makeGatedStream([
      chunk({ content: "前半" }),
      chunk({ content: "后半" }),
      chunk({}, "stop"),
    ]);
    const { client } = createMockClient([gated.stream]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const facts = recordFacts(agent);

    const death = agent.start();
    agent.push(user("说话"));
    await until(() => facts.some((fact) => fact.name === "delta"));

    // 正收着流的时候杀死：那一次请求的收尾还在后头，它会想再说几条
    agent.kill();
    gated.release();
    await death;
    // 再等一拍：迟到的收尾也在这一拍里（应当一条都发不出来）
    await new Promise((resolve) => setTimeout(resolve, 150));

    const last = facts.at(-1)!;
    expect(last.name).toBe("killed");
    // 号 = 收到的条数：门后面的那几条一条都没发出来，号也没被偷偷加
    expect(last.seq).toBe(facts.length);
  });
});

describe("死了之后不再有事实", () => {
  it("killed 之后一条事实都没有", async () => {
    // 这条钉的是**次序**，不是门：死亡那一条必须是最后一条。
    //
    // 正常形状里它本来就排在最后 —— 收尾（`turnFinished`、`messageChanged`、`failed`）走完，
    // 才轮到循环出口的 `markDead()`；也就是说把门去掉，这一条照样绿（做过对照）。它挡的是
    // 将来有人把 `markDead` 提前、或者让收尾跑到循环出口之后：那时 `killed` 后面会多出事实，
    // 这里当场变红。
    //
    // 「门真的关上过」由下面那条「死了之后，迟到的失败也听不见」管。
    const gated = makeGatedStream([
      chunk({ content: "前半" }),
      chunk({ content: "后半" }),
      chunk({}, "stop"),
    ]);
    const { client } = createMockClient([gated.stream]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const names = recordAllEvents(agent);

    const death = agent.start();
    agent.push(user("说话"));
    await until(() => names.includes("delta"));

    // 正收着流的时候杀死：那一次请求的收尾还在后头
    agent.kill();
    gated.release();
    await death;

    // 「我要没了」恰有一条，而且它是最后一条 —— 之后一条事实都没有
    expect(names.filter((name) => name === "killed")).toHaveLength(1);
    expect(names.indexOf("killed")).toBe(names.length - 1);

    // 内存里照样定型了，只是没往外说
    const assistant = agent.messages.find((message) => message.role === AgentNS.Role.Assistant)!;
    expect(assistant.status).toBe(AgentNS.MessageStatus.Aborted);
  });

  it("死了之后，迟到的失败也听不见", async () => {
    const { client } = createMockClient([textStream("答了")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    // 只实现 `onKill`，别的钩子一概不挂：这条用例只问死之后那一条钩子的失败。
    //
    // `kill()` / `stop()` 里那几条钩子是 fire-and-forget（`void this.dispatchHook(...)`），
    // 都是不等结果的；钩子里的 `await` 一慢，它炸的那一刻就落在 `killed` 之后。
    // `dispatchHook` 接住之后会发一条 `failed` —— 那一条正是门该吞掉的。
    agent.use({
      onKill: async () => {
        await new Promise((r) => setTimeout(r, 50));
        throw new Error("收尾钩子炸了 marker-9c1e");
      },
    });

    const names = recordAllEvents(agent);

    const death = agent.start();
    agent.push(user("说话"));
    await until(() => names.includes("delta"));

    agent.kill();
    await death;
    // 再等一拍：那个迟到的钩子要到 `killed` 之后才炸
    await new Promise((r) => setTimeout(r, 150));

    // 与上一条的分工：上一条钉次序（死那一条是最后一条），这一条钉「门真的关上过」。
    //
    // 为什么这一条分得出来：迟到的失败是在 `killed` 之后才炸的，它只可能排在那一条后头，
    // 所以门不在就一定会多出一条 `failed` —— 上一条在门去掉之后照样绿，这一条不行。
    expect(names.filter((name) => name === "killed")).toHaveLength(1);
    expect(names.indexOf("failed")).toBe(-1);
    expect(names.indexOf("killed")).toBe(names.length - 1);
  });
});
