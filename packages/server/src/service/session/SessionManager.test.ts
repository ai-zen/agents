import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, type AgentLike } from "./SessionManager.js";
import type { SessionRecord, SessionStore } from "../store/SessionStore.js";
import type { ServerEvent } from "../../protocol/sessions.js";
import { EventHub } from "../events/EventHub.js";

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

  private readonly handlers = new Map<string, Set<(payload: any) => void>>();
  readonly events = {
    on: (event: string, handler: (payload: any) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (payload: any) => void) => {
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

  fire(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  handlerCount(): number {
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }
}

let agent: FakeAgent;
let manager: SessionManager;
let events: ServerEvent[];
let sessionCounter = 0;

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
    expect(seen).toEqual([{ workspaceId: "ws-9", path: "/p", agentId: "coder" }]);
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

describe("SessionManager：SDK 事件 → 协议事件", () => {
  it("六态按 SDK 时序推进：open → queued，正文 delta → streaming，parsed 收尾", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    expect(manager.list("ws-1")[0]!.phase).toEqual({ kind: "connecting" }); // send 当下就报出去了

    agent.fire("open");
    expect(manager.list("ws-1")[0]!.phase).toEqual({ kind: "queued" });

    agent.fire("chunk-parsed", chunk({ content: "你" }));
    expect(manager.list("ws-1")[0]!.phase).toEqual({ kind: "streaming" });

    agent.fire("parsed", { message: { role: "assistant", content: "你好" } });
    // 不带工具调用：状态机不改阶段，由 finally 归零
    agent.fire("finally");
    expect(manager.list("ws-1")[0]!.phase).toBeNull();
    expect(pick("turn.end").at(-1)!.ok).toBe(true);
  });

  it("正文与推理增量分别上报；只带 usage 的收尾 chunk 不发 delta", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    agent.fire("chunk-parsed", chunk({ reasoning_content: "想…" }));
    agent.fire("chunk-parsed", chunk({ content: "答案" }));
    agent.fire("chunk-parsed", { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 9 } });

    expect(pick("message.delta").map((e) => [e.text, e.reasoning])).toEqual([
      ["", "想…"],
      ["答案", ""],
      // 第三个 chunk 没有任何内容 → 不上报（否则客户端会收到一串空增量）
    ]);
  });

  it("本轮带工具调用：streamEnded 之后进 tool-waiting，并报出全部工具名", async () => {
    const { sessionId } = await create();
    manager.send(sessionId, "hi");

    agent.fire("chunk-parsed", chunk({ tool_calls: [{ index: 0, function: { name: "exec" } }] }));
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
    expect(() => manager.notice("chat_404", { level: "info", code: "toolFailed" })).toThrow(
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

  it("handoff：只写文档，id / 存档 / 历史都不动", async () => {
    const sessionId = await openChatted();
    const before = [...agent.messages];

    const result = await handoffManager.handoff(sessionId);

    expect(result.sessionId).toBe(sessionId); // 不换 id
    expect(existsSync(result.handoffPath)).toBe(true);
    expect(result.handoffPath.startsWith(join(workspace, ".ai-zen", "handoffs"))).toBe(true);
    expect(agent.messages).toEqual(before); // 摘要模式不碰消息
    expect(store.records.size).toBe(0); // 不存档（那是 /save 与 migrate 的事）
  });

  it("migrate：先存旧会话、再剔历史、最后换 id（收尾发在旧 id 上）", async () => {
    const sessionId = await openChatted();

    const result = await handoffManager.migrate(sessionId);

    // 新会话：id 变了，轮次从 0 起（这一轮的收尾已在换 id 之前发过）
    expect(result.sessionId).not.toBe(sessionId);
    expect(handoffManager.list("ws-1")).toEqual([
      { sessionId: result.sessionId, workspaceId: "ws-1", agentId: "default", turnId: 0, phase: null },
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
