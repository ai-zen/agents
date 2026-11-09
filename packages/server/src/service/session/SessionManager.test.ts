import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, type AgentLike } from "./SessionManager.js";
import { FileSessionStore } from "../store/FileSessionStore.js";
import type { SessionRecord, SessionStore } from "../store/SessionStore.js";
import type { HandoffMode, ServerEvent } from "../../protocol/sessions.js";
import { EventHub } from "../events/EventHub.js";

/**
 * 等一轮真正收尾。
 *
 * 收尾是**异步**的：`settleTurn` 先落盘、再发 `turn.end`（顺序是那条需求的全部意义）。
 * 所以驱动完 `finally` 之后要等一拍再断言，否则测的是「还没写完」而不是「没发」
 * —— 这与本仓「等条件成立」的约定同一个意思，只是这里的条件就是「异步收尾跑完」。
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 假 Agent —— 只实现会话管理器用到的那一小面（结构类型），
 * 事件由测试手动驱动，于是「SDK 的时序」在测试里是**可编程**的，不依赖网络与真实模型。
 */
class FakeAgent implements AgentLike {
  messages: any[] = [];
  lastUsage: unknown = undefined;
  sent: string[] = [];
  aborted = 0;
  /** 让 `send()` 挂住：用来证明 manager.send 不等一轮跑完 */
  holdSend: Promise<void> | null = null;

  /**
   * 交接要用到的那几面（真件是 SDK 的 `SdkAgent`，声明见 `HandoffAgentLike`）。
   * 默认无 `write` 工具 → 交接走「独立摘要」，不触网。
   */
  definition = { messages: [{ role: "system", content: "模板" }] };
  tools: Array<{ function?: { name?: string } }> = [];
  model = "m";
  modelConfig: Record<string, unknown> = {};
  client: unknown = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: DOC } }] }) } },
  };
  scope = { cwd: "/work/proj" };
  use(_plugin: unknown): void {}

  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  readonly events = {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      this.handlers.get(event)?.delete(handler);
    },
  };

  send(input: string): Promise<void> {
    this.sent.push(input);
    return this.holdSend ?? Promise.resolve();
  }

  abort(): void {
    this.aborted++;
  }

  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  handlerCount(): number {
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }
}

/**
 * 假的子 Agent —— 照 `FakeAgent` 的最小实现来：会话层只从它身上取两样，
 * 自己的 `messages`（快照用）与自己 `events`（挂监听用）。
 */
class FakeSubAgent {
  messages: any[] = [];
  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  readonly events = {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
  };

  /** 驱动一条子 Agent 自己的事件（`chunk-parsed` / `error`…） */
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

/**
 * 按 **core 的真实契约**发一片 chunk。
 *
 * `chunk-parsed` 是两参：`(receiver, chunk)` —— 第一个是那条正在拼的 assistant 消息，
 * 第二个才是原始 chunk。以前这里按单参发（`fire("chunk-parsed", chunk)`），正好满足了
 * 服务端那条“两种形状都认”的写法，于是一个「正文增量永远推不出去」的真 bug 躲过了一整轮
 * 单测（详见 `onChunk` 的注释）。假件的形状必须与真件一致。
 */
function fireChunk(target: { fire: (event: string, ...args: unknown[]) => void }, chunk: unknown): void {
  target.fire("chunk-parsed", { role: "assistant" }, chunk);
}

let agent: FakeAgent;
let manager: SessionManager;
let events: ServerEvent[];
let sessionCounter = 0;

/** 用例自己造的存档根：统一在 `afterEach` 收掉（漏一个就是一个跑不掉的 /tmp 目录） */
const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random()}`);
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** 交接文档正文：SDK 有 400 字节的有效性阈值（与 `SessionHandoff.test.ts` 同一个理由） */
const DOC = `# 交接文档\n\n${"- 桩内容\n".repeat(80)}`;

beforeEach(() => {
  agent = new FakeAgent();
  manager = new SessionManager({
    createAgent: async () => agent,
    // 确定性 id：用例断言的是“哪个是哪个”，不是时间戳本身
    nextSessionId: () => `chat_${++sessionCounter}`,
  });
  events = [];
  sessionCounter = 0;
  manager.subscribe((event) => events.push(event));
});

const create = () => manager.create({ workspaceId: "ws-1", path: "/work/proj", agentId: "default" });

/** 取某个事件名下的全部事件 */
const pick = <T extends ServerEvent["event"]>(name: T) =>
  events.filter((event) => event.event === name) as Extract<ServerEvent, { event: T }>[];

/** 模拟 OpenAI 风格的一个流式 chunk */
const chunk = (delta: Record<string, unknown>) => ({ choices: [{ delta }] });

/**
 * 挂住的摘要请求（只认取消）：用来把会话停在「交接进行中」那个状态。
 *
 * 必须响应 `signal`：不响应的话 `cancel()` 掐不断它，用例只能干等到超时。
 */
const hangingSummary = () => ({
  chat: {
    completions: {
      create: (_body: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("Request was aborted"), { name: "AbortError" })),
          );
        }),
    },
  },
});

describe("SessionManager：会话生命周期", () => {
  it("create 之后能在 list 里看到它（id 递增、agentId 缺省 default）", async () => {
    const first = await create();
    const second = await manager.create({ workspaceId: "ws-1", path: "/work/proj" });

    expect(first.sessionId).toBe("chat_1");
    expect(first.agentId).toBe("default");
    expect(second.sessionId).toBe("chat_2");
    expect(manager.list("ws-1").map((s) => s.sessionId)).toEqual(["chat_1", "chat_2"]);
  });

  it("list 按工作区过滤：会话是 workspace 的下级对象，不跨父容器列", async () => {
    await manager.create({ workspaceId: "ws-1", path: "/a" });
    await manager.create({ workspaceId: "ws-2", path: "/b" });

    expect(manager.list("ws-1").map((s) => s.sessionId)).toEqual(["chat_1"]);
    expect(manager.list("ws-2").map((s) => s.sessionId)).toEqual(["chat_2"]);
    expect(manager.list("ws-404")).toEqual([]);
  });

  it("默认 id 是存档格式 `chat_YYYY_MM_DD_HH_mm_ss`（活会话与存档共用同一个 id）", async () => {
    const raw = new SessionManager({ createAgent: async () => agent });
    const { sessionId } = await raw.create({ workspaceId: "ws-1", path: "/p" });
    expect(sessionId).toMatch(/^chat_\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/);
  });

  it("客户端指定 id（续接已有存档）时原样使用", async () => {
    const { sessionId } = await manager.create({
      workspaceId: "ws-1",
      path: "/work/proj",
      sessionId: "chat_2026_11_01_10_00_00",
    });
    expect(sessionId).toBe("chat_2026_11_01_10_00_00");
    expect(manager.list("ws-1").map((s) => s.sessionId)).toContain("chat_2026_11_01_10_00_00");
  });

  it("同一个 id 开第二次：报 session-exists（不静默顶掉正在跑的会话）", async () => {
    const first = await manager.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_dup" });
    await expect(
      manager.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_dup" }),
    ).rejects.toThrow(/already exists/);
    // 第一个不受影响
    expect(manager.list("ws-1").map((s) => s.sessionId)).toEqual([first.sessionId]);
  });

  it("create 把 workspaceId / path / agentId 原样交给装配方", async () => {
    const seen: unknown[] = [];
    const spyManager = new SessionManager({
      createAgent: async (input) => {
        seen.push(input);
        return agent;
      },
    });
    await spyManager.create({ workspaceId: "ws-9", path: "/p", agentId: "coder" });
    // 除三个身份字段，还会带上两个钩子（护栏让行 / 自动迁移），它们必须指向会话层
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ workspaceId: "ws-9", path: "/p", agentId: "coder" });
    expect((seen[0] as { isHandoffBusy?: unknown }).isHandoffBusy).toBeTypeOf("function");
    expect((seen[0] as { autoMigrate?: unknown }).autoMigrate).toBeTypeOf("function");
  });

  it("cancel 转发给 agent.abort；未知会话返回 cancelled:false", async () => {
    const { sessionId } = await create();
    expect(manager.cancel(sessionId)).toEqual({ cancelled: true });
    expect(agent.aborted).toBe(1);
    expect(manager.cancel("sess_404")).toEqual({ cancelled: false });
  });

  it("未知会话调用 send：抛带 unknown-session 码的错", async () => {
    expect(() => manager.send("sess_404", "hi")).toThrow(/unknown session/);
  });

  it("close 之后摘掉 SDK 事件，不再产生任何事件", async () => {
    const { sessionId } = await create();
    expect(agent.handlerCount()).toBeGreaterThan(0);

    manager.close(sessionId);
    expect(agent.handlerCount()).toBe(0);
    expect(manager.list("ws-1")).toEqual([]);

    agent.fire("open");
    expect(events).toEqual([]);
  });
});

