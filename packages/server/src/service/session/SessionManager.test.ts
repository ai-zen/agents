import { beforeEach, describe, expect, it } from "vitest";
import { SessionManager, type AgentLike } from "./SessionManager.js";
import type { SessionEvent } from "../../protocol/sessions.js";

/**
 * 假 Agent —— 只实现会话管理器用到的那一小面（结构类型），
 * 事件由测试手动驱动，于是「SDK 的时序」在测试里是**可编程**的，不依赖网络与真实模型。
 */
class FakeAgent implements AgentLike {
  messages: any[] = [];
  sent: string[] = [];
  aborted = 0;
  /** 让 `send()` 挂住：用来证明 manager.send 不等一轮跑完 */
  holdSend: Promise<void> | null = null;

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
let events: SessionEvent[];
let sessionCounter = 0;

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
const pick = <T extends SessionEvent["event"]>(name: T) =>
  events.filter((event) => event.event === name) as Extract<SessionEvent, { event: T }>[];

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
    const mine: SessionEvent[] = [];
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
    const survivor: SessionEvent[] = [];
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
