import { describe, it, expect, vi } from "vitest";
import { Agent, type ObserverFailedEvent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

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

function makeStream(chunks: AnyChunk[]): AsyncIterable<ChatCompletionChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c as ChatCompletionChunk;
    },
  };
}

/** 每次投递返回一份固定的 chunk 数组 */
function createMockClient(deliveries: AnyChunk[][]) {
  let callCount = 0;
  const create = vi.fn(async (_body: any, _options: any) => {
    const data = deliveries[callCount] ?? [];
    callCount++;
    return makeStream(data);
  });
  return { client: { chat: { completions: { create } } } as any, create };
}

/**
 * 等到它真的停下来：闲 且 队列空。
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

describe("Agent 观察隔离", () => {
  it("订阅者抛错，Agent照常跑完", async () => {
    const { client } = createMockClient([textStream("第一句答复"), textStream("第二句答复")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    // 每一次 `delta` 都炸：宿主写库满了 / 推送断了，都是这种形状
    let thrown = 0;
    agent.on("delta", () => {
      thrown++;
      throw new Error("写库失败了：磁盘满");
    });

    void agent.start();
    agent.send(user("第一问"));
    await settled(agent);

    const first = agent.messages.at(-1)!;
    expect(thrown).toBeGreaterThan(0);
    expect(first.content).toBe("第一句答复");
    expect(first.status).toBe(AgentNS.MessageStatus.Completed);
    expect(agent.state).toBe("idle");

    // 循环没坏：再投一句，照样答得出来
    agent.send(user("第二问"));
    await settled(agent);

    const second = agent.messages.at(-1)!;
    expect(second.content).toBe("第二句答复");
    expect(second.status).toBe(AgentNS.MessageStatus.Completed);
    expect(agent.state).toBe("idle");

    agent.stop();
    await agent.start();
  });

  it("一个订阅者抛错，同一事件上的另一个订阅者照常收到", async () => {
    const { client } = createMockClient([textStream("答了")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    let broken = 0;
    const seen: unknown[] = [];
    agent.on("delta", () => {
      broken++;
      throw new Error("推送失败了");
    });
    agent.on("delta", (payload) => {
      seen.push(payload.chunk);
    });

    void agent.start();
    agent.send(user("说话"));
    await settled(agent);

    // 先订的那一个每次都炸……
    expect(broken).toBe(2);
    // ……后订的那一个照常收全：`textStream` 两片，`delta` 就该是两条
    expect(seen).toHaveLength(2);

    agent.stop();
    await agent.start();
  });

  it("炸掉的那一条被报成 observerFailed，带着是哪个事件、哪个错", async () => {
    const { client } = createMockClient([textStream("答了")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    const observed: ObserverFailedEvent[] = [];
    agent.on("observerFailed", (payload) => observed.push(payload));

    const marker = "推送失败了：连接断了 marker-7f3a";
    agent.on("state:working", () => {
      throw new Error(marker);
    });

    void agent.start();
    agent.send(user("说话"));
    await settled(agent);

    expect(observed.length).toBeGreaterThan(0);
    const first = observed[0]!;
    expect(first.event).toBe("state:working");
    expect(first.error).toBeInstanceOf(Error);
    expect(first.error.message).toBe(marker);
    // 报的是「同一个 Agent 上的事」，不是别处转来的
    expect(first.agent).toBe(agent);

    agent.stop();
    await agent.start();
  });

  it("订阅 observerFailed 的自己也炸：不递归、不掀翻", async () => {
    const { client } = createMockClient([textStream("照常答完")]);
    const agent = new Agent({ client, model: "m", newMessageId: makeIds() });

    // 记日志的那一个自己也坏：它会被叫起来（有人炸了），然后自己也炸
    let failedObserverCalled = 0;
    agent.on("observerFailed", () => {
      failedObserverCalled++;
      throw new Error("记日志也炸了");
    });
    // 让它真的被叫起来：另一个订阅者每次都炸
    agent.on("delta", () => {
      throw new Error("推送失败了");
    });

    const death = agent.start();
    agent.send(user("说话"));
    await settled(agent);

    expect(failedObserverCalled).toBeGreaterThan(0);
    const answer = agent.messages.at(-1)!;
    expect(answer.content).toBe("照常答完");
    expect(answer.status).toBe(AgentNS.MessageStatus.Completed);

    agent.stop();
    // 递归 / 栈溢出会把异常抛到这里；跑得完且不 reject 就是证据
    await expect(death).resolves.toBeUndefined();
  });
});
