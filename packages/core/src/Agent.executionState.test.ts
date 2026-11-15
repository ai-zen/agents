/**
 * 段状态（`runStatus` / `sendStatus`）与投递（`deliver`）的取证。
 *
 * 这里不重复 `Agent.inbox.test.ts` 里「条目在哪一刻落成消息」那类用例，只钉三件事：
 *
 *   1. **谁起段**：`deliver` 的两个字段判据（静止态才叫醒）、`send` / `run` 的单飞；
 *   2. **`stopping` 的必要性**：abort 之后那一段还在收尾，任何东西都不许在这段窗口里起新段；
 *   3. **`status` 事件的 from → to**：段边界的四种转换，别与 `finally` 混。
 */
import { describe, it, expect, vi } from "vitest";
import { Agent } from "./Agent.js";
import type { StatusContext } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// Helper
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

/** 只输出一段正文就停（不调工具） */
function textRound(text: string): AnyChunk[] {
  return [chunk({ content: text }), chunk({}, "stop")];
}

function makeStream(chunks: AnyChunk[]): AsyncIterable<ChatCompletionChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield c as ChatCompletionChunk;
      }
    },
  };
}

/** 立刻吐流的假 client：每一轮按脚本走，脚本用完就回一句默认答复 */
function scriptedClient(rounds: AnyChunk[][]) {
  const bodies: any[] = [];
  const create = vi.fn(async (body: any) => {
    bodies.push(body);
    return makeStream(rounds[bodies.length - 1] ?? textRound("答复"));
  });
  const client = { chat: { completions: { create } } } as any;
  return { client, create, bodies };
}

/**
 * 每次请求都会停在**手动闸门**上的假 client：`releases[n]()` 才放行第 n+1 次请求。
 *
 * 为什么不用「signal abort 时结束的挂起流」：本文件要停住的恰恰是 abort **之后**那一段的
 * 收尾（`stopping` 窗口）。用 signal 收尾的假流会在 abort 的同一拍结束，窗口就关上了。
 */
function gatedClient(rounds: AnyChunk[][] = []) {
  const bodies: any[] = [];
  const releases: Array<() => void> = [];
  const create = vi.fn(async (body: any) => {
    bodies.push(body);
    await new Promise<void>((resolve) => releases.push(resolve));
    return makeStream(rounds[bodies.length - 1] ?? textRound("答复"));
  });
  const client = { chat: { completions: { create } } } as any;
  return { client, create, bodies, releases };
}

/** 记下每一次 `status` 事件的 `from → to`（顺带校验载荷带的是这个 agent） */
function watchStatus(agent: Agent): string[] {
  const seen: string[] = [];
  agent.events.on("status", (ctx: StatusContext) => {
    expect(ctx.agent).toBe(agent);
    seen.push(`${ctx.from}→${ctx.to}`);
  });
  return seen;
}

/** 等段结束（`deliver` / `send` 起的段可能是 fire-and-forget 的，测试靠状态回落来等） */
async function settled(agent: Agent): Promise<void> {
  await vi.waitFor(() => expect(["idle", "terminated"]).toContain(agent.runStatus));
}

/** 消息里所有 User 的正文（按顺序） */
function users(agent: Agent): unknown[] {
  return agent.messages.filter((m) => m.role === AgentNS.Role.User).map((m) => m.content);
}

function makeAgent(client: any): Agent {
  return new Agent({ client, model: "gpt-4", messages: [Message.System("助手")] });
}

// ---------------------------------------------------------------------------
// 谁起段
// ---------------------------------------------------------------------------