describe("SessionManager：turnId 与「不等一轮跑完」", () => {
  it("send 立刻返回 turnId（不 await agent.send 的完成）", async () => {
    const { sessionId } = await create();
    let finished = false;
    agent.holdSend = new Promise<void>((resolve) => {
      setTimeout(() => {
        finished = true;
        resolve();
      }, 50);
    });

    expect(manager.send(sessionId, "你好")).toEqual({ turnId: 1 });
    expect(agent.sent).toEqual(["你好"]);
    expect(finished).toBe(false); // 这一轮还在跑，调用已经返回了
  });

  it("每轮 turnId +1，事件带的是本轮编号", async () => {
    const { sessionId } = await create();
    expect(manager.send(sessionId, "第一轮").turnId).toBe(1);
    agent.fire("open");
    expect(pick("session.phase").at(-1)!.turnId).toBe(1);

    // 先让第一轮收尾（SDK 的 `finally`）再起下一轮：并行两轮会被 `turn-busy` 挡住
    // （事件靠 `turnId` 的当前值归轮，两轮并行必然串号，见 `send` 的注释）
    agent.fire("finally");
    await settled();

    expect(manager.send(sessionId, "第二轮").turnId).toBe(2);
    agent.fire("open");
    expect(pick("session.phase").at(-1)!.turnId).toBe(2);
  });

  it("agent.send() 自己抛错 → 本轮以 turn.end(ok:false) 收尾", async () => {
    const { sessionId } = await create();
    agent.holdSend = Promise.reject(Object.assign(new Error("boom"), { code: "net" }));
    manager.send(sessionId, "x");
    await new Promise((resolve) => setTimeout(resolve, 0)); // 让 rejection 落地

    const end = pick("turn.end").at(-1)!;
    expect(end.ok).toBe(false);
    expect(end.error).toEqual({ code: "net", message: "boom" });
  });
});

/**
 * 并发守卫：同一段会话不并行两轮。
 *
 * 场景是真实的：`attach` 之后会话活得比连接久，两个客户端（两个终端）可能同时看着同一段
 * 会话。没有守卫时第二个 `send` 直接把 `turnId += 1`，第一轮后半段的增量与它的收尾就被
 * 贴在第二轮的编号上 —— 这里断言的正是「第二个调用被拒，且一个号都没被消耗」。
 *
 * 用真的交接链路（存档 + `handoff` 路径）：顺序那条用例必须让会话**真的**停在「交接
 * 进行中」，否则测的就不是顺序。
 */
describe("SessionManager：并发守卫（一轮在跑时不再起第二轮）", () => {
  let store: MemoryStore;
  let workspace: string;
  let guarded: SessionManager;

  beforeEach(async () => {
    store = new MemoryStore();
    workspace = await fs.mkdtemp(join(tmpdir(), "aiz-turn-guard-"));
    guarded = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => `chat_${++sessionCounter}`,
      storeFor: () => store,
      handoff: { aiZenDir: join(workspace, "ai-zen"), homeDir: workspace },
    });
    events = [];
    sessionCounter = 0;
    guarded.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  /** 抓同步抛出的错：客户端是按 `code` 分支的，不靠文案 */
  const catchSync = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error as { code?: string; message?: string };
    }
    throw new Error("expected to throw");
  };

  /** 起一轮但永不收尾：`holdSend` 一直悬着，SDK 的 `finally` 也不会来 */
  const hangTurn = async () => {
    const { sessionId } = await guarded.create({ workspaceId: "ws-1", path: workspace });
    agent.holdSend = new Promise<void>(() => {});
    return { sessionId, turnId: guarded.send(sessionId, "第一轮").turnId };
  };

  it("一轮在跑时再 send：报 turn-busy，且第二个 turnId 没有被消耗", async () => {
    const { sessionId, turnId } = await hangTurn();
    expect(turnId).toBe(1);

    const error = catchSync(() => guarded.send(sessionId, "插一条"));
    expect(error.code).toBe("turn-busy");
    expect(error.message).toMatch(/already has a turn in flight/);

    // 号没被消耗：list 里仍是 1，第二轮一次都没交给 Agent，也没有带 turnId=2 的 phase
    expect(guarded.list("ws-1").map((item) => item.turnId)).toEqual([1]);
    expect(agent.sent).toEqual(["第一轮"]);
    expect(pick("session.phase").every((event) => event.turnId === 1)).toBe(true);
  });

  it("该轮收尾（finally）之后 send 恢复正常：turnId 变 2", async () => {
    const { sessionId } = await hangTurn();
    agent.fire("finally");
    await settled();
    expect(pick("turn.end").at(-1)).toMatchObject({ turnId: 1, ok: true });

    expect(guarded.send(sessionId, "第二轮")).toEqual({ turnId: 2 });
    expect(agent.sent).toEqual(["第一轮", "第二轮"]);
    expect(guarded.list("ws-1").map((item) => item.turnId)).toEqual([2]);
  });

  it("交接进行中 send 报 handoff-in-flight（不是 turn-busy）：更准的原因先说", async () => {
    const { sessionId } = await guarded.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];
    agent.client = hangingSummary();

    const pending = guarded.handoff(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 0)); // 跑到「等模型」那一步

    // 交接期间 `turnSettled` 也是 false：两条守卫顺序反了，这里就会变成 turn-busy
    const error = catchSync(() => guarded.send(sessionId, "插一条"));
    expect(error.code).toBe("handoff-in-flight");
    expect(error.message).toMatch(/is handing off/);

    guarded.cancel(sessionId);
    await expect(pending).rejects.toThrow(/handoff cancelled/);
  });

  it("中止（cancel + 驱动 finally）之后 send 恢复：abort 不会把守卫卡死", async () => {
    const { sessionId } = await hangTurn();

    expect(guarded.cancel(sessionId)).toEqual({ cancelled: true });
    expect(agent.aborted).toBe(1);
    // 中止只负责掐断，收尾仍由 SDK 的 `finally` 落地（会话层不替它宣布结束）
    agent.fire("finally");
    await settled();
    expect(pick("turn.end").at(-1)).toMatchObject({ turnId: 1 });

    expect(guarded.send(sessionId, "再来一轮")).toEqual({ turnId: 2 });
  });
});

describe("SessionManager：SDK 事件 → 协议事件", () => {
  it("六态按 SDK 时序推进：open → queued，正文 delta → streaming，parsed 收尾", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    expect(manager.list("ws-1")[0]!.phase).toEqual({ kind: "connecting" }); // send 当下就报出去了

    agent.fire("open");
    expect(manager.list("ws-1")[0]!.phase).toEqual({ kind: "queued" });

    fireChunk(agent, chunk({ content: "你" }));
    expect(manager.list("ws-1")[0]!.phase).toEqual({ kind: "streaming" });

    agent.fire("parsed", { message: { role: "assistant", content: "你好" } });
    // 不带工具调用：状态机不改阶段，由 finally 归零
    agent.fire("finally");
    await settled();
    expect(manager.list("ws-1")[0]!.phase).toBeNull();
    expect(pick("turn.end").at(-1)!.ok).toBe(true);
  });

  it("正文与推理增量分别上报；只带 usage 的收尾 chunk 只带用量、不带正文", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    fireChunk(agent, chunk({ reasoning_content: "想…" }));
    fireChunk(agent, chunk({ content: "答案" }));
    // 只有 total_tokens、没有 completion_tokens：没有可校准的东西，不上报（免得一串空增量）
    fireChunk(agent, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 9 } });
    // 带 completion_tokens 的收尾 chunk：正文为空也要出去，状态栏的 tok/s 靠它校准
    fireChunk(agent, {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { completion_tokens: 42, total_tokens: 51 },
    });

    expect(pick("message.delta").map((e) => [e.text, e.reasoning])).toEqual([
      ["", "想…"],
      ["答案", ""],
      ["", ""],
    ]);
    expect(pick("message.delta").at(-1)!.usage).toEqual({ completionTokens: 42 });
  });

  it("本轮带工具调用：streamEnded 之后进 tool-waiting，并报出全部工具名", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    fireChunk(agent, chunk({ tool_calls: [{ index: 0, function: { name: "exec" } }] }));
    expect(manager.list("ws-1")[0]!.phase).toEqual({ kind: "tool-calling", tool: "exec" });

    agent.fire("parsed", {
      message: {
        role: "assistant",
        tool_calls: [
          { id: "a", function: { name: "exec" } },
          { id: "b", function: { name: "edit" } },
        ],
      },
    });
    expect(manager.list("ws-1")[0]!.phase).toMatchObject({ kind: "tool-waiting", tools: ["exec", "edit"] });
  });

  it("工具跑完一个就从等待里消失（并行时不会一直念着已完成的那个）", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    agent.fire("parsed", {
      message: {
        role: "assistant",
        tool_calls: [
          { id: "a", function: { name: "exec" } },
          { id: "b", function: { name: "edit" } },
        ],
      },
    });

    // SDK 在工具执行**前**就以 pending 追加结果消息，跑完翻成终态
    agent.messages.push({ role: "tool", tool_call_id: "a", status: "completed" });
    agent.messages.push({ role: "tool", tool_call_id: "b", status: "pending" });
    agent.fire("tool-call-end", { id: "a" });

    expect(manager.list("ws-1")[0]!.phase).toMatchObject({ kind: "tool-waiting", tools: ["edit"] });
  });

  it("error 与 finally 都会到：turn.end 只发一次，且带上错误", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    agent.fire("error", Object.assign(new Error("超时"), { code: "timeout" }));
    agent.fire("finally");
    await settled();

    const ends = pick("turn.end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ ok: false, error: { code: "timeout", message: "超时" } });
    expect(manager.list("ws-1")[0]!.phase).toBeNull();
  });
});