describe("Agent 段状态：deliver 的两个判据", () => {
  it("静止态投递：同步返回、woke === true，段真的被叫起来", async () => {
    const { client, create } = scriptedClient([textRound("收到了")]);
    const agent = makeAgent(client);
    const events = watchStatus(agent);

    const receipt = agent.deliver({ source: "user", priority: "high", content: "插一句" });

    // 同步：入队 + 回执 + 起段都不等任何一跳（`run()` 的第一段同步代码就是置位）
    expect(receipt.accepted).toBe(true);
    expect(receipt.woke).toBe(true);
    expect(agent.runStatus).toBe("running");
    // 唤醒前就落地了（`deliver` 里的 `flushInbox`）：队列同步空掉，那条已经躺在 `messages` 里 ——
    // 所以第一圈请求一定看得到它。
    // 改前这里是「条目还在队列里，等着段首取件」；改后取件点只剩内循环末，唤醒前的落地归 `deliver`。
    expect(agent.inbox).toHaveLength(0);
    expect(agent.messages.at(-1)!.id).toBe(receipt.messageId);

    await settled(agent);

    // 段的第一件事就是把队列落成 User 消息，于是第一次请求里就有它
    expect(create).toHaveBeenCalledTimes(1);
    expect(users(agent)).toEqual(["插一句"]);
    expect(agent.messages.at(-1)!.content).toBe("收到了");
    expect(events).toEqual(["idle→running", "running→idle"]);
  });

  it("段正在跑时投递：woke === false，条目由**那一段**取走（不起第二段）", async () => {
    const { client, create, bodies, releases } = gatedClient([
      textRound("第一轮"),
      textRound("第二轮"),
    ]);
    const agent = makeAgent(client);
    agent.append(Message.User("先说一句"));

    const runPromise = agent.run();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(agent.runStatus).toBe("running");

    const receipt = agent.deliver({ source: "tool", priority: "low", content: "跑着的时候来的" });
    expect(receipt.woke).toBe(false);
    // 没有起第二段：请求次数还是 1
    expect(create).toHaveBeenCalledTimes(1);

    // 放行第一轮；那一段跑完一组后自己把条目取走 → 同一段里再跑一组（第二次请求）
    releases[0]!();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    releases[1]!();
    await runPromise;

    expect(agent.inbox).toHaveLength(0);
    expect(users(agent)).toEqual(["先说一句", "// 这条消息来自 tool 自动推送\n\n跑着的时候来的"]);
    expect(agent.messages.at(-1)!.content).toBe("第二轮");
    expect(bodies).toHaveLength(2);
    expect(agent.runStatus).toBe("idle");
  });

  it('send 受理期间（sendStatus === "sending"）投递：不起段，条目由那次 send 的那一段在轮末插进去', async () => {
    // 口径变了（改前 / 改后）：
    // - 改前：`run()` 段的第一件事就是取件，所以 `onBeforeSend` 里投的这条会在**第一圈请求之前**
    //   落成 User 消息（只有 1 次请求）；
    // - 改后：`run()` 不再在段首取件，而 `send()` 的 `finally` 只负责「受理结束之后」那一跳。
    //   受理**当中**投的这条于是走段内唯一的取件点——内循环末，且它是 `high`，所以第一次请求
    //   先发出（看不到它）、轮末插进、再跑一圈。代价是这一圈，好处是取件只有一处判据。
    const { client, create, bodies } = scriptedClient([textRound("一"), textRound("二")]);
    const agent = makeAgent(client);
    const events = watchStatus(agent);

    let receipt: AgentNS.DeliveryReceipt | undefined;
    agent.use({
      onBeforeSend: () => {
        // 这一刻 `runStatus` 还是 idle，可这次受理已经开始了 —— 所以不能另起一段
        expect(agent.runStatus).toBe("idle");
        expect(agent.sendStatus).toBe("sending");
        receipt = agent.deliver({ source: "user", priority: "high", content: "钩子里投的" });
      },
    });

    await agent.send("你好");

    expect(receipt!.woke).toBe(false);
    expect(agent.inbox).toHaveLength(0);
    // 只有一段（这次 send 的段），不是两段
    expect(create).toHaveBeenCalledTimes(2);
    expect(events.filter((point) => point === "idle→running")).toHaveLength(1);
    // 条目在**第二圈**请求里（第一圈发出去时它还只排在队列里）
    expect(users(agent)).toEqual(["你好", "钩子里投的"]);
    expect(JSON.stringify(bodies[0].messages)).not.toContain("钩子里投的");
    expect(bodies[1].messages.at(-1).content).toBe("钩子里投的");
  });

  it("有人直接 await agent.run() 时投递：不起第二段，条目在段末被取走", async () => {
    const { client, create, releases } = gatedClient([textRound("一"), textRound("二")]);
    const agent = makeAgent(client);
    agent.append(Message.User("你好"));

    const runPromise = agent.run();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    const receipt = agent.deliver({ source: "user", priority: "low", content: "手动跑时投的" });
    expect(receipt.woke).toBe(false);
    expect(agent.runStatus).toBe("running");

    releases[0]!();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    releases[1]!();
    await runPromise;

    // 段末取件把它带走，并在同一段里再跑一组
    expect(agent.inbox).toHaveLength(0);
    expect(users(agent)).toEqual(["你好", "手动跑时投的"]);
    expect(agent.messages.at(-1)!.content).toBe("二");
  });

  it("两个并发 send 不会跑出两个段：第二个的 run() 单飞返回", async () => {
    const { client, create, bodies, releases } = gatedClient([textRound("只回一句")]);
    const agent = makeAgent(client);
    const events = watchStatus(agent);

    const first = agent.send("第一句");
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // 第二个 send 立刻回来：`run()` 看到 running 就单飞返回，不另起一段
    const messages = await agent.send("第二句");
    expect(create).toHaveBeenCalledTimes(1);
    expect(messages.map((m) => m.content)).toContain("第二句");

    releases[0]!();
    await first;
    await settled(agent);

    // 全程只有一段：一次请求、一条 assistant、一跳 idle → running
    expect(create).toHaveBeenCalledTimes(1);
    expect(events.filter((point) => point === "idle→running")).toHaveLength(1);
    expect(agent.messages.filter((m) => m.role === AgentNS.Role.Assistant)).toHaveLength(1);
    // 两句 User 都在 messages 里，但只有第一句进过请求（第二句是「跑着的时候 append 的」）
    expect(users(agent)).toEqual(["第一句", "第二句"]);
    expect(JSON.stringify(bodies[0].messages)).not.toContain("第二句");
  });
});

// ---------------------------------------------------------------------------
// abort / terminated / stopping
// ---------------------------------------------------------------------------

describe("Agent 段状态：abort 之后", () => {
  /** 起一段并把它停在第一次请求里（回归时 `runStatus === "running"`） */
  async function startAndHold(
    agent: Agent,
    ctx: { create: any; releases: Array<() => void> },
  ): Promise<{ runPromise: Promise<unknown> }> {
    agent.append(Message.User("你好"));
    const runPromise = agent.run();
    await vi.waitFor(() => expect(ctx.create).toHaveBeenCalledTimes(1));
    // 包成对象再返回：直接 return 一个 promise 会被 async 函数「吸收」进自己的 promise，
    // 于是调用方的 `await startAndHold(...)` 就等于 await 这一段（段永远不结束 → 死锁）
    return { runPromise };
  }

  it("abort 不清空 inbox：收尾完成后是 terminated，条目一条不少", async () => {
    const ctx = gatedClient([textRound("不该跑完")]);
    const agent = makeAgent(ctx.client);
    const { runPromise } = await startAndHold(agent, ctx);
    // 跑着的时候投两条（真机形态：别的会话投递 / 异步工具结果）
    agent.deliver({ source: "user", priority: "high", content: "别的会话投的" });
    agent.deliver({ source: "tool", priority: "low", content: "异步工具结果" });

    agent.abort();
    ctx.releases[0]!();
    await runPromise;

    // 数据是数据：一条都没被「用户按停」这个动作抹掉
    expect(agent.inbox.map((entry) => entry.content)).toEqual(["别的会话投的", "异步工具结果"]);
    expect(agent.runStatus).toBe("terminated");
    // 也没有插进消息里（这一段的取件点全都过了）
    expect(users(agent)).toEqual(["你好"]);
  });

  it("abort 之后 deliver 能解冻：terminated → running，条目被落成 User 消息", async () => {
    const { client, create } = scriptedClient([textRound("解冻之后回的")]);
    const agent = makeAgent(client);

    agent.abort();
    expect(agent.runStatus).toBe("terminated");

    const events = watchStatus(agent);
    const receipt = agent.deliver({ source: "user", priority: "low", content: "再跑一次" });

    // 外部驱动 = 解冻：静止态（terminated）也在叫醒的范围里
    expect(receipt.woke).toBe(true);
    expect(agent.runStatus).toBe("running");

    await settled(agent);

    expect(create).toHaveBeenCalledTimes(1);
    expect(agent.runStatus).toBe("idle");
    expect(users(agent)).toEqual(["再跑一次"]);
    expect(agent.messages.at(-1)!.content).toBe("解冻之后回的");
    // terminated 只能被外部驱动带走：terminated → running → idle
    expect(events).toEqual(["terminated→running", "running→idle"]);
  });

  it("abort 之后 send 也能解冻：terminated → running，跑完一轮", async () => {
    const { client, create } = scriptedClient([textRound("回答了")]);
    const agent = makeAgent(client);

    agent.abort();
    const events = watchStatus(agent);

    await agent.send("你好");

    expect(create).toHaveBeenCalledTimes(1);
    expect(users(agent)).toEqual(["你好"]);
    expect(agent.messages.at(-1)!.content).toBe("回答了");
    expect(events).toEqual(["terminated→running", "running→idle"]);
  });

  it("stopping 不可逆：abort 之后再 run / deliver 都不会把它拉回 running", async () => {
    const ctx = gatedClient([textRound("收尾用的")]);
    const agent = makeAgent(ctx.client);
    const events = watchStatus(agent);
    const { runPromise } = await startAndHold(agent, ctx);

    agent.abort();
    // 收尾还没完成：状态停在 stopping 上（既不接受工作，也不谎称已经停了）
    expect(agent.runStatus).toBe("stopping");

    // ① 直接 run()：立即返回，不起第二段
    await agent.run();
    expect(agent.runStatus).toBe("stopping");
    expect(ctx.create).toHaveBeenCalledTimes(1);

    // ② deliver：只入队，不叫醒（「静止态」不含 stopping）
    const receipt = agent.deliver({ source: "user", priority: "high", content: "stop 期间投的" });
    expect(receipt.woke).toBe(false);
    expect(agent.runStatus).toBe("stopping");
    expect(ctx.create).toHaveBeenCalledTimes(1);

    // 放行收尾：这一段自己把状态推到 terminated（stopping → running 这条路不存在）
    ctx.releases[0]!();
    await runPromise;

    expect(agent.runStatus).toBe("terminated");
    expect(events).toEqual(["idle→running", "running→stopping", "stopping→terminated"]);
    // stop 期间投的那条没被这一段带走（它属于下一次外部驱动）
    expect(agent.inbox.map((entry) => entry.content)).toEqual(["stop 期间投的"]);
    expect(users(agent)).toEqual(["你好"]);
  });

  it("stopping 期间 send：User 消息已 append，但这一遭不会被跑（已知行为，照实钉住）", async () => {
    const ctx = gatedClient([textRound("收尾用的")]);
    const agent = makeAgent(ctx.client);
    const { runPromise } = await startAndHold(agent, ctx);

    agent.abort();
    // 用户按停的同一瞬又发了一句：`run()` 单飞返回，这条消息进了 messages 却不会被跑
    const messages = await agent.send("按停的同一瞬又发了一句");
    expect(messages.map((m) => m.content)).toContain("按停的同一瞬又发了一句");
    expect(ctx.create).toHaveBeenCalledTimes(1);

    ctx.releases[0]!();
    await runPromise;

    expect(ctx.create).toHaveBeenCalledTimes(1);
    expect(agent.runStatus).toBe("terminated");
    // 消息都在，但 assistant 只有这一段的占位一条（第二句没有被回）
    expect(agent.messages.filter((m) => m.role === AgentNS.Role.Assistant)).toHaveLength(1);
    expect(users(agent)).toEqual(["你好", "按停的同一瞬又发了一句"]);
  });
});