describe("SessionManager：订阅", () => {
  it("取消订阅后不再收到事件", async () => {
    const mine: ServerEvent[] = [];
    const unsubscribe = manager.subscribe((event) => mine.push(event));
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    expect(mine.length).toBeGreaterThan(0);

    unsubscribe();
    const before = mine.length;
    agent.fire("open");
    expect(mine.length).toBe(before);
  });

  it("一个订阅方抛错不影响其他订阅方收到事件", async () => {
    const survivor: ServerEvent[] = [];
    manager.subscribe(() => {
      throw new Error("这条连接写失败了");
    });
    manager.subscribe((event) => survivor.push(event));

    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    agent.fire("open");

    expect(survivor.length).toBeGreaterThan(1);
  });

  it("dispose 收摊：摘事件、清会话、清订阅", async () => {
    const { sessionId } = await create();
    manager.dispose();

    expect(agent.handlerCount()).toBe(0);
    expect(manager.list("ws-1")).toEqual([]);
    expect(manager.cancel(sessionId)).toEqual({ cancelled: false });
  });
});

/**
 * 子 Agent 栏目 —— 行为对齐 CLI 的 `onSubStart` / `onSubEnd`：序号、三态、增量分流、
 * 「只活当前一轮」。每条用例都对着一个会被后人改坏的点。
 */
describe("SessionManager：子 Agent（栏目）", () => {
  it("sub-agent-start → session.subAgent.started：index 从 1 起，id 是 sub-1 / sub-2", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    agent.fire("sub-agent-start", { subAgent: new FakeSubAgent() });
    agent.fire("sub-agent-start", { subAgent: new FakeSubAgent() });

    expect(pick("session.subAgent.started")).toEqual([
      { event: "session.subAgent.started", sessionId, turnId: 1, subAgentId: "sub-1", index: 1 },
      { event: "session.subAgent.started", sessionId, turnId: 1, subAgentId: "sub-2", index: 2 },
    ]);
  });

  it("子 Agent 的增量带 subAgentId 推给客户端，且**一行都不碰主阶段**", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    const sub = new FakeSubAgent();
    agent.fire("sub-agent-start", { subAgent: sub });

    // 主 Agent 此刻停在「等待委派工具返回」
    agent.fire("parsed", {
      message: {
        role: "assistant",
        tool_calls: [{ id: "a", function: { name: "call_skill_sub_agent" } }],
      },
    });
    const phasesBefore = pick("session.phase").length;

    fireChunk(sub, { choices: [{ delta: { reasoning_content: "想…" } }] });
    fireChunk(sub, { choices: [{ delta: { content: "子" } }] });

    expect(pick("message.delta").slice(-2)).toEqual([
      { event: "message.delta", sessionId, turnId: 1, subAgentId: "sub-1", text: "", reasoning: "想…" },
      { event: "message.delta", sessionId, turnId: 1, subAgentId: "sub-1", text: "子", reasoning: "" },
    ]);
    // 回归保护：拿子 Agent 的 delta 去改主阶段，界面会从「等待 xxx 返回」变成「输出中」
    expect(pick("session.phase")).toHaveLength(phasesBefore);
    expect(manager.list("ws-1")[0]!.phase).toMatchObject({
      kind: "tool-waiting",
      tools: ["call_skill_sub_agent"],
    });
  });

  it("sub-agent-end → session.subAgent.ended{done}", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    const sub = new FakeSubAgent();
    agent.fire("sub-agent-start", { subAgent: sub });

    agent.fire("sub-agent-end", { subAgent: sub });

    expect(pick("session.subAgent.ended")).toEqual([
      { event: "session.subAgent.ended", sessionId, turnId: 1, subAgentId: "sub-1", status: "done" },
    ]);
    expect((await manager.subAgentSnapshot(sessionId, "sub-1")).status).toBe("done");
  });

  it("子 Agent 出错：ended{failed} + 一条 notice；随后的 sub-agent-end 不能把它改成 done", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    const sub = new FakeSubAgent();
    agent.fire("sub-agent-start", { subAgent: sub });

    sub.fire("error", new Error("模型 500"));

    expect(pick("session.subAgent.ended")).toEqual([
      { event: "session.subAgent.ended", sessionId, turnId: 1, subAgentId: "sub-1", status: "failed" },
    ]);
    // 错误原文进 params.message：服务端不产文案，客户端查自己的 i18n 表
    expect(pick("session.notice")).toEqual([
      {
        event: "session.notice",
        sessionId,
        level: "error",
        code: "subAgentFailed",
        params: { index: 1, message: "模型 500" },
      },
    ]);

    // 出错优先：SDK 随后还会发 sub-agent-end，这里绝不能把它报成「跑完了」
    agent.fire("sub-agent-end", { subAgent: sub });
    expect(pick("session.subAgent.ended")).toHaveLength(1);
    expect((await manager.subAgentSnapshot(sessionId, "sub-1")).status).toBe("failed");
  });

  it("一轮结束（finally）就清空：subAgentSnapshot 报 sub-agent-missing", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    const sub = new FakeSubAgent();
    agent.fire("sub-agent-start", { subAgent: sub });
    expect((await manager.subAgentSnapshot(sessionId, "sub-1")).status).toBe("running");

    agent.fire("finally");
    await settled();

    await expect(manager.subAgentSnapshot(sessionId, "sub-1")).rejects.toMatchObject({
      code: "sub-agent-missing",
    });

    // 展示序号归零（下一轮又是「子AGENT1」），但 id 不归零 —— 与 CLI 一致：
    // id 是客户端选中态的锚点，跨轮复用会让上一轮残留的选中态接到新一轮的 sub-1 上
    manager.send(sessionId, "再来一轮");
    agent.fire("sub-agent-start", { subAgent: new FakeSubAgent() });
    expect(pick("session.subAgent.started").at(-1)).toMatchObject({
      turnId: 2,
      subAgentId: "sub-2",
      index: 1,
    });
  });

  it("subAgentSnapshot 给的是这个子 Agent 自己的对话（与主会话互不干扰）", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");
    agent.messages = [{ role: "user", content: "主线的事" }];
    const sub = new FakeSubAgent();
    sub.messages = [
      { role: "user", content: "子任务" },
      { role: "assistant", content: "子答复" },
    ];
    agent.fire("sub-agent-start", { subAgent: sub });

    expect(await manager.subAgentSnapshot(sessionId, "sub-1")).toEqual({
      subAgentId: "sub-1",
      index: 1,
      status: "running",
      messages: [
        { role: "user", content: "子任务" },
        { role: "assistant", content: "子答复" },
      ],
    });
    expect((await manager.snapshot(sessionId)).messages).toEqual([{ role: "user", content: "主线的事" }]);
  });

  it("未知会话 → unknown-session；未知子 Agent → sub-agent-missing", async () => {
    const { sessionId } = await create();

    await expect(manager.subAgentSnapshot("chat_404", "sub-1")).rejects.toThrow(/unknown session/);
    await expect(manager.subAgentSnapshot(sessionId, "sub-9")).rejects.toMatchObject({
      code: "sub-agent-missing",
    });
  });
});

/** 内存存档：续接与 save 的用例不需要碰磁盘 */
class MemoryStore implements SessionStore {
  readonly records = new Map<string, SessionRecord>();
  pointer: string | null = null;