// ---------------------------------------------------------------------------
// status 事件
// ---------------------------------------------------------------------------

describe("Agent 段状态：status 事件", () => {
  it("自然收尾：idle → running → idle（每次内循环的 finally 不冒充它）", async () => {
    const { client, create } = scriptedClient([textRound("一")]);
    const agent = makeAgent(client);
    const events = watchStatus(agent);
    const onFinally = vi.fn();
    agent.events.on("finally", onFinally);

    await agent.send("你好");

    expect(create).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["idle→running", "running→idle"]);
    // `finally` 说的是「每一圈内循环结束」，与段边界不是一个粒度 —— 两条事件各自独立
    expect(onFinally).toHaveBeenCalledTimes(1);
  });

  it("被叫停：running → stopping → terminated，连按两下不多发事件", async () => {
    const ctx = gatedClient([textRound("不该跑完")]);
    const agent = makeAgent(ctx.client);
    const events = watchStatus(agent);
    agent.append(Message.User("你好"));

    const runPromise = agent.run();
    await vi.waitFor(() => expect(ctx.create).toHaveBeenCalledTimes(1));

    agent.abort();
    // 第二下是空动作：不发事件，也不把状态推到 terminated（收尾归那一段）
    agent.abort();
    expect(agent.runStatus).toBe("stopping");

    ctx.releases[0]!();
    await runPromise;

    expect(events).toEqual(["idle→running", "running→stopping", "stopping→terminated"]);
  });

  it("静止时按停：idle → terminated（一跳，不经 stopping）", () => {
    const agent = new Agent({ client: {} as any, model: "gpt-4" });
    const events = watchStatus(agent);

    agent.abort();

    expect(agent.runStatus).toBe("terminated");
    expect(events).toEqual(["idle→terminated"]);
  });
});

// ---------------------------------------------------------------------------
// 受理的收尾（`send()` 的 finally）
// ---------------------------------------------------------------------------

describe("Agent 段状态：send 的收尾", () => {
  it("受理期间被 abort：终止态不复活，inbox 一条不多一条不少", async () => {
    const ctx = gatedClient([textRound("不该跑完")]);
    const agent = makeAgent(ctx.client);
    const events = watchStatus(agent);

    // 投递发生在这次受理的**收尾钩子**里：`sendStatus === "sending"`，`deliver()` 刻意
    // 没叫醒，于是「这张条目要不要在 send 的 finally 里起一段」成了一个必须表态的问题。
    agent.use({
      onAfterSend: () => {
        agent.deliver({ source: "tool", priority: "low", content: "受理期间来的" });
      },
    });

    const sending = agent.send("你好");
    await vi.waitFor(() => expect(ctx.create).toHaveBeenCalledTimes(1));
    expect(agent.runStatus).toBe("running");

    // 用户在这一段跑到一半时按停
    agent.abort();
    ctx.releases[0]!();

    await sending;

    // 终止态只有外部驱动（`send` / `deliver` 的调用本身）能解冻。这一次 send 的收尾是
    // **内部**收尾，不是外部驱动 —— 它不许把状态从 terminated 拉回 running 再跑一段。
    expect(agent.runStatus).toBe("terminated");
    // 条目原样留着（等下一次外部驱动），既没被丢掉，也没被这一跳偷偷跑掉
    expect(agent.inbox.map((entry) => entry.content)).toEqual(["受理期间来的"]);
    expect(ctx.create).toHaveBeenCalledTimes(1);
    // 全程只有这一段，没有多出来的 running
    expect(events).toEqual(["idle→running", "running→stopping", "stopping→terminated"]);
  });

  it("受理期间投递的条目：send() 返回时它已经被处理完（不是 fire-and-forget）", async () => {
    const { client, create } = scriptedClient([textRound("一"), textRound("二")]);
    const agent = makeAgent(client);

    let receipt: AgentNS.DeliveryReceipt | undefined;
    agent.use({
      onAfterSend: () => {
        receipt = agent.deliver({ source: "user", priority: "low", content: "钩子里来的" });
      },
    });

    await agent.send("你好");

    // 同步断言（`await` 之后不隔任何等待）：`send()` 返回 = 这一轮真的结束了。
    // 宿主持有这个假设（返回即 settle、即丢弃 agent），队列里剩下的东西必须在此之前处理完。
    expect(agent.inbox).toHaveLength(0);
    const landed = agent.messages.find((m) => m.id === receipt!.messageId)!;
    expect(landed.role).toBe(AgentNS.Role.User);
    expect(landed.content).toBe("钩子里来的");
    // 「被处理了」不止是落成 User，还包括为它跑出来的那一轮真的定型了
    expect(create).toHaveBeenCalledTimes(2);
    expect(agent.messages.at(-1)!.content).toBe("二");
  });
});