  async list() {
    return [...this.records.keys()].map((id) => ({ id }));
  }
  async read(id: string) {
    return this.records.get(id) ?? null;
  }
  async write(record: SessionRecord) {
    this.records.set(record.id, record);
  }
  async remove(id: string) {
    this.records.delete(id);
  }
  async exists(id: string) {
    return this.records.has(id);
  }
  async lastSession() {
    return this.pointer ? { id: this.pointer, updatedAt: "" } : null;
  }
  async setLastSession(id: string) {
    this.pointer = id;
  }
}

describe("SessionManager：快照 / 存档 / 续接", () => {
  let store: MemoryStore;
  let withStore: SessionManager;

  beforeEach(() => {
    store = new MemoryStore();
    withStore = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_fixed",
      storeFor: () => store,
    });
  });

  it("snapshot 一次给出消息 / 阶段 / 轮次 / 用量（客户端不必自己攒事件）", async () => {
    await withStore.create({ workspaceId: "ws-1", path: "/p" });
    agent.messages.push({ role: "user", content: "你好" });
    agent.lastUsage = { promptTokens: 3, completionTokens: 5 };
    withStore.send("chat_fixed", "你好");

    const snapshot = await withStore.snapshot("chat_fixed");
    expect(snapshot).toMatchObject({
      sessionId: "chat_fixed",
      workspaceId: "ws-1",
      agentId: "default",
      turnId: 1,
      phase: { kind: "connecting" },
      messages: [{ role: "user", content: "你好" }],
      lastUsage: { promptTokens: 3, completionTokens: 5 },
    });
  });

  it("save 把当前消息写进工作区存档，并把「上一轮会话」指过去", async () => {
    await withStore.create({ workspaceId: "ws-1", path: "/p" });
    agent.messages.push({ role: "user", content: "留档" });

    expect(await withStore.save("chat_fixed")).toEqual({ saved: true, sessionId: "chat_fixed" });
    expect(store.records.get("chat_fixed")).toEqual({
      id: "chat_fixed",
      agentId: "default",
      messages: [{ role: "user", content: "留档" }],
    });
    expect((await store.lastSession())?.id).toBe("chat_fixed");
  });

  it("续接：id 在工作区存档里存在时，Agent 直接带着那份消息起来", async () => {
    await store.write({
      id: "chat_old",
      agentId: "default",
      messages: [{ role: "user", content: "上次聊到这儿" }] as never,
    });

    await withStore.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_old" });
    expect(agent.messages).toEqual([{ role: "user", content: "上次聊到这儿" }]);
  });

  it("没有存档时开同 id：不报错，就当新会话（空消息）", async () => {
    await withStore.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_new" });
    expect(agent.messages).toEqual([]);
  });

  it("没注入存档：save 明确报 no-store（而不是假装存了）", async () => {
    await manager.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_x" });
    await expect(manager.save("chat_x")).rejects.toThrow(/no session store/);
  });
});

describe("SessionManager：存档列表与撤回", () => {
  let store: MemoryStore;
  let withStore: SessionManager;

  beforeEach(() => {
    store = new MemoryStore();
    withStore = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_fixed",
      storeFor: () => store,
    });
  });

  it("listSaved 只列盘上的存档（活着的会话不等于已存档）", async () => {
    await store.write({ id: "chat_old", agentId: "default", messages: [] });
    await withStore.create({ workspaceId: "ws-1", path: "/p" });
    await withStore.save("chat_fixed");

    expect((await withStore.listSaved("ws-1")).map((ref) => ref.id)).toEqual(["chat_old", "chat_fixed"]);
  });

  it("撤回：从 index 起删掉、立即落盘、指针跟着走", async () => {
    await withStore.create({ workspaceId: "ws-1", path: "/p" });
    agent.messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: "答" },
      { role: "user", content: "第二个问题" },
      { role: "assistant", content: "答2" },
    ];

    const result = await withStore.rollback("chat_fixed", 3);

    expect(result.removed).toBe(2);
    expect(result.prompt).toBe("第二个问题");
    expect(result.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "第一个问题" },
      { role: "assistant", content: "答" },
    ]);
    // 内存与存档一致：被撤回的不会在下次 /load 里“复活”
    expect(agent.messages).toHaveLength(3);
    expect(store.records.get("chat_fixed")!.messages).toHaveLength(3);
    expect((await store.lastSession())?.id).toBe("chat_fixed");
  });

  it("下标越界 → bad-index，且消息一条都不动", async () => {
    await withStore.create({ workspaceId: "ws-1", path: "/p" });
    agent.messages = [{ role: "user", content: "只有一条" }];

    await expect(withStore.rollback("chat_fixed", 5)).rejects.toThrow(/out of range/);
    await expect(withStore.rollback("chat_fixed", -1)).rejects.toThrow(/out of range/);
    expect(agent.messages).toHaveLength(1);
  });

  it("没有存档时不改内存（避免“改了一半存不下去”）", async () => {
    await manager.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_x" });
    agent.messages = [{ role: "user", content: "a" }, { role: "user", content: "b" }];

    await expect(manager.rollback("chat_x", 1)).rejects.toThrow(/no session store/);
    expect(agent.messages).toHaveLength(2);
  });
});

describe("SessionManager：上一轮会话指针（session.last）", () => {
  let store: MemoryStore;
  let withStore: SessionManager;

  beforeEach(() => {
    store = new MemoryStore();
    withStore = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_fixed",
      storeFor: () => store,
    });
  });

  it("没有指针 → 空 id（客户端据此走新会话）", async () => {
    expect(await withStore.last("ws-1")).toEqual({ sessionId: null });
  });

  it("存档把指针指过去之后，只回 id（agentId 由 create 从存档里取，不在这里回第二份）", async () => {
    await withStore.create({ workspaceId: "ws-1", path: "/p" });
    await withStore.save("chat_fixed");

    expect(await withStore.last("ws-1")).toEqual({ sessionId: "chat_fixed" });
  });

  it("指针跟着最新的存档走（另存为之后指向新 id）", async () => {
    await withStore.create({ workspaceId: "ws-1", path: "/p" });
    await withStore.saveAs("chat_fixed", "chat_renamed");

    expect(await withStore.last("ws-1")).toEqual({ sessionId: "chat_renamed" });
  });

  it("指针指向的存档已被删 → 回 null（宁可开新会话，也不能把客户端领进一段空会话）", async () => {
    // 这条必须用**真存盘**：要证的正是「指针文件还在、它指着的那份存档没了」；
    // 内存存档的 remove 只是从一个 Map 里删键，证明不了指针会过期。
    const root = await fs.mkdtemp(join(tmpdir(), "aiz-last-pointer-"));
    const store = new FileSessionStore({ rootDir: root });
    const diskManager = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_disk",
      storeFor: () => store,
    });
    try {
      await diskManager.create({ workspaceId: "ws-1", path: "/p" });
      await diskManager.save("chat_disk");
      expect(await diskManager.last("ws-1")).toEqual({ sessionId: "chat_disk" });

      // 模拟「用户在别处 /save 改名 / 手删了文件」：存档没了，指针还指着那个 id
      await fs.rm(join(root, "sessions", "chat_disk.json"));
      expect((await store.lastSession())?.id).toBe("chat_disk");

      // 回 null 而不是这个 id：客户端会去 create，而 create 对缺失存档是静默开空会话
      expect(await diskManager.last("ws-1")).toEqual({ sessionId: null });
    } finally {
      diskManager.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("没注入存档：明确报 no-store（不假装这个工作区没有上一轮）", async () => {
    await expect(manager.last("ws-1")).rejects.toThrow(/no session store/);
  });
});

describe("SessionManager：reload（按新配置重建 Agent，保留消息）", () => {
  it("保留消息、重建 Agent、并让装配方丢掉旧 Scope", async () => {
    const invalidated: string[] = [];
    const agents: FakeAgent[] = [];
    const reloadable = new SessionManager({
      createAgent: async () => {
        const fresh = new FakeAgent();
        agents.push(fresh);
        return fresh;
      },
      nextSessionId: () => "chat_fixed",
      invalidateScope: async (workspacePath) => {
        invalidated.push(workspacePath);
      },
    });

    const captured: ServerEvent[] = [];
    reloadable.subscribe((event) => captured.push(event));

    await reloadable.create({ workspaceId: "ws-1", path: "/work/proj" });
    agents[0]!.messages = [{ role: "user", content: "上下文要留住" }];

    const snapshot = await reloadable.reload("chat_fixed");

    expect(agents).toHaveLength(2); // 真的重建了
    expect(invalidated).toEqual(["/work/proj"]); // 旧 Scope 被丢掉（配置可能已变）
    expect(snapshot.messages).toEqual([{ role: "user", content: "上下文要留住" }]);
    // 旧 Agent 的事件已摘掉，新 Agent 的事件接上了
    expect(agents[0]!.handlerCount()).toBe(0);
    agents[1]!.fire("open");
    expect(captured.at(-1)).toMatchObject({ event: "session.phase", phase: { kind: "queued" } });
  });
});

describe("SessionManager：通知（两个通道）", () => {
  it("notice 发的是**对话内**通知：带 sessionId，绑在那段会话上", async () => {
    const { sessionId } = await create();
    manager.notice(sessionId, { level: "error", code: "persistFailed", params: { error: "磁盘满" } });

    expect(pick("session.notice")).toEqual([
      {
        event: "session.notice",
        sessionId,
        level: "error",
        code: "persistFailed",
        params: { error: "磁盘满" },
      },
    ]);
  });

  it("会话不存在时不发（否则客户端收到一条没有归属的通知）", () => {
    expect(() => manager.notice("chat_404", { level: "info", code: "handoffPath" })).toThrow(
      /unknown session/,
    );
    expect(pick("session.notice")).toEqual([]);
  });

  it("全局通知走同一个 hub，不带 sessionId（不归属于任何会话）", () => {
    const hub = new EventHub();
    const withHub = new SessionManager({ createAgent: async () => agent, hub });
    const mine: ServerEvent[] = [];
    withHub.subscribe((event) => mine.push(event));

    hub.publish({ event: "global.notice", level: "warn", code: "mcpUnavailable" });

    expect(mine).toEqual([{ event: "global.notice", level: "warn", code: "mcpUnavailable" }]);
  });
});

describe("SessionManager：交接 / 迁移", () => {
  let store: MemoryStore;
  let workspace: string;
  let handoffManager: SessionManager;

  beforeEach(async () => {
    store = new MemoryStore();
    workspace = await fs.mkdtemp(join(tmpdir(), "aiz-session-migrate-"));
    handoffManager = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => `chat_${++sessionCounter}`,
      storeFor: () => store,
      // 交接要读磁盘上的 `handoff` Skill、写 `<工作区>/.ai-zen/handoffs`
      handoff: { aiZenDir: join(workspace, "ai-zen"), homeDir: join(workspace, "home") },
    });
    events = [];
    sessionCounter = 0;
    handoffManager.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  /** 开一个「已经聊过两轮」的会话（交接要求会话里有真实对话） */
  const openChatted = async () => {
    const { sessionId } = await handoffManager.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [
      { role: "user", content: "旧任务" },
      { role: "assistant", content: "旧答复" },
    ];
    return sessionId;
  };

  it("handoff：只写文档，不换 id、不剔历史；交接回合本身照常落盘", async () => {
    const sessionId = await openChatted();
    const before = [...agent.messages];

    const result = await handoffManager.handoff(sessionId);

    expect(result.sessionId).toBe(sessionId); // 不换 id
    expect(existsSync(result.handoffPath)).toBe(true);
    expect(result.handoffPath.startsWith(join(workspace, ".ai-zen", "handoffs"))).toBe(true);
    expect(agent.messages).toEqual(before); // 摘要模式不碰消息
    // 交接回合（指令 + 回执）留在会话里，而「每轮 turn.end 前落盘」对它同样成立：
    // 用户 `/handoff` 完直接退出，回来时这一段必须在存档里（旧版由
    // `ConversationPersistPlugin.onInnerLoopEnd` 承担同一件事）。
    expect([...store.records.keys()]).toEqual([sessionId]);
  });

  it("每轮收尾自动落盘：`turn.end` 之前写进存档，并把「本工作区上一轮」指过去", async () => {
    const { sessionId } = await handoffManager.create({ workspaceId: "ws-1", path: workspace });
    handoffManager.send(sessionId, "第一句");
    agent.messages = [
      { role: "user", content: "第一句" },
      { role: "assistant", content: "答" },
    ];
    agent.fire("finally");
    await settled();

    // 这条就是「聊完退出、再 `ai` 接着上次」的全部机制：没有它，`session.last` 永远是空。
    expect(store.records.get(sessionId)!.messages).toHaveLength(2);
    expect(await store.lastSession()).toMatchObject({ id: sessionId });
  });

  it("空会话不落盘：`/load` 列表里不该出现一串空会话", async () => {
    const { sessionId } = await handoffManager.create({ workspaceId: "ws-1", path: workspace });
    handoffManager.send(sessionId, "hi"); // 只有 system 消息，没有用户消息
    agent.fire("finally");
    await settled();

    expect(store.records.size).toBe(0);
  });

  it("persist:false 的一次性会话：跑完不留存档、也不篡改「上次聊到哪儿」", async () => {
    const { sessionId } = await handoffManager.create({
      workspaceId: "ws-1",
      path: workspace,
      persist: false,
    });
    handoffManager.send(sessionId, "脚本里问一句");
    agent.messages = [
      { role: "user", content: "脚本里问一句" },
      { role: "assistant", content: "答" },
    ];
    agent.fire("finally");
    await settled();

    // `ai "…"` 的全部要求：这一轮确实跑完了（`turn.end` 已发），但工作区里什么都没变
    expect(events.some((event) => event.event === "turn.end")).toBe(true);
    expect(store.records.size).toBe(0);
    expect(await store.lastSession()).toBeNull();
  });

  it("persist:false 仍可显式归档；`setAsLast:false` 只写档、不挪指针", async () => {
    const { sessionId } = await handoffManager.create({
      workspaceId: "ws-1",
      path: workspace,
      persist: false,
    });
    agent.messages = [{ role: "user", content: "留一份" }];

    await handoffManager.save(sessionId, { setAsLast: false });

    // 存档在（`ai --save` 要能事后翻看），但下次 `ai` 不该续接到它上面
    expect(store.records.get(sessionId)!.messages).toHaveLength(1);
    expect(await store.lastSession()).toBeNull();
  });

  it("save 缺省仍然把指针挪过去（TUI 的 `/save`）", async () => {
    const { sessionId } = await handoffManager.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "留档" }];

    await handoffManager.save(sessionId);

    expect((await store.lastSession())?.id).toBe(sessionId);
  });

  it("migrate：先存旧会话、再剔历史、最后换 id（收尾发在旧 id 上）", async () => {
    const sessionId = await openChatted();

    const result = await handoffManager.migrate(sessionId);

    // 新会话：id 变了，轮次从 0 起（这一轮的收尾已在换 id 之前发过）
    expect(result.sessionId).not.toBe(sessionId);
    expect(handoffManager.list("ws-1")).toEqual([
      {
        sessionId: result.sessionId,
        workspaceId: "ws-1",
        agentId: "default",
        turnId: 1,
        phase: null,
        // 新会话缺省在保活区里（与新建会话同一条规则）
        keepAlive: true,
      },
    ]);
    // 旧 id 已退场
    expect(handoffManager.list("ws-1").map((item) => item.sessionId)).not.toContain(sessionId);

    // 旧会话进了存档（含完整历史：prune 之前存下去的）
    expect(store.records.get(sessionId)!.messages).toEqual([
      { role: "user", content: "旧任务" },
      { role: "assistant", content: "旧答复" },
    ]);
    // 新会话也立即落盘了：模板 + 交接断点，指针指过去
    expect(store.records.get(result.sessionId)!.messages).toEqual(agent.messages);
    expect((await store.lastSession())!.id).toBe(result.sessionId);

    // 收尾事件的 sessionId 是**旧** id：客户端先看到那一轮结束，再从响应里拿到新 id
    const end = pick("turn.end").at(-1)!;
    expect(end).toMatchObject({ sessionId, ok: true });
  });

  it("迁移的进度是 `session.notice`：存档 / 写文档 / 文档路径（都不带文案）", async () => {
    const sessionId = await openChatted();

    await handoffManager.migrate(sessionId);

    const notices = pick("session.notice");
    expect(notices.map((notice) => notice.code)).toEqual([
      "handoffArchived",
      "handoffWriting",
      "migrationDegraded", // 假 Agent 无 write 工具 → 摘要模式，服务端如实报降级
      "handoffPath",
      // 迁移落地后的两条（与旧版逐字一致：一条「完成 + 条数」，一条「新助手会先读文档」）
      "handoffMigrated",
      "handoffMigratedHint",
    ]);
    expect(notices[0]!.params).toEqual({ sessionId }); // 存档的是**旧**会话
  });

  it("一轮还在跑时交接：报 turn-in-flight（两条链路同用一个 turnId 就没法归轮了）", async () => {
    const sessionId = await openChatted();
    agent.holdSend = new Promise<void>(() => {}); // 这一轮永不结束
    handoffManager.send(sessionId, "跑着");

    await expect(handoffManager.handoff(sessionId)).rejects.toThrow(/turn in flight/);
    await expect(handoffManager.migrate(sessionId)).rejects.toThrow(/turn in flight/);
  });

  it("没有用户消息的会话不给交接：报 nothing-to-handoff（不白烧一次模型调用）", async () => {
    const { sessionId } = await handoffManager.create({ workspaceId: "ws-1", path: workspace });

    await expect(handoffManager.handoff(sessionId)).rejects.toThrow(/no user message/);
  });

  it("交接进行中不接受新一轮 send：报 handoff-in-flight", async () => {
    const sessionId = await openChatted();
    agent.client = hangingSummary();

    const pending = handoffManager.handoff(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 0)); // 跑到「等模型」那一步

    expect(() => handoffManager.send(sessionId, "插一条")).toThrow(/is handing off/);
    handoffManager.cancel(sessionId);
    await expect(pending).rejects.toThrow(/handoff cancelled/);
  });

  it("cancel 真的能掐断交接：报 handoff-aborted + turnAborted 通知，会话留在旧 id 上", async () => {
    const sessionId = await openChatted();
    agent.client = hangingSummary();

    const pending = handoffManager.migrate(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 0)); // 跑到「等模型」那一步
    handoffManager.cancel(sessionId);

    await expect(pending).rejects.toMatchObject({ code: "handoff-aborted" });
    // 取消不是失败：本轮以 ok:false 收尾，另有一条「已取消」的对话内通知
    expect(pick("turn.end").at(-1)).toMatchObject({ sessionId, ok: false, error: { code: "aborted" } });
    expect(pick("session.notice").map((notice) => notice.code)).toContain("turnAborted");
    // 迁移没做成：会话还在旧 id 上（旧会话已存档，但历史没被剔除）
    expect(handoffManager.list("ws-1").map((item) => item.sessionId)).toEqual([sessionId]);
    expect(agent.messages).toHaveLength(2);
  });

  it("迁移必须有存档：没注入 store 就明确报 no-store，且一条消息都不动", async () => {
    const { sessionId } = await manager.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "任务" }];

    await expect(manager.migrate(sessionId)).rejects.toThrow(/no session store/);
    expect(agent.messages).toEqual([{ role: "user", content: "任务" }]);
  });

  it("服务器没配交接路径：报 no-handoff（不自己猜 Skill 在哪）", async () => {
    const { sessionId } = await manager.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "任务" }];

    await expect(manager.handoff(sessionId)).rejects.toThrow(/handoff is not configured/);
  });
});

describe("SessionManager：另存为（/save <名字>）", () => {
  let store: MemoryStore;
  let saveManager: SessionManager;

  beforeEach(() => {
    store = new MemoryStore();
    saveManager = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_next",
      storeFor: () => store,
    });
  });

  it("写新档、删旧档、活会话换键，但 turnId 不动（这是同一段对话）", async () => {
    await saveManager.create({ workspaceId: "ws-1", path: "/p" });
    agent.messages = [{ role: "user", content: "留档" }];
    saveManager.send("chat_next", "留档");
    agent.fire("open");
    agent.fire("finally");
    await settled();

    const result = await saveManager.saveAs("chat_next", "chat_debug_login");

    expect(result).toEqual({ saved: true, sessionId: "chat_debug_login" });
    expect(store.records.has("chat_next")).toBe(false); // 旧档不留：/load 里分不清哪条是新的
    expect(store.records.get("chat_debug_login")!.messages).toEqual([
      { role: "user", content: "留档" },
    ]);
    expect((await store.lastSession())!.id).toBe("chat_debug_login");
    // 同一段对话换个名字：轮次编号不清零
    expect(saveManager.list("ws-1")).toEqual([
      {
        sessionId: "chat_debug_login",
        workspaceId: "ws-1",
        agentId: "default",
        turnId: 1,
        phase: null,
        keepAlive: true,
      },
    ]);
  });

  it("目标 id 已被另一段活会话占着：报 session-exists，旧档不动", async () => {
    await saveManager.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_a" });
    await saveManager.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_b" });

    await expect(saveManager.saveAs("chat_a", "chat_b")).rejects.toThrow(/already exists/);
    expect(saveManager.list("ws-1").map((item) => item.sessionId)).toEqual(["chat_a", "chat_b"]);
    expect(store.records.size).toBe(0);
  });

  it("快照带上 Agent 绑定的模型 id 与实发模型名（客户端拼图片内容块要用后者反查端点）", async () => {
    await saveManager.create({ workspaceId: "ws-1", path: "/p" });
    (agent as unknown as { definition: { modelId?: string } }).definition.modelId = "test-model";
    (agent as unknown as { model?: string }).model = "vendor/test-model-v2";

    const snapshot = await saveManager.snapshot("chat_next");
    expect(snapshot.modelId).toBe("test-model");
    // 配了别名时两者不同；客户端不能拿 modelId 当 apiModel 用
    expect(snapshot.apiModel).toBe("vendor/test-model-v2");
  });
});

describe("SessionManager：续接时 Agent 也跟着存档走（/load 只给 id）", () => {
  it("不传 agentId 时沿用存档里记的那个，而不是默默换成 default", async () => {
    const store = new MemoryStore();
    await store.write({
      id: "chat_coder",
      agentId: "coder",
      messages: [{ role: "user", content: "上次是 coder 跑的" }] as never,
    });
    const seen: unknown[] = [];
    const resuming = new SessionManager({
      createAgent: async (input) => {
        seen.push(input);
        return agent;
      },
      storeFor: () => store,
    });

    const created = await resuming.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_coder" });

    expect(created.agentId).toBe("coder");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ workspaceId: "ws-1", path: "/p", agentId: "coder" });
  });

  it("显式传了就听调用方的（新会话没存档时仍回 default）", async () => {
    const seen: string[] = [];
    let counter = 0;
    const fresh = new SessionManager({
      createAgent: async (input) => {
        seen.push(input.agentId);
        return agent;
      },
      nextSessionId: () => `chat_${++counter}`,
    });

    await fresh.create({ workspaceId: "ws-1", path: "/p", agentId: "coder" });
    await fresh.create({ workspaceId: "ws-1", path: "/p2" });
    expect(seen).toEqual(["coder", "default"]);
  });
});

describe("SessionManager：自动迁移（SDK 插件在一轮内部触发）", () => {
  let store: MemoryStore;
  let workspace: string;
  let hook: (() => Promise<void>) | undefined;
  let auto: SessionManager;
  let counter = 0;

  beforeEach(async () => {
    store = new MemoryStore();
    workspace = await fs.mkdtemp(join(tmpdir(), "aiz-auto-migrate-"));
    counter = 0;
    hook = undefined;
    auto = new SessionManager({
      // 装配方拿到的那两个钩子就是会话层提供的：这里把 autoMigrate 留存下来直接调
      createAgent: async (input) => {
        hook = input.autoMigrate;
        return agent;
      },
      nextSessionId: () => `chat_${++counter}`,
      storeFor: () => store,
      handoff: { aiZenDir: join(workspace, "ai-zen"), homeDir: workspace },
    });
    events = [];
    auto.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("落地动作：先存旧会话 → 剔历史 → 换 id → 发 session.idChanged", async () => {
    const { sessionId } = await auto.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    await hook!();

    // 旧会话进存档（prune 之前的完整历史）
    expect(store.records.get(sessionId)!.messages).toEqual([{ role: "user", content: "旧任务" }]);
    // 活会话换键，新会话里只剩「模板 + 交接断点」
    const live = auto.list("ws-1");
    expect(live.map((item) => item.sessionId)).toEqual(["chat_2"]);
    expect(JSON.stringify(store.records.get("chat_2")!.messages)).not.toContain("旧任务");
    // 客户端没有响应可接：换 id 只能靠事件
    expect(pick("session.idChanged")).toEqual([
      { event: "session.idChanged", from: sessionId, sessionId: "chat_2" },
    ]);
  });

  it("迁移进行中再次触发：让行（并发两次只迁一次）", async () => {
    await auto.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    await Promise.all([hook!(), hook!()]);

    expect(pick("session.idChanged")).toHaveLength(1);
    expect(auto.list("ws-1")).toHaveLength(1);
  });

  it("没配存档：报 no-store（prune 之后历史只剩存档一份，存不下去就别动手）", async () => {
    let bareHook: (() => Promise<void>) | undefined;
    const bare = new SessionManager({
      createAgent: async (input) => {
        bareHook = input.autoMigrate;
        return agent;
      },
    });
    await bare.create({ workspaceId: "ws-1", path: "/p" });

    await expect(bareHook!()).rejects.toThrow(/no session store|not configured/);
  });
});

/**
 * 录事件的 hub：即使**一个订阅者都没有**也把事件记下来。
 *
 * 为什么非得要它：「没人在看时不提问」这条靠普通订阅是测不出来的 —— 一订上，
 * `watcherCount()` 就不是 0 了。本类只多记一份，**不改** `watcherCount()` 的语义
 * （那正是被测的东西）。
 */
class RecordingHub extends EventHub {
  readonly published: ServerEvent[] = [];

  publish(event: ServerEvent): void {
    this.published.push(event);
    super.publish(event);
  }
}

describe("SessionManager：自动迁移用哪种方式交接，由客户端回答（session.question）", () => {
  /** 装配方收到的两个钩子 —— 就是「SDK 插件 → 会话层」那条路的两端 */
  interface Hooks {
    autoMigrate?: (mode?: HandoffMode) => Promise<void>;
    resolveMode?: (info: { promptTokens: number; handoffTokens: number }) => Promise<HandoffMode | null>;
  }

  let store: MemoryStore;
  let workspace: string;
  let hub: RecordingHub;
  let hooks: Hooks;
  let auto: SessionManager;
  /** 用例里另外造的管理器：统一在 afterEach 收掉 */
  let extras: SessionManager[];
  let counter = 0;

  /**
   * 造一个把两个钩子收起来的会话层。
   *
   * `hub` 决定「有没有客户端在看」，`askTimeoutMs` 是超时（用例不能等 5 分钟）。
   */
  function assemble(options: { hub?: EventHub; askTimeoutMs?: number } = {}) {
    const captured: Hooks = {};
    const manager = new SessionManager({
      createAgent: async (input) => {
        captured.autoMigrate = input.autoMigrate;
        captured.resolveMode = input.resolveMode;
        return agent;
      },
      nextSessionId: () => `chat_${++counter}`,
      storeFor: () => store,
      handoff: { aiZenDir: join(workspace, "ai-zen"), homeDir: workspace },
      ...options,
    });
    return { manager, hooks: captured };
  }

  /**
   * 走一遍 SDK 插件 `onAfterSend` 的那两步：先问「用哪种方式交接」，用户选不交接
   * （`null`）就直接返回，否则才让会话层动手迁移。
   *
   * 为什么直接调这两个钩子而不是装上真的 `AutoMigratePlugin`：这里测的是会话层
   * 「怎么问、怎么等、怎么认领」，插件本身的触发时机不在本用例的范围内（那边由
   * `SessionAgentFactory.test.ts` 用真插件测）。
   */
  async function triggerAutoMigrate(
    target: Hooks,
    info = { promptTokens: 999, handoffTokens: 500 },
  ): Promise<void> {
    const mode = await target.resolveMode!(info);
    if (mode === null) return;
    await target.autoMigrate!(mode);
  }

  beforeEach(async () => {
    store = new MemoryStore();
    workspace = await fs.mkdtemp(join(tmpdir(), "aiz-ask-mode-"));
    counter = 0;
    extras = [];
    hub = new RecordingHub();
    const assembled = assemble({ hub });
    auto = assembled.manager;
    hooks = assembled.hooks;
    // 模拟「有客户端在看」：订阅了才谈得上向客户端提问
    events = [];
    auto.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    for (const manager of extras) manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("有客户端在看：触发时先问「用哪种方式交接」，带上触发上下文（两个 token 数）", async () => {
    const { sessionId } = await auto.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = triggerAutoMigrate(hooks);

    const questions = pick("session.question");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      event: "session.question",
      sessionId,
      kind: "handoff-mode",
      // 能怎么答：两个选项 + 允许「不交接」
      input: "select",
      options: ["self", "summary"],
      allowSkip: true,
      // 兜底是「什么都不做」：没人答就跳过这次迁移（不是替用户选 self）
      fallback: null,
      // 选择器的标题要显示「已用 X / 上限 Y」：这两个数只有服务端手里有
      params: { promptTokens: 999, handoffTokens: 500 },
    });
    expect(questions[0].questionId).toMatch(/^q-\d+$/);

    // 不回答的话这一轮就悬着（并占用迁移的并发闸门）：用例自己把它收掉
    expect(auto.answer(sessionId, questions[0].questionId, "self")).toEqual({ answered: true });
    await pending;
  });

  it("回答 summary：交接那条路径收到的就是 summary，同一个问题不能再答一次", async () => {
    const { sessionId } = await auto.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = triggerAutoMigrate(hooks);
    const question = pick("session.question")[0];

    expect(auto.answer(sessionId, question.questionId, "summary")).toEqual({ answered: true });
    // 同一个 questionId 再答一次：来晚了 —— 不抛错、也不用重试（服务端已经继续跑了）
    expect(auto.answer(sessionId, question.questionId, "self")).toEqual({ answered: false });
    await pending;

    // 交接服务收到的「请求执行者」就是用户选的那个：请求 self 时会降级到 summary 并多一条
    // `migrationDegraded`，这里没有 —— 说明请求的本来就是 summary，不是默认值碰巧一样
    const notices = pick("session.notice");
    expect(notices.filter((notice) => notice.code === "handoffWriting").map((notice) => notice.params)).toEqual([
      { mode: "summary" },
    ]);
    expect(notices.some((notice) => notice.code === "migrationDegraded")).toBe(false);
    // 迁移真的发生了（换 id 走事件）
    expect(pick("session.idChanged")).toHaveLength(1);
  });

  it("回答 null（用户选「不交接」）：跳过本次迁移 —— 会话 id 不变，也没有 idChanged", async () => {
    const { sessionId } = await auto.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = triggerAutoMigrate(hooks);
    const question = pick("session.question")[0];
    expect(auto.answer(sessionId, question.questionId, null)).toEqual({ answered: true });
    await pending;

    expect(pick("session.idChanged")).toEqual([]);
    expect(auto.list("ws-1").map((item) => item.sessionId)).toEqual([sessionId]);
    // 什么都没发生：连旧会话都没进存档（那是迁移的第一步）
    expect(store.records.size).toBe(0);
  });

  it("没有客户端在看：不问，按兜底「什么都不做」跳过迁移（说一句 migrationSkipped）", async () => {
    // 独立的一套：hub 上一个订阅者都没有 —— 客户端已退出，而会话仍在服务端活着
    const silentHub = new RecordingHub();
    const silent = assemble({ hub: silentHub, askTimeoutMs: 30_000 });
    extras.push(silent.manager);
    const { sessionId } = await silent.manager.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    // 全程没人回答却能跑完：若真问了，这一句会挂到 30 秒超时（用例先超时失败）
    await triggerAutoMigrate(silent.hooks);

    expect(silentHub.watcherCount()).toBe(0);
    expect(silentHub.published.filter((event) => event.event === "session.question")).toEqual([]);
    const notices = silentHub.published.filter(
      (event): event is Extract<ServerEvent, { event: "session.notice" }> => event.event === "session.notice",
    );
    // 兜底 = 什么都不做：**不迁移**（旧版这里的默认是 self 自动迁移，按产品决定改掉了）
    expect(notices.some((notice) => notice.code === "handoffWriting")).toBe(false);
    expect(notices.some((notice) => notice.code === "migrationSkipped")).toBe(true);
    expect(silentHub.published.filter((event) => event.event === "session.idChanged")).toHaveLength(0);
    // 会话原封不动
    expect(silent.manager.list("ws-1").map((item) => item.sessionId)).toEqual([sessionId]);
  });

  it("没人回答（超时）：按兜底跳过迁移，并把挂着的提问清掉", async () => {
    // 超时注入成 10ms：等 5 分钟才能验证的用例只能靠 sleep(300000)，那是把「超时」测成「时钟」
    const fastHub = new RecordingHub();
    fastHub.subscribe((event) => events.push(event));
    const fast = assemble({ hub: fastHub, askTimeoutMs: 10 });
    extras.push(fast.manager);
    await fast.manager.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = triggerAutoMigrate(fast.hooks);
    const question = pick("session.question")[0];

    await pending; // 不回答：等它自己按超时收场

    const notices = pick("session.notice");
    // 超时与「没人在看」同一个落点：兜底 = 什么都不做
    expect(notices.some((notice) => notice.code === "handoffWriting")).toBe(false);
    expect(notices.some((notice) => notice.code === "migrationSkipped")).toBe(true);
    expect(pick("session.idChanged")).toHaveLength(0);
    // 表已清：这个问题现在谁也答不了（迟到的回答只能是「来晚了」）
    const remaining = fast.manager.list("ws-1")[0]!.sessionId;
    expect(fast.manager.answer(remaining, question.questionId, "summary")).toEqual({
      answered: false,
    });
  });

  it("answer 一个不存在的会话：unknown-session（拿错 id 是调用方的错，不是「来晚了」）", () => {
    expect(() => auto.answer("sess_404", "q-1", "self")).toThrow(/unknown session/);
    try {
      auto.answer("sess_404", "q-1", "self");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("unknown-session");
    }
  });
});

describe("SessionManager：attach（会话活得比连接久）", () => {
  it("接一个还活着的会话：返回同一个 id / agentId，不另装一个 Agent", async () => {
    let created = 0;
    const m = new SessionManager({
      createAgent: async () => {
        created++;
        return agent;
      },
      nextSessionId: () => `chat_${++sessionCounter}`,
    });
    const first = await m.create({ workspaceId: "ws-1", path: "/work/proj", sessionId: "chat_keep" });

    // 客户端退出只退订阅，会话仍在服务端活着 —— 「接着上次」走的就是这条
    const again = await m.attach({ workspaceId: "ws-1", path: "/work/proj", sessionId: "chat_keep" });

    expect(again).toEqual({ sessionId: "chat_keep", agentId: first.agentId });
    expect(created).toBe(1); // 没有再装配一套 Agent（那会多一套 MCP 连接与工具发现）
    expect(m.list("ws-1")).toHaveLength(1);
  });

  it("接一个活着的会话：消息仍是它当前的，不被存档覆盖", async () => {
    const store = new FileSessionStore({ rootDir: tempRoot("aiz-attach") });
    const m = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => `chat_${++sessionCounter}`,
      storeFor: () => store,
    });
    const first = await m.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_live" });
    agent.messages = [{ role: "user", content: "当前对话" }];
    // 存档里是**旧**内容（上次落盘时的样子）
    await store.write({ id: "chat_live", agentId: "default", messages: [{ role: "user", content: "旧" }] });

    await m.attach({ workspaceId: "ws-1", path: "/p", sessionId: first.sessionId });

    expect(agent.messages).toEqual([{ role: "user", content: "当前对话" }]);
  });

  it("接一段只在盘上的会话：从存档装配 Agent 并装回消息", async () => {
    const store = new FileSessionStore({ rootDir: tempRoot("aiz-attach2") });
    const m = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => `chat_${++sessionCounter}`,
      storeFor: () => store,
    });
    await store.write({ id: "chat_disk", agentId: "reviewer", messages: [{ role: "user", content: "旧对话" }] });

    const attached = await m.attach({ workspaceId: "ws-1", path: "/p", sessionId: "chat_disk" });

    expect(attached).toMatchObject({ sessionId: "chat_disk", agentId: "reviewer" });
    expect(agent.messages).toEqual([{ role: "user", content: "旧对话" }]);
  });

  it("内存和盘上都没有这个 id：报 session-missing（绝不悄悄开一段空的）", async () => {
    const store = new FileSessionStore({ rootDir: tempRoot("aiz-attach3") });
    const m = new SessionManager({ createAgent: async () => agent, storeFor: () => store });

    await expect(m.attach({ workspaceId: "ws-1", path: "/p", sessionId: "chat_gone" })).rejects.toThrow(
      /session-missing|no such session/,
    );
  });

  it("自动分配的 id 撞车：换一个后缀（同一秒开两段是常态，不是错误）", async () => {
    // 生成器恒回同一个 id：第二次必须自己找空位，而不是把用户挡在门外
    const m = new SessionManager({ createAgent: async () => agent, nextSessionId: () => "chat_same" });
    const first = await m.create({ workspaceId: "ws-1", path: "/p" });
    const second = await m.create({ workspaceId: "ws-1", path: "/p" });

    expect(first.sessionId).toBe("chat_same");
    expect(second.sessionId).toBe("chat_same_2");
    expect(m.list("ws-1")).toHaveLength(2);
  });

  it("自动分配的 id 撞上**盘上的**存档：也不覆盖，换一个", async () => {
    const store = new FileSessionStore({ rootDir: tempRoot("aiz-free") });
    await store.write({ id: "chat_same", agentId: "default", messages: [{ role: "user", content: "别人的对话" }] });
    const m = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_same",
      storeFor: () => store,
    });

    const created = await m.create({ workspaceId: "ws-1", path: "/p" });

    expect(created.sessionId).toBe("chat_same_2");
    // 旧存档原封不动
    expect((await store.read("chat_same"))?.messages).toEqual([{ role: "user", content: "别人的对话" }]);
  });
});

describe("SessionManager：保活区 / 换 Agent / 关闭", () => {
  let store: MemoryStore;
  let live: SessionManager;
  /** 每次 `createAgent` 收到的 agentId（换 Agent 时用它断言真的重建了） */
  let built: string[];

  beforeEach(() => {
    store = new MemoryStore();
    built = [];
    live = new SessionManager({
      createAgent: async (input) => {
        built.push(input.agentId);
        return agent;
      },
      nextSessionId: () => `chat_${++sessionCounter}`,
      storeFor: () => store,
    });
    events = [];
    live.subscribe((event) => events.push(event));
    sessionCounter = 0;
  });

  /** 跑完一轮（含用户消息）并等收尾真正落地 */
  const runTurn = async (sessionId: string, text = "问一句") => {
    live.send(sessionId, text);
    agent.messages = [
      { role: "user", content: text },
      { role: "assistant", content: "答" },
    ];
    agent.fire("finally");
    await settled();
  };

  it("新会话缺省在保活区：一轮跑完不会被收掉", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });

    await runTurn(sessionId);

    expect(live.list("ws-1").map((item) => item.sessionId)).toEqual([sessionId]);
    expect(live.list("ws-1")[0]!.keepAlive).toBe(true);
  });

  it("移出保活且空闲：当场回收（不用等下一次 turn.end），存档留着", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);

    expect(live.keepAliveSet(sessionId, false)).toEqual({ sessionId, keepAlive: false });

    // 活会话没了
    expect(live.list("ws-1")).toEqual([]);
    // 存档还在：`attach` 能把这段装回来（这一条就是「点回来内容不少」的依据）
    expect(store.records.get(sessionId)!.messages).toHaveLength(2);
  });

  it("一轮还在跑时移出保活：不打断它，turn.end 收尾时才回收", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });

    live.send(sessionId, "长任务");
    agent.messages = [{ role: "user", content: "长任务" }];
    live.keepAliveSet(sessionId, false);
    // 正在跑的一轮不能被收掉：那比多占几兆内存严重
    expect(live.list("ws-1").map((item) => item.sessionId)).toEqual([sessionId]);

    agent.messages.push({ role: "assistant", content: "答" });
    agent.fire("finally");
    await settled();

    expect(live.list("ws-1")).toEqual([]);
    expect(store.records.get(sessionId)).toBeDefined();
  });

  it("setAgent：换 Agent、保留消息、存档里的 agentId 跟着换、旧事件摘掉", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    const handlersBefore = agent.handlerCount();

    const snapshot = await live.setAgent(sessionId, "coder");

    expect(built).toEqual(["default", "coder"]);
    expect(snapshot.agentId).toBe("coder");
    expect(snapshot.messages).toHaveLength(2); // 消息一条不丢
    // 旧 Agent 的事件已摘掉、新的一份挂上了（与 reload 同一套）
    expect(agent.handlerCount()).toBe(handlersBefore);
    // 存档里的 agentId 必须跟上：不写的话下次 attach 会按旧 Agent 装回来
    expect(store.records.get(sessionId)!.agentId).toBe("coder");
    expect(live.list("ws-1")[0]!.agentId).toBe("coder");
  });

  it("setAgent：已经是这个 Agent 就不重建（重建只会丢掉工具发现的热状态）", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p", agentId: "coder" });

    await live.setAgent(sessionId, "coder");

    expect(built).toEqual(["coder"]);
  });

  it("setAgent：一轮在跑时拒绝（旧 Agent 正流着的增量会全丢在没人听的实例上）", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    live.send(sessionId, "跑着");

    await expect(live.setAgent(sessionId, "coder")).rejects.toMatchObject({ code: "turn-in-flight" });
    expect(built).toEqual(["default"]);
  });

  it("close：幂等、不删存档；未知会话回 false", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);

    expect(live.close(sessionId)).toBe(true);
    expect(live.close(sessionId)).toBe(false);
    expect(store.records.get(sessionId)!.messages).toHaveLength(2);
  });
});
