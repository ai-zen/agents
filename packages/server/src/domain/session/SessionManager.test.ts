/**
 * 会话管理器自己的用例：注册表、持有者与回收、一轮的生命周期、目录、交接。
 *
 * 事件翻译（`EventBridge`）、存档读写（`Persistence`）、提问（`QuestionBroker`）的
 * 用例按归属搬到了各自旁边 —— 原来它们全压在 3600 行的这一个文件里，谁也不知道
 * 「改存档要跑哪几条」。
 *
 * 共用脚手架（假 Agent / 假存档 / 假时钟）在 `SessionTestSupport.ts`。
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, type CreateAgentInput } from "./SessionManager.js";
import { FileSessionStore } from "./store/FileSessionStore.js";
import type { Message, ServerEvent, SessionListEntry } from "../../protocol/index.js";
import type { AutoTitleRequest } from "./AutoTitle.js";
import { EventHub } from "../../lib/events.js";
import { resolveModel } from "@ai-zen/agents-sdk";
import {
  settled,
  fakeClock,
  FakeAgent,
  storedMessage,
  tempRoot,
  pick,
  hangingSummary,
  MemoryStore,
  create,
  agent,
  manager,
  events,
  counter,
  resetEvents,
  useSessionKit,
} from "./SessionTestSupport.js";

useSessionKit();

describe("SessionManager：会话生命周期", () => {
  it("create 之后能在 list 里看到它（id 递增、agentId 缺省 default）", async () => {
    const first = await create();
    const second = await manager.create({ workspaceId: "ws-1", path: "/work/proj" });

    expect(first.sessionId).toBe("chat_1");
    expect(first.agentId).toBe("default");
    expect(second.sessionId).toBe("chat_2");
    // 列表按 `updatedAt` 倒序：最后动的在最前（侧栏就是按这个排的）
    expect((await manager.list("ws-1")).map((s) => s.sessionId)).toEqual(["chat_2", "chat_1"]);
  });

  it("list 按工作区过滤：会话是 workspace 的下级对象，不跨父容器列", async () => {
    await manager.create({ workspaceId: "ws-1", path: "/a" });
    await manager.create({ workspaceId: "ws-2", path: "/b" });

    expect((await manager.list("ws-1")).map((s) => s.sessionId)).toEqual(["chat_1"]);
    expect((await manager.list("ws-2")).map((s) => s.sessionId)).toEqual(["chat_2"]);
    expect(await manager.list("ws-404")).toEqual([]);
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
    expect((await manager.list("ws-1")).map((s) => s.sessionId)).toContain(
      "chat_2026_11_01_10_00_00",
    );
  });

  it("同一个 id 开第二次：报 session-exists（不静默顶掉正在跑的会话）", async () => {
    const first = await manager.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_dup" });
    await expect(
      manager.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_dup" }),
    ).rejects.toThrow(/already exists/);
    // 第一个不受影响
    expect((await manager.list("ws-1")).map((s) => s.sessionId)).toEqual([first.sessionId]);
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
    expect(await manager.list("ws-1")).toEqual([]);

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
    expect(pick("session-phase").at(-1)!.turnId).toBe(1);

    // 先让第一轮收尾（SDK 的 `finally`）再起下一轮：并行两轮会被 `turn-busy` 挡住
    // （事件靠 `turnId` 的当前值归轮，两轮并行必然串号，见 `send` 的注释）
    agent.fire("finally");
    await settled();

    expect(manager.send(sessionId, "第二轮").turnId).toBe(2);
    agent.fire("open");
    expect(pick("session-phase").at(-1)!.turnId).toBe(2);
  });

  it("agent.send() 自己抛错 → 本轮以 session-turn-end(ok:false) 收尾", async () => {
    const { sessionId } = await create();
    agent.holdSend = Promise.reject(Object.assign(new Error("boom"), { code: "net" }));
    manager.send(sessionId, "x");
    await new Promise((resolve) => setTimeout(resolve, 0)); // 让 rejection 落地

    const end = pick("session-turn-end").at(-1)!;
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
      nextSessionId: () => `chat_${++counter.value}`,
      storeFor: () => store,
      handoff: { aiZenDir: join(workspace, "ai-zen"), homeDir: workspace },
    });
    resetEvents();
    counter.value = 0;
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

    // 号没被消耗：快照里仍是 1，第二轮一次都没交给 Agent，也没有带 turnId=2 的 phase
    expect((await guarded.snapshot(sessionId)).turnId).toBe(1);
    expect(agent.sent).toEqual(["第一轮"]);
    expect(pick("session-phase").every((event) => event.turnId === 1)).toBe(true);
  });

  it("该轮收尾（finally）之后 send 恢复正常：turnId 变 2", async () => {
    const { sessionId } = await hangTurn();
    agent.fire("finally");
    await settled();
    expect(pick("session-turn-end").at(-1)).toMatchObject({ turnId: 1, ok: true });

    expect(guarded.send(sessionId, "第二轮")).toEqual({ turnId: 2 });
    expect(agent.sent).toEqual(["第一轮", "第二轮"]);
    expect((await guarded.snapshot(sessionId)).turnId).toBe(2);
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
    expect(pick("session-turn-end").at(-1)).toMatchObject({ turnId: 1 });

    expect(guarded.send(sessionId, "再来一轮")).toEqual({ turnId: 2 });
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
    expect(await manager.list("ws-1")).toEqual([]);
    expect(manager.cancel(sessionId)).toEqual({ cancelled: false });
  });
});

/**
 * 快照：客户端（重）连上来时一次拿全，不必先从事件流里攒。
 *
 * 原来它与「存档 / 续接」同在一个 describe 里（都靠一个注入了假存档的管理器）。拆开之后
 * 存档那半边（save / 续接回来的消息）归 `Persistence.test.ts` —— 这里只留快照本身：
 * 它验的是「一屏要的事实都在」，与存档无关，只是顺手共用同一个假存档的装配。
 */
describe("SessionManager：快照（一屏要的全部事实，不必自己攒事件）", () => {
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
    expect(captured.at(-1)).toMatchObject({ event: "session-phase", phase: { kind: "queued" } });
  });
});

describe("SessionManager：通知（两个通道）", () => {
  it("notice 发的是**对话内**通知：带 sessionId，绑在那段会话上", async () => {
    const { sessionId } = await create();
    const slot = manager.notice(sessionId, {
      level: "error",
      code: "persistFailed",
      params: { error: "磁盘满" },
    });

    expect(pick("session-notice")).toEqual([
      {
        event: "session-notice",
        // 推出去的事件带**槽位自己的 id**（A35）：两个出口同一条通知
        id: slot.id,
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
    expect(pick("session-notice")).toEqual([]);
  });

  it("全局通知走同一个 hub，不带 sessionId（不归属于任何会话）", () => {
    const hub = new EventHub();
    const withHub = new SessionManager({ createAgent: async () => agent, hub });
    const mine: ServerEvent[] = [];
    withHub.subscribe((event) => mine.push(event));

    hub.publish({ event: "server-notice", id: "notice-1", level: "warn", code: "mcpUnavailable" });

    expect(mine).toEqual([
      { event: "server-notice", id: "notice-1", level: "warn", code: "mcpUnavailable" },
    ]);
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
      nextSessionId: () => `chat_${++counter.value}`,
      storeFor: () => store,
      // 交接要读磁盘上的 `handoff` Skill、写 `<工作区>/.ai-zen/handoffs`
      handoff: { aiZenDir: join(workspace, "ai-zen"), homeDir: join(workspace, "home") },
    });
    resetEvents();
    counter.value = 0;
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
    // 交接回合（指令 + 回执）留在会话里，而「每轮 session-turn-end 前落盘」对它同样成立：
    // 用户 `/handoff` 完直接退出，回来时这一段必须在存档里。
    expect([...store.records.keys()]).toEqual([sessionId]);
  });

  it("每轮收尾自动落盘：`session-turn-end` 之前写进存档，并把「本工作区上一轮」指过去", async () => {
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

    // `ai "…"` 的全部要求：这一轮确实跑完了（`session-turn-end` 已发），但工作区里什么都没变
    expect(events.some((event) => event.event === "session-turn-end")).toBe(true);
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
    // 活会话只剩新的这一段（旧那段已入档，所以这里只看活会话）
    expect(await handoffManager.list("ws-1", { includeSaved: false })).toMatchObject([
      { sessionId: result.sessionId, agentId: "default", live: true, phase: null },
    ]);
    // 旧 id 已退场
    // 旧 id 不再是活会话（它作为存档仍在列表里，那是刻意的：历史得能翻回去）
    expect(
      (await handoffManager.list("ws-1", { includeSaved: false })).map((item) => item.sessionId),
    ).not.toContain(sessionId);
    expect((await handoffManager.list("ws-1")).map((item) => item.sessionId)).toContain(sessionId);

    // 旧会话进了存档（含完整历史：prune 之前存下去的）
    expect(store.records.get(sessionId)!.messages).toEqual([
      { role: "user", content: "旧任务" },
      { role: "assistant", content: "旧答复" },
    ]);
    // 新会话也立即落盘了：模板 + 交接断点，指针指过去
    expect(store.records.get(result.sessionId)!.messages).toEqual(agent.messages);
    expect((await store.lastSession())!.id).toBe(result.sessionId);

    // 收尾事件的 sessionId 是**旧** id：客户端先看到那一轮结束，再从响应里拿到新 id
    const end = pick("session-turn-end").at(-1)!;
    expect(end).toMatchObject({ sessionId, ok: true });
  });

  it("迁移的进度是 `session-notice`：存档 / 写文档 / 文档路径（都不带文案）", async () => {
    const sessionId = await openChatted();

    await handoffManager.migrate(sessionId);

    const notices = pick("session-notice");
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
    expect(pick("session-turn-end").at(-1)).toMatchObject({
      sessionId,
      ok: false,
      error: { code: "aborted" },
    });
    expect(pick("session-notice").map((notice) => notice.code)).toContain("turnAborted");
    // 迁移没做成：会话还在旧 id 上（旧会话已存档，但历史没被剔除）
    expect((await handoffManager.list("ws-1")).map((item) => item.sessionId)).toEqual([sessionId]);
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
    resetEvents();
    auto.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("落地动作：先存旧会话 → 剔历史 → 换 id → 发 session-id-changed", async () => {
    const { sessionId } = await auto.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    await hook!();

    // 旧会话进存档（prune 之前的完整历史）
    expect(store.records.get(sessionId)!.messages).toEqual([{ role: "user", content: "旧任务" }]);
    // 活会话换键，新会话里只剩「模板 + 交接断点」
    const aliveNow = await auto.list("ws-1", { includeSaved: false });
    expect(aliveNow.map((item) => item.sessionId)).toEqual(["chat_2"]);
    expect(JSON.stringify(store.records.get("chat_2")!.messages)).not.toContain("旧任务");
    // 客户端没有响应可接：换 id 只能靠事件
    expect(pick("session-id-changed")).toEqual([
      { event: "session-id-changed", from: sessionId, sessionId: "chat_2" },
    ]);
  });

  it("迁移进行中再次触发：让行（并发两次只迁一次）", async () => {
    await auto.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    await Promise.all([hook!(), hook!()]);

    expect(pick("session-id-changed")).toHaveLength(1);
    expect(await auto.list("ws-1", { includeSaved: false })).toHaveLength(1);
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

describe("SessionManager：attach（会话活得比连接久）", () => {
  it("接一个还活着的会话：返回同一个 id / agentId，不另装一个 Agent", async () => {
    let created = 0;
    const m = new SessionManager({
      createAgent: async () => {
        created++;
        return agent;
      },
      nextSessionId: () => `chat_${++counter.value}`,
    });
    const first = await m.create({
      workspaceId: "ws-1",
      path: "/work/proj",
      sessionId: "chat_keep",
    });

    // 客户端退出只退订阅，会话仍在服务端活着 —— 「接着上次」走的就是这条
    const again = await m.attach({
      workspaceId: "ws-1",
      path: "/work/proj",
      sessionId: "chat_keep",
    });

    expect(again).toEqual({ sessionId: "chat_keep", agentId: first.agentId });
    expect(created).toBe(1); // 没有再装配一套 Agent（那会多一套 MCP 连接与工具发现）
    expect(await m.list("ws-1")).toHaveLength(1);
  });

  it("接一个活着的会话：消息仍是它当前的，不被存档覆盖", async () => {
    const store = new FileSessionStore<Message>({ rootDir: tempRoot("aiz-attach") });
    const m = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => `chat_${++counter.value}`,
      storeFor: () => store,
    });
    const first = await m.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_live" });
    agent.messages = [{ role: "user", content: "当前对话" }];
    // 存档里是**旧**内容（上次落盘时的样子）
    await store.write({
      id: "chat_live",
      agentId: "default",
      messages: [storedMessage("user", "旧")],
    });

    await m.attach({ workspaceId: "ws-1", path: "/p", sessionId: first.sessionId });

    expect(agent.messages).toEqual([{ role: "user", content: "当前对话" }]);
  });

  it("接一段只在盘上的会话：从存档装配 Agent 并装回消息", async () => {
    const store = new FileSessionStore<Message>({ rootDir: tempRoot("aiz-attach2") });
    const m = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => `chat_${++counter.value}`,
      storeFor: () => store,
    });
    await store.write({
      id: "chat_disk",
      agentId: "reviewer",
      messages: [storedMessage("user", "旧对话")],
    });

    const attached = await m.attach({ workspaceId: "ws-1", path: "/p", sessionId: "chat_disk" });

    expect(attached).toMatchObject({ sessionId: "chat_disk", agentId: "reviewer" });
    expect(agent.messages).toEqual([storedMessage("user", "旧对话")]);
  });

  it("内存和盘上都没有这个 id：报 session-missing（绝不悄悄开一段空的）", async () => {
    const store = new FileSessionStore<Message>({ rootDir: tempRoot("aiz-attach3") });
    const m = new SessionManager({ createAgent: async () => agent, storeFor: () => store });

    await expect(
      m.attach({ workspaceId: "ws-1", path: "/p", sessionId: "chat_gone" }),
    ).rejects.toThrow(/session-missing|no such session/);
  });

  it("自动分配的 id 撞车：换一个后缀（同一秒开两段是常态，不是错误）", async () => {
    // 生成器恒回同一个 id：第二次必须自己找空位，而不是把用户挡在门外
    const m = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_same",
    });
    const first = await m.create({ workspaceId: "ws-1", path: "/p" });
    const second = await m.create({ workspaceId: "ws-1", path: "/p" });

    expect(first.sessionId).toBe("chat_same");
    expect(second.sessionId).toBe("chat_same_2");
    expect(await m.list("ws-1")).toHaveLength(2);
  });

  it("自动分配的 id 撞上**盘上的**存档：也不覆盖，换一个", async () => {
    const store = new FileSessionStore<Message>({ rootDir: tempRoot("aiz-free") });
    await store.write({
      id: "chat_same",
      agentId: "default",
      messages: [storedMessage("user", "别人的对话")],
    });
    const m = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_same",
      storeFor: () => store,
    });

    const created = await m.create({ workspaceId: "ws-1", path: "/p" });

    expect(created.sessionId).toBe("chat_same_2");
    // 旧存档原封不动
    expect((await store.read("chat_same"))?.messages).toEqual([
      storedMessage("user", "别人的对话"),
    ]);
  });
});

describe("SessionManager：持有者 / 换 Agent / 关闭", () => {
  let store: MemoryStore;
  let live: SessionManager;
  /** 每次 `createAgent` 收到的 agentId（换 Agent 时用它断言真的重建了） */
  let built: string[];
  /** 回收的宽限期用假时钟：断言「到点时怎么判」，不等 60 秒 */
  const clock = fakeClock();

  beforeEach(() => {
    store = new MemoryStore();
    built = [];
    live = new SessionManager({
      createAgent: async (input) => {
        built.push(input.agentId);
        return agent;
      },
      nextSessionId: () => `chat_${++counter.value}`,
      storeFor: () => store,
      schedule: clock.schedule,
    });
    resetEvents();
    live.subscribe((event) => events.push(event));
    counter.value = 0;
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

  it("有连接看着这一段：一轮跑完不会被收掉", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    live.registerHolder(sessionId, 1);

    await runTurn(sessionId);

    expect((await live.list("ws-1")).map((item) => item.sessionId)).toEqual([sessionId]);
    // 列表里的 `live` 就是“此刻在服务端内存里”（事实）。判据只有持有者一条，
    // 不再有客户端上报的那个声明位
    expect((await live.list("ws-1"))[0]!.live).toBe(true);
  });

  it("持有者全走了、空闲：不当场收，宽限期到点才收（存档留着，attach 装得回来）", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    live.registerHolder(sessionId, 1);
    await runTurn(sessionId);

    live.dropHolder(sessionId, 1);
    // 宽限期里还在：删线重连需要它（这就是宽限期存在的全部理由）
    expect((await live.list("ws-1", { includeSaved: false })).map((i) => i.sessionId)).toEqual([
      sessionId,
    ]);

    clock.tick();

    // 活会话没了（存档还在）
    expect(await live.list("ws-1", { includeSaved: false })).toEqual([]);
    // 存档还在：`attach` 能把这段装回来（这一条就是「点回来内容不少」的依据）
    expect(store.records.get(sessionId)!.messages).toHaveLength(2);
  });

  it("一轮还在跑时持有者全走了：不打断它，session-turn-end 收尾时才回收", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    live.registerHolder(sessionId, 1);

    live.send(sessionId, "长任务");
    agent.messages = [{ role: "user", content: "长任务" }];
    live.dropHolder(sessionId, 1);
    clock.tick();
    // 正在跑的一轮不能被收掉：那比多占几兆内存严重
    expect(
      (await live.list("ws-1", { includeSaved: false })).map((item) => item.sessionId),
    ).toEqual([sessionId]);

    agent.messages.push({ role: "assistant", content: "答" });
    agent.fire("finally");
    await settled();

    // 收尾之后回收（存档还在，所以只看活会话）
    expect(await live.list("ws-1", { includeSaved: false })).toEqual([]);
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
    expect((await live.list("ws-1"))[0]!.agentId).toBe("coder");
  });

  it("setAgent：已经是这个 Agent 就不重建（重建只会丢掉工具发现的热状态）", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p", agentId: "coder" });

    await live.setAgent(sessionId, "coder");

    expect(built).toEqual(["coder"]);
  });

  it("setAgent：一轮在跑时拒绝（旧 Agent 正流着的增量会全丢在没人听的实例上）", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    live.send(sessionId, "跑着");

    await expect(live.setAgent(sessionId, "coder")).rejects.toMatchObject({
      code: "turn-in-flight",
    });
    expect(built).toEqual(["default"]);
  });

  it("close：幂等、不删存档；未知会话回 false", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);

    expect(live.close(sessionId)).toEqual({ closed: true });
    expect(live.close(sessionId)).toEqual({ closed: false });
    expect(store.records.get(sessionId)!.messages).toHaveLength(2);
  });
});
/**
 * 会话级模型覆盖（`session.model.set`）—— 三级解析最内层的那一级。
 *
 * 真正的解析顺序在 SDK（`resolveModel`），所以这里的假装配方只做一件事：**照着入参里
 * 那个会话级覆盖回填**（有覆盖算 session 档、没有算 agent 档）。这样断言的是服务端这一侧
 * 的责任 —— 有没有把覆盖递进去、有没有落进存档、换 Agent 时有没有清掉 —— 而不是把 SDK 的
 * 解析顺序在服务端再测一遍（那种“测两遍”正是两份实现的开端）。
 */
describe("SessionManager：会话级模型覆盖（session.model.set）", () => {
  let store: MemoryStore;
  let live: SessionManager;
  /** 每次装配的入参（断言递进去的会话级覆盖） */
  let inputs: CreateAgentInput[];
  /** 最近造出来的那个 Agent（假件里 `send` / `finally` 要打在它身上） */
  let latest: FakeAgent;

  /** 假 Agent：`definition.modelId` 与 `modelLevel` 都跟着入参走，与真件的解析结果同形 */
  const buildAgent = (modelId?: string): FakeAgent => {
    const next = new FakeAgent();
    next.modelLevel = modelId ? "session" : "agent";
    (next as unknown as { definition: { modelId?: string } }).definition.modelId =
      modelId ?? "m-agent";
    return next;
  };

  beforeEach(() => {
    store = new MemoryStore();
    inputs = [];
    counter.value = 0;
    live = new SessionManager({
      createAgent: async (input) => {
        inputs.push(input);
        latest = buildAgent(input.modelId);
        return latest;
      },
      nextSessionId: () => `chat_${++counter.value}`,
      storeFor: () => store,
    });
    resetEvents();
    live.subscribe((event) => events.push(event));
  });

  /** 跑完一轮（带用户消息）并等收尾落地：只有带用户消息的会话才会写存档 */
  const runTurn = async (sessionId: string, text = "问一句") => {
    live.send(sessionId, text);
    latest.messages = [
      { role: "user", content: text },
      { role: "assistant", content: "答" },
    ];
    latest.fire("finally");
    await settled();
  };

  it("setModel：覆盖递给装配方、保留消息、快照回生效模型与档位", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);

    const snapshot = await live.setModel(sessionId, "m-session");

    // 会话级覆盖被原样递进装配（解析本身在 SDK，本层只递这一级）
    expect(inputs.at(-1)!.modelId).toBe("m-session");
    expect(snapshot.modelId).toBe("m-session");
    expect(snapshot.modelLevel).toBe("session");
    expect(snapshot.messages).toHaveLength(2); // 换模型不动对话
  });

  it("setModel：覆盖写进存档（列表里也看得见），下一次发轮落盘不会把它抹掉", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);

    await live.setModel(sessionId, "m-session");

    expect(store.records.get(sessionId)!.modelId).toBe("m-session");
    expect((await live.list("ws-1"))[0]!.modelId).toBe("m-session");

    // 再跑一轮：收尾的写档走同一份 `recordOf`，覆盖还在
    await runTurn(sessionId, "第二问");
    expect(store.records.get(sessionId)!.modelId).toBe("m-session");
  });

  it("setModel：续接（重启后 attach）把覆盖带回来，快照仍是 session 档", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    await live.setModel(sessionId, "m-session");

    // 换一个管理器 + 同一份存档 = 服务端重启
    const restarted = new SessionManager({
      createAgent: async (input) => {
        inputs.push(input);
        return buildAgent(input.modelId);
      },
      storeFor: () => store,
    });
    const attached = await restarted.attach({ workspaceId: "ws-1", path: "/p", sessionId });

    expect(attached.sessionId).toBe(sessionId);
    expect(inputs.at(-1)!.modelId).toBe("m-session");
    const snapshot = await restarted.snapshot(sessionId);
    expect(snapshot.modelId).toBe("m-session");
    expect(snapshot.modelLevel).toBe("session");
  });

  it("setModel：装配失败（模型/端点被删）时会话原样不动，覆盖不落盘", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    const before = await live.snapshot(sessionId);

    // 真实原因是 SDK 的 `createModel` 抛错（模型不在清单里 / 端点没 Key）
    const failing = new SessionManager({
      createAgent: async (input) => {
        if (input.modelId) throw new Error('Model "gone" not found');
        latest = buildAgent();
        return latest;
      },
      nextSessionId: () => `chat_${++counter.value}`,
      storeFor: () => store,
    });
    // 让「同一段会话」活在 failing 这个管理器上
    await failing.attach({ workspaceId: "ws-1", path: "/p", sessionId });

    await expect(failing.setModel(sessionId, "gone")).rejects.toThrow(/not found/);
    // 覆盖没落、Agent 没换：用户只是点了个选择器，不该留下一段起不来的存档
    const after = await failing.snapshot(sessionId);
    expect(after.modelId).toBe(before.modelId);
    expect(after.modelLevel).toBe("agent");
    expect(store.records.get(sessionId)!.modelId).toBeUndefined();
  });

  it("setModel：一轮在跑时拒绝（旧 Agent 正流着的增量会全丢在没人听的实例上）", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    live.send(sessionId, "跑着");

    await expect(live.setModel(sessionId, "m-session")).rejects.toMatchObject({
      code: "turn-in-flight",
    });
    expect((await live.snapshot(sessionId)).modelLevel).toBe("agent");
  });

  it("setAgent：清掉会话级覆盖 —— 换 Agent 是更强的动作，模型跟着新定义走", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    await live.setModel(sessionId, "m-session");

    const snapshot = await live.setAgent(sessionId, "coder");

    // 这次装配**不能**再带覆盖（带了就是让上一任的临时模型继续生效）
    expect(inputs.at(-1)!.modelId).toBeUndefined();
    expect(snapshot.agentId).toBe("coder");
    expect(snapshot.modelId).toBe("m-agent");
    expect(snapshot.modelLevel).toBe("agent");
    // 存档里也得清掉：否则下次 attach 又把旧覆盖装回来
    expect(store.records.get(sessionId)!.modelId).toBeUndefined();
  });

  it("reload：会话级覆盖原样带进重建（重读配置不该悄悄丢掉这段会话的选择）", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    await live.setModel(sessionId, "m-session");

    const snapshot = await live.reload(sessionId);

    expect(inputs.at(-1)!.modelId).toBe("m-session");
    expect(snapshot.modelId).toBe("m-session");
    expect(snapshot.modelLevel).toBe("session");
  });

  it("没有覆盖时快照报 agent 档（跟着 Agent 定义，不是 session）", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });

    const snapshot = await live.snapshot(sessionId);

    expect(snapshot.modelId).toBe("m-agent");
    expect(snapshot.modelLevel).toBe("agent");
  });
});
/**
 * 会话级模型参数（`session.modelParams.set`）—— 与 `session.model.set` **同一级**的那一份。
 *
 * 这里断言的是服务端这一侧的责任：参数有没有被原样递进装配、有没有落进存档、`attach`
 * 回来还在不在、换模型 / 换 Agent 有没有清掉、`recordOf` 有没有把它带进 saveAs 与迁移。
 * 「参数只在模型来自会话级时才生效」由 SDK 的 `resolveModelParams` 决定，服务端不重复推
 * 一遍这个规则 —— 那正是两份实现的开端（与上面那个 describe 同一个理由）。
 *
 * 快照里那对 `modelParams` / `modelParamsLevel` 也锁在这里：它们是客户端显示「思考强度
 * 当前值」的唯一来源，而“当前值是哪一层的”只有服务端说得准。
 */
describe("SessionManager：会话级模型参数（session.modelParams.set）", () => {
  let store: MemoryStore;
  let live: SessionManager;
  /** 每次装配的入参（断言递进去的会话级覆盖） */
  let inputs: CreateAgentInput[];
  /** 最近造出来的那个 Agent（假件里 `send` / `finally` 要打在它身上） */
  let latest: FakeAgent;
  /**
   * Agent **定义上**那份参数（`AgentDefinition.modelParams`；真件从盘上读）。
   *
   * 它不等于「生效参数」：`createAgent` 只在模型来自 `agent` 档时用它 —— 所以它必须能被
   * 单独摆成 `undefined` / 有值，才能分清「快照报的是哪一层的那份」。
   */
  let agentDefParams: Record<string, unknown> | undefined;

  /**
   * 假 Agent：`definition.modelId` 与 `modelLevel` 都跟着入参走，与真件的解析结果同形
   * （真件由 `createAgent` 把生效模型写进定义、并给出档位）。
   *
   * `definition.modelParams` 则照抄**定义上**那一份（由 `agentDefParams` 控制）：真件的
   * 定义里的 `modelParams` 不会被会话级覆盖改写，它一直是 `agent` 那一档的原始值。
   */
  const buildAgent = (input: CreateAgentInput): FakeAgent => {
    const next = new FakeAgent();
    next.modelLevel = input.modelId ? "session" : "agent";
    const definition = (
      next as unknown as {
        definition: { modelId?: string; modelParams?: Record<string, unknown> };
      }
    ).definition;
    definition.modelId = input.modelId ?? "m-agent";
    definition.modelParams = agentDefParams;
    return next;
  };

  beforeEach(() => {
    store = new MemoryStore();
    inputs = [];
    agentDefParams = undefined;
    counter.value = 0;
    live = new SessionManager({
      createAgent: async (input) => {
        inputs.push(input);
        latest = buildAgent(input);
        return latest;
      },
      nextSessionId: () => `chat_${++counter.value}`,
      storeFor: () => store,
    });
    resetEvents();
    live.subscribe((event) => events.push(event));
  });

  /** 跑完一轮（带用户消息）并等收尾落地：只有带用户消息的会话才会写存档 */
  const runTurn = async (sessionId: string, text = "问一句") => {
    live.send(sessionId, text);
    latest.messages = [
      { role: "user", content: text },
      { role: "assistant", content: "答" },
    ];
    latest.fire("finally");
    await settled();
  };

  it("写会话级参数：装配方收到它、存档里看得见、快照仍是会话级那一档", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    // 先让模型也来自会话级：参数只有在这一档才真正生效（跨级不混合由 SDK 把关）
    await live.setModel(sessionId, "m-session");

    const snapshot = await live.setModelParams(sessionId, { reasoning_effort: "high" });

    expect(inputs.at(-1)!.modelId).toBe("m-session");
    expect(inputs.at(-1)!.modelParams).toEqual({ reasoning_effort: "high" });
    expect(store.records.get(sessionId)!.modelParams).toEqual({ reasoning_effort: "high" });
    // 快照确认重建走的是同一档会话级覆盖（参数没把模型顶掉）
    expect(snapshot.modelId).toBe("m-session");
    expect(snapshot.modelLevel).toBe("session");
    expect(snapshot.messages).toHaveLength(2); // 改参数不动对话
  });

  it("再跑一轮：每轮落盘走同一份 recordOf，参数不会被抹掉", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    await live.setModelParams(sessionId, { reasoning_effort: "high" });

    await runTurn(sessionId, "第二问");

    expect(store.records.get(sessionId)!.modelParams).toEqual({ reasoning_effort: "high" });
    // reload（重读配置 / 改别的设置）也要把它带回来
    await live.reload(sessionId);
    expect(inputs.at(-1)!.modelParams).toEqual({ reasoning_effort: "high" });
  });

  it("attach 续接：参数从存档回到装配（只带模型不带参数就退回定义那份了）", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    await live.setModelParams(sessionId, { reasoning_effort: "high" });

    // 换一个管理器 + 同一份存档 = 服务端重启
    const restarted = new SessionManager({
      createAgent: async (input) => {
        inputs.push(input);
        return buildAgent(input);
      },
      storeFor: () => store,
    });
    await restarted.attach({ workspaceId: "ws-1", path: "/p", sessionId });

    expect(inputs.at(-1)!.modelParams).toEqual({ reasoning_effort: "high" });
  });

  it("null = 清掉这一层的覆盖（回到模型出厂参数），存档里也不留", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    await live.setModelParams(sessionId, { reasoning_effort: "high" });

    await live.setModelParams(sessionId, null);

    expect(inputs.at(-1)!.modelParams).toBeUndefined();
    expect(store.records.get(sessionId)!.modelParams).toBeUndefined();
  });

  it("一轮在跑时拒绝（旧 Agent 正流着的增量会全丢在没人听的实例上）", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    live.send(sessionId, "跑着");

    await expect(
      live.setModelParams(sessionId, { reasoning_effort: "high" }),
    ).rejects.toMatchObject({ code: "turn-in-flight" });
  });

  it("换到**别的**模型就清掉参数（旧参数是配给旧模型的，带过去就是端点 400）", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    await live.setModelParams(sessionId, { reasoning_effort: "high" });

    await live.setModel(sessionId, "m-session");

    // 这次装配不能再带旧参数（带了就是让 SDK 把它们发给新模型）
    expect(inputs.at(-1)!.modelId).toBe("m-session");
    expect(inputs.at(-1)!.modelParams).toBeUndefined();
    expect(store.records.get(sessionId)!.modelParams).toBeUndefined();
  });

  it("模型没换（目标 = 生效模型）时保留参数：那不是「换模型」，没有理由丢用户的设置", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    // 生效模型是定义上的 m-agent（没有会话级覆盖）
    await live.setModelParams(sessionId, { reasoning_effort: "high" });

    await live.setModel(sessionId, "m-agent");

    expect(inputs.at(-1)!.modelParams).toEqual({ reasoning_effort: "high" });
    expect(store.records.get(sessionId)!.modelParams).toEqual({ reasoning_effort: "high" });
  });

  it("setAgent 清掉参数 —— 换 Agent 是更强的动作，参数跟模型一起走新定义", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    await live.setModelParams(sessionId, { reasoning_effort: "high" });

    await live.setAgent(sessionId, "coder");

    expect(inputs.at(-1)!.modelParams).toBeUndefined();
    expect(store.records.get(sessionId)!.modelParams).toBeUndefined();
  });

  // ==================================================================
  // 快照里的生效参数：防的是「客户端只能靠命令层自己补视图」——
  // 没这一对字段，想显示当前思考强度的客户端就得自己从「生效值 + 定义 + 默认」反推档位，
  // 而那是优先级规则的第二份实现（推出来的档与实际发出的参数迟早不一致）。
  // ==================================================================

  it("快照带上生效参数与它的档位：模型来自会话级时取会话级那份（定义那份不参与）", async () => {
    // 定义上也带着参数：它是配给**定义绑定的那个模型**的，会话换过模型之后就不该再露面
    agentDefParams = { thinking: { type: "disabled" } };
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    await live.setModel(sessionId, "m-session");

    const snapshot = await live.setModelParams(sessionId, { reasoning_effort: "high" });

    expect(snapshot.modelLevel).toBe("session");
    expect(snapshot.modelParams).toEqual({ reasoning_effort: "high" });
    expect(snapshot.modelParamsLevel).toBe("session");
  });

  it("快照带上定义那份参数：模型来自 Agent 定义时，档位是 agent（不是会话级）", async () => {
    agentDefParams = { reasoning_effort: "low" };
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });

    const snapshot = await live.snapshot(sessionId);

    expect(snapshot.modelLevel).toBe("agent");
    expect(snapshot.modelParams).toEqual({ reasoning_effort: "low" });
    // 档位与参数同源：客户端不需要自己判断「定义上的值算不算生效」
    expect(snapshot.modelParamsLevel).toBe("agent");
  });

  it("模型来自会话级、会话级没设参数：快照不带参数，也不退回去用定义那份（跨级就是端点 400）", async () => {
    // 定义上有参数，但它属于定义绑定的旧模型（例如旧模型才认的 `thinking`）
    agentDefParams = { thinking: { type: "disabled" } };
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await live.setModel(sessionId, "m-session");

    const snapshot = await live.snapshot(sessionId);

    expect(snapshot.modelId).toBe("m-session");
    expect(snapshot.modelLevel).toBe("session");
    // 字段省略 = 「这一档没有覆盖」：客户端显示出厂参数，而不是把旧模型那份当当前值
    expect("modelParams" in snapshot).toBe(false);
    expect("modelParamsLevel" in snapshot).toBe(false);
  });

  it("会话里存着参数但模型来自定义：快照不报它 —— 存着不等于生效，参数跟着档位走", async () => {
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });
    await runTurn(sessionId);
    // 生效模型是定义上的 m-agent，这一份参数在装配时就不参与（由 SDK 按档位排除）
    await live.setModelParams(sessionId, { reasoning_effort: "high" });

    const snapshot = await live.snapshot(sessionId);

    expect(snapshot.modelLevel).toBe("agent");
    expect("modelParams" in snapshot).toBe(false);
    // 存档里它还在（换回会话级模型时仍有效）—— 只是不该被当成「当前值」显示出去
    expect(store.records.get(sessionId)!.modelParams).toEqual({ reasoning_effort: "high" });
  });

  it("全局兜底那一档没有参数可指：会话里存着参数也不报（那一级没有放参数的地方）", async () => {
    // 假装配方照真件：三级都落到 `config.defaultModel` 时档位是 global（定义没绑模型）
    const globalLive = new SessionManager({
      createAgent: async () => {
        const next = new FakeAgent();
        next.modelLevel = "global";
        (
          next as unknown as { definition: { modelId?: string; modelParams?: unknown } }
        ).definition.modelId = "m-default";
        return next;
      },
      nextSessionId: () => `chat_${++counter.value}`,
      storeFor: () => store,
    });
    const { sessionId } = await globalLive.create({ workspaceId: "ws-1", path: "/p" });

    const snapshot = await globalLive.setModelParams(sessionId, { reasoning_effort: "high" });

    expect(snapshot.modelLevel).toBe("global");
    // 全局那一级只有 `defaultModel`，没有参数层：不许从别的层挪一份过来
    expect("modelParams" in snapshot).toBe(false);
    expect("modelParamsLevel" in snapshot).toBe(false);
  });
});
/**
 * 清单里的生效模型（`effectiveModelId` / `effectiveModelLevel`）。
 *
 * 这组用例锁的是一处**行为回归**：`SessionListEntry.modelId` 的语义是「会话级覆盖」，
 * 没有覆盖就缺省 —— 于是「跟着 Agent 定义走 / 跟着全局兜底走」的会话（绝大多数）在清单里
 * 没有模型可显示，桌面端的下拉框就空着。修法只能是**服务端**在清单里给出解析后的生效值：
 * 让客户端拿「覆盖值 + 定义 + 默认」再推一遍，就是优先级规则的第二份实现。
 *
 * 解析的唯一实现是 SDK 的 `resolveModel`，所以下面的假解析器也调它（只多一个计数）：
 * 用例要防的正是「服务端又自己写了一遍 `a ?? b ?? c`」，假件必须与真件同源才看得见。
 */
describe("SessionManager：清单里的生效模型（effectiveModelId / effectiveModelLevel）", () => {
  let store: MemoryStore;
  /** 每次装配的入参（活会话那一路的模型是 `createAgent` 解析出来的） */
  let inputs: CreateAgentInput[];
  /** 假的「定义表 + 全局兜底」：字段名照 `AgentDefinition.modelId` / `AppConfig.defaultModel` */
  let definitions: Map<string, { modelId?: string }>;
  let config: { defaultModel?: string };
  /** 解析器每次被问到的输入（用例断言「一次请求里同一个输入只问一次」） */
  let calls: Array<{ agentId: string; sessionModelId?: string }>;

  /** 与真件同形的假解析器：只把两档原始值递给 SDK 的 `resolveModel`，然后数一次 */
  const resolveSessionModel = async (input: { agentId: string; sessionModelId?: string }) => {
    calls.push(input);
    const definition = definitions.get(input.agentId);
    // 定义已删：与 `createAgent` 同一口径（它也认为这段会话装不起来）
    if (!definition) throw new Error(`Agent "${input.agentId}" not found`);
    const resolved = resolveModel({
      sessionModelId: input.sessionModelId,
      agentModelId: definition.modelId,
      defaultModel: config.defaultModel,
    });
    if (!resolved) throw new Error(`Agent "${input.agentId}" has no model bound`);
    return resolved;
  };

  /** 假 Agent：`definition.modelId` 与 `modelLevel` 都跟着入参走，与真件的解析结果同形 */
  const buildAgent = (modelId?: string): FakeAgent => {
    const next = new FakeAgent();
    next.modelLevel = modelId ? "session" : "agent";
    (next as unknown as { definition: { modelId?: string } }).definition.modelId =
      modelId ?? "m-agent";
    return next;
  };

  const build = (withResolver: boolean) =>
    new SessionManager({
      createAgent: async (input) => {
        inputs.push(input);
        return buildAgent(input.modelId);
      },
      nextSessionId: () => `chat_${++counter.value}`,
      storeFor: () => store,
      resolveSessionModel: withResolver ? resolveSessionModel : undefined,
    });

  const entryOf = (listed: SessionListEntry[], sessionId: string) =>
    listed.find((entry) => entry.sessionId === sessionId)!;

  beforeEach(() => {
    store = new MemoryStore();
    inputs = [];
    calls = [];
    counter.value = 0;
    // 出厂形态：Agent 定义自己绑了模型，全局兜底另有一个（定义没绑时才轮到它）
    definitions = new Map([["default", { modelId: "m-agent" }]]);
    config = { defaultModel: "m-global" };
  });

  it("活会话：生效模型与 snapshot 的 modelId 是同一件事实（不必问解析器）", async () => {
    const live = build(true);
    const { sessionId } = await live.create({ workspaceId: "ws-1", path: "/p" });

    const listed = await live.list("ws-1");
    const snapshot = await live.snapshot(sessionId);

    // 跟着 Agent 定义走的会话（没有覆盖）现在也有模型可显示了
    expect(listed[0]!.effectiveModelId).toBe("m-agent");
    expect(listed[0]!.effectiveModelLevel).toBe("agent");
    // 与快照逐字一致：清单与状态栏不能各说一个模型
    expect(listed[0]!.effectiveModelId).toBe(snapshot.modelId);
    expect(listed[0]!.effectiveModelLevel).toBe(snapshot.modelLevel);

    // 会话级覆盖之后跟着走
    const overridden = await live.setModel(sessionId, "m-session");
    const after = (await live.list("ws-1"))[0]!;
    expect(after.effectiveModelId).toBe(overridden.modelId);
    expect(after.effectiveModelLevel).toBe("session");
    expect(after.effectiveModelId).toBe((await live.snapshot(sessionId)).modelId);
    // 清单里那个值就是装配时递给 `createAgent` 的会话级覆盖（客户端不必再拼一遍）
    expect(inputs.at(-1)!.modelId).toBe("m-session");

    // 活会话这一路**一次解析器都不用问**：模型是 `createAgent` 那一次解析的产物
    expect(calls).toEqual([]);
  });

  it("存档条目（注入了解析器）：给出生效模型；共用一个 agentId 时只解析一次", async () => {
    await store.write({ id: "chat_a", agentId: "default", messages: [] });
    await store.write({ id: "chat_b", agentId: "default", messages: [] });
    await store.write({ id: "chat_c", agentId: "default", messages: [] });
    const live = build(true);

    const listed = await live.list("ws-1");

    expect(listed.map((entry) => entry.sessionId).sort()).toEqual(["chat_a", "chat_b", "chat_c"]);
    for (const entry of listed) {
      expect(entry.live).toBe(false);
      expect(entry.effectiveModelId).toBe("m-agent");
      expect(entry.effectiveModelLevel).toBe("agent");
    }
    // 三条会话共用一个 Agent：一个工作区里多数会话就是这样，解析只该发生一次
    expect(calls).toHaveLength(1);
    expect(calls[0]!.agentId).toBe("default");
  });

  it("存档条目（没注入解析器）：两个字段都省略，list 照常返回", async () => {
    await store.write({ id: "chat_a", agentId: "default", messages: [] });
    const live = build(false);
    await live.create({ workspaceId: "ws-1", path: "/p" });

    const listed = await live.list("ws-1");

    // 没有解析能力 ≠ 清单坏了：存档那条照旧列出，只是不说模型
    const archived = entryOf(listed, "chat_a");
    expect(archived.agentId).toBe("default");
    expect("effectiveModelId" in archived).toBe(false);
    expect("effectiveModelLevel" in archived).toBe(false);
    // 活会话不依赖解析器（模型来自 Agent 实例），照旧给
    expect(entryOf(listed, "chat_1").effectiveModelId).toBe("m-agent");
  });

  it("定义已删（解析器抛错）：那几条省略字段，其余条目照常，list 不报错", async () => {
    await store.write({ id: "chat_gone_1", agentId: "deleted", messages: [] });
    await store.write({ id: "chat_gone_2", agentId: "deleted", messages: [] });
    await store.write({ id: "chat_ok", agentId: "default", messages: [] });
    const live = build(true);

    const listed = await live.list("ws-1");

    expect(listed.map((entry) => entry.sessionId).sort()).toEqual([
      "chat_gone_1",
      "chat_gone_2",
      "chat_ok",
    ]);
    for (const sessionId of ["chat_gone_1", "chat_gone_2"]) {
      const gone = entryOf(listed, sessionId);
      expect("effectiveModelId" in gone).toBe(false);
      expect("effectiveModelLevel" in gone).toBe(false);
    }
    expect(entryOf(listed, "chat_ok").effectiveModelId).toBe("m-agent");
    // 同一个失败也不重复问：删掉一个定义可能挂着一堆历史会话
    expect(calls.filter((call) => call.agentId === "deleted")).toHaveLength(1);
  });

  it("modelId 的语义没被改：它只报会话级覆盖，生效值另给", async () => {
    await store.write({
      id: "chat_override",
      agentId: "default",
      messages: [],
      modelId: "m-session",
    });
    await store.write({ id: "chat_plain", agentId: "default", messages: [] });
    const live = build(true);

    const listed = await live.list("ws-1");

    // 有覆盖：`modelId` 仍是覆盖值，生效值也是它（会话级赢了），档位说清了这一点
    const override = entryOf(listed, "chat_override");
    expect(override.modelId).toBe("m-session");
    expect(override.effectiveModelId).toBe("m-session");
    expect(override.effectiveModelLevel).toBe("session");

    // 没覆盖：`modelId` 缺省（语义没被偷换成「生效值」），生效值落在定义那一档
    const plain = entryOf(listed, "chat_plain");
    expect("modelId" in plain).toBe(false);
    expect(plain.effectiveModelId).toBe("m-agent");
    expect(plain.effectiveModelLevel).toBe("agent");

    // 两者可以不同，而解析的输入里就带着覆盖值 —— 缓存键必须含它，否则第二条会拿到
    // 第一条的答案（同一个 agentId、不同的会话级覆盖是两件事）
    expect(calls).toHaveLength(2);
  });
});
/**
 * 「活着」的判据：**有持有者**（唯一一条），以及它对应的两条退出路。
 *
 * 这组用例锁的是分离改造后最容易漏的一条：**崩溃的客户端发不出「我不要了」那一帧**。
 * 判据只取持有者，因为它是内核保证的事实：进程被 `kill -9` 时 socket 就没了。
 * 「没人看着之后还能留多久」交给宽限期（给删线重连留的窗口）。
 *
 * 原来这里还有第五个来源：客户端主动上报的那个声明位（与持有者取合取）。它被删了，
 * 理由写在 `SessionManager` 文件头；用例也从「声明为假 → 当场收」改成了
 * 「显式 `session.close` → 当场收」—— 后者是删掉声明之后**唯一**的当场回收手段。
 */
describe("SessionManager：活着 = 有持有者（宽限期回收）", () => {
  let clock: ReturnType<typeof fakeClock>;
  let live: SessionManager;

  beforeEach(() => {
    clock = fakeClock();
    counter.value = 0;
    live = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => `chat_${++counter.value}`,
      schedule: clock.schedule,
    });
    resetEvents();
    live.subscribe((event) => events.push(event));
  });

  const open = async () => (await live.create({ workspaceId: "ws-1", path: "/p" })).sessionId;
  const alive = async () => (await live.list("ws-1")).length;

  it("最后一个持有者走了：宽限期内留着，到点才收", async () => {
    const sessionId = await open();
    live.registerHolder(sessionId, 1);

    live.dropHolder(sessionId, 1);
    // 宽限期还没到：重连还有机会接回这一段（这就是它存在的全部理由）
    expect(await alive()).toBe(1);

    clock.tick();
    // 到点再判一次：没人要 → 收（存档早在每轮收尾写好了）
    expect(await alive()).toBe(0);
  });

  it("宽限期内又接回来：倒计时作废，到点也不收", async () => {
    const sessionId = await open();
    live.registerHolder(sessionId, 1);
    live.dropHolder(sessionId, 1);

    live.registerHolder(sessionId, 2); // 重连后的新连接
    clock.tick();

    expect(await alive()).toBe(1);
  });

  it("两个客户端同看一段：走一个不收，最后一个走了才开始计时", async () => {
    const sessionId = await open();
    live.registerHolder(sessionId, 1);
    live.registerHolder(sessionId, 2);

    live.dropHolder(sessionId, 1);
    clock.tick();
    expect(await alive()).toBe(1);

    live.dropHolder(sessionId, 2);
    clock.tick();
    expect(await alive()).toBe(0);
  });

  it("到点时这一轮还在跑：不打断，收尾之后才收", async () => {
    const sessionId = await open();
    live.registerHolder(sessionId, 1);
    agent.holdSend = new Promise<void>(() => {}); // 一轮挂住，不落定
    live.send(sessionId, "长任务");
    live.dropHolder(sessionId, 1);

    clock.tick();
    // 一轮中途被收 = 那一轮的产出与存档一起丢（detach 之后 settleTurn 不再跑），只能延后
    expect(await alive()).toBe(1);

    agent.holdSend = null;
    agent.messages = [
      { role: "user", content: "长任务" },
      { role: "assistant", content: "答" },
    ];
    agent.fire("finally");
    await settled();

    expect(await alive()).toBe(0);
  });

  it("显式 session.close：不等宽限期，持有者还在也当场收", async () => {
    const sessionId = await open();
    live.registerHolder(sessionId, 1);

    expect(live.close(sessionId)).toEqual({ closed: true });

    expect(await alive()).toBe(0);
  });

  it("倒计时已经起跑后，段内再收尾一轮也不会把窗口往后推", async () => {
    const sessionId = await open();
    live.registerHolder(sessionId, 1);
    live.dropHolder(sessionId, 1); // 倒计时开始（服务端手头还有一轮正在跑、即将收尾）
    expect(clock.pending()).toHaveLength(1);

    live.send(sessionId, "问");
    agent.messages = [{ role: "user", content: "问" }];
    agent.fire("finally");
    await settled();

    // 收尾时又判一次，但幂等：还是那一个倒计时，没有重挂（否则聊得越多留得越久）
    expect(clock.pending()).toHaveLength(1);
  });

  it("close 之后倒计时随之取消（不会向已删会话伸手）", async () => {
    const sessionId = await open();
    live.registerHolder(sessionId, 1);
    live.dropHolder(sessionId, 1);
    expect(clock.pending()).toHaveLength(1);

    live.close(sessionId);

    expect(clock.pending()).toHaveLength(0);
  });

  it("dispose 时把倒计时全部取消", async () => {
    const first = await open();
    const second = await open();
    live.dropHolder(first, 1);
    live.dropHolder(second, 1);
    expect(clock.pending()).toHaveLength(2);

    live.dispose();

    expect(clock.pending()).toHaveLength(0);
  });
});
/**
 * `title` 与 `id` 是两个事实：id 是身份（存档文件名、指针、idChanged 都指它），
 * title 是给人看的名字，改了不动 id。`remove` 是另一个动作（物理删档）。
 *
 * 桌面端的侧栏要的正是这两件事：改名（不跳 id）与删除。
 */
describe("SessionManager：标题与删除（id 与 title 分开）", () => {
  let store: MemoryStore;
  let titled: SessionManager;

  beforeEach(() => {
    store = new MemoryStore();
    titled = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_titled",
      storeFor: () => store,
    });
  });

  /** 造一段「已存档、不在内存里」的会话（侧栏里最常见的那种） */
  const archiveOnly = async (): Promise<string> => {
    const { sessionId } = await titled.create({ workspaceId: "ws-1", path: "/p" });
    agent.messages = [{ role: "user", content: "留档" }];
    await titled.save(sessionId);
    titled.close(sessionId);
    return sessionId;
  };

  it("改活会话的名字：id 不动，存档与列表都跟上", async () => {
    const { sessionId } = await titled.create({ workspaceId: "ws-1", path: "/p" });

    expect(await titled.rename({ workspaceId: "ws-1", sessionId, title: "  重构会话  " })).toEqual({
      sessionId,
      title: "重构会话",
    });

    // id 没变（换 id 是 `saveAs` 干的事）
    expect((await titled.list("ws-1")).map((entry) => entry.sessionId)).toEqual([sessionId]);
    expect((await titled.list("ws-1"))[0]!.title).toBe("重构会话");
    // 存档里也写下来了：下次 attach 装回来的还是这个名字
    expect(store.records.get(sessionId)!.title).toBe("重构会话");
  });

  it("只改盘上的存档：不需要先 attach 进内存", async () => {
    const sessionId = await archiveOnly();

    await titled.rename({ workspaceId: "ws-1", sessionId, title: "旧会话" });

    expect(store.records.get(sessionId)!.title).toBe("旧会话");
    expect((await titled.list("ws-1", { includeSaved: false })).length).toBe(0); // 它仍是存档，不是活会话
  });

  it("续接时把 title 带回来（同名 store 里已有）", async () => {
    const sessionId = await archiveOnly();
    await titled.rename({ workspaceId: "ws-1", sessionId, title: "带回来" });

    await titled.attach({ workspaceId: "ws-1", path: "/p", sessionId });

    expect((await titled.list("ws-1"))[0]!.title).toBe("带回来");
  });

  it("空标题 → bad-params；不存在的会话 → session-missing", async () => {
    const { sessionId } = await titled.create({ workspaceId: "ws-1", path: "/p" });

    await expect(
      titled.rename({ workspaceId: "ws-1", sessionId, title: "   " }),
    ).rejects.toMatchObject({ code: "bad-params" });
    await expect(
      titled.rename({ workspaceId: "ws-1", sessionId: "chat_404", title: "x" }),
    ).rejects.toMatchObject({ code: "session-missing" });
  });

  it("saveAs 换 id 时把 title 一起带走（否则改过的名字会在另存为时丢掉）", async () => {
    const { sessionId } = await titled.create({ workspaceId: "ws-1", path: "/p" });
    await titled.rename({ workspaceId: "ws-1", sessionId, title: "名字" });

    const result = await titled.saveAs(sessionId, "chat_renamed");

    expect(store.records.get("chat_renamed")!.title).toBe("名字");
    expect(store.records.has(sessionId)).toBe(false);
  });

  it("删活会话：内存里没了、存档也没了", async () => {
    const { sessionId } = await titled.create({ workspaceId: "ws-1", path: "/p" });
    await titled.save(sessionId);

    expect(await titled.remove({ workspaceId: "ws-1", sessionId })).toEqual({ removed: true });

    expect(await titled.list("ws-1")).toEqual([]);
    expect(store.records.has(sessionId)).toBe(false);
  });

  it("删只存在于盘上的存档", async () => {
    const sessionId = await archiveOnly();

    expect(await titled.remove({ workspaceId: "ws-1", sessionId })).toEqual({ removed: true });
    expect(store.records.has(sessionId)).toBe(false);
  });

  it("删正在跑的一轮：先把会话摘掉，那一轮跑完也不再写档", async () => {
    const { sessionId } = await titled.create({ workspaceId: "ws-1", path: "/p" });
    titled.send(sessionId, "长任务");

    expect(await titled.remove({ workspaceId: "ws-1", sessionId })).toEqual({ removed: true });
    expect(await titled.list("ws-1")).toEqual([]);

    // 那一轮照常在后台跑完；`settleTurn` 已经不挂了（detach 过），所以不会把存档写回来
    agent.messages = [
      { role: "user", content: "长任务" },
      { role: "assistant", content: "答" },
    ];
    agent.fire("finally");
    await settled();

    expect(store.records.has(sessionId)).toBe(false);
  });

  it("删不存在的会话：removed:false（幂等，不当错误）", async () => {
    expect(await titled.remove({ workspaceId: "ws-1", sessionId: "chat_404" })).toEqual({
      removed: false,
    });
  });

  it("删掉「上一轮会话」指针指着的那段：指针不动，last() 自己回 null", async () => {
    const { sessionId } = await titled.create({ workspaceId: "ws-1", path: "/p" });
    await titled.save(sessionId);

    await titled.remove({ workspaceId: "ws-1", sessionId });

    expect(await titled.last("ws-1")).toEqual({ sessionId: null });
  });
});

describe("SessionManager：自动标题（第一轮 session-turn-end 之后异步起名）", () => {
  let store: MemoryStore;
  let titleManager: SessionManager;
  /** 注入缝：这一份就是用例的「模型」。调用记录 = 服务端到底发了什么 */
  let calls: AutoTitleRequest[];
  /** 每次调用回什么（`null` = 模型给了个空名字；抛 = 无 key / 网络 / 超时那一类失败） */
  let reply: (request: AutoTitleRequest) => Promise<string | null>;

  /** 轮询到条件成立（等待一律这么写，不固定 sleep） */
  const until = async (condition: () => boolean, timeoutMs = 2000): Promise<void> => {
    const deadline = performance.now() + timeoutMs;
    while (!condition()) {
      if (performance.now() > deadline) throw new Error("等待条件成立超时");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  beforeEach(() => {
    store = new MemoryStore();
    calls = [];
    reply = async () => "迁移策略改造";
    titleManager = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_title",
      storeFor: () => store,
      autoTitle: async (request) => {
        calls.push(request);
        return await reply(request);
      },
    });
    resetEvents();
    titleManager.subscribe((event) => events.push(event));
  });

  /** 跑一轮（把消息造出来再驱动 `finally`），等到这一轮真的收尾 */
  const runTurn = async (sessionId: string, content = "帮我把迁移改成 omit") => {
    const before = pick("session-turn-end").length;
    titleManager.send(sessionId, content);
    agent.messages.push({ role: "user", content });
    agent.messages.push({ role: "assistant", content: "好" });
    agent.fire("finally");
    await until(() => pick("session-turn-end").length > before);
  };

  it("命名不阻塞收尾：`session-turn-end` 先到，标题与事件随后才来", async () => {
    // 假件照抄真件的形状：SDK 会把三级解析的结果写进它交给 Agent 的那份定义
    (agent as unknown as { definition: { modelId?: string } }).definition.modelId = "m-live";
    const { sessionId } = await titleManager.create({ workspaceId: "ws-1", path: "/p" });

    let release!: (title: string) => void;
    reply = () => new Promise<string>((resolve) => (release = resolve));

    await runTurn(sessionId);

    // 这一轮已经结束、客户端已经在等下一轮了 —— 而标题还在路上
    expect(pick("session-title-changed")).toEqual([]);
    expect(calls).toHaveLength(1);
    // 用哪个模型由会话层给：装配方（注入的函数）不知道这一段生效的是哪个模型
    expect(calls[0]!.modelId).toBe("m-live");
    // 交给生成器的是这一段会话的**当前消息**（它只读，别指望它去挑角色 —— 挑角色是
    // AutoTitle 的事，见 `AutoTitle.test.ts`）
    expect(calls[0]!.messages.map((m) => (m as { role: string }).role)).toEqual([
      "user",
      "assistant",
    ]);

    release("迁移策略改造");
    await until(() => pick("session-title-changed").length === 1);

    expect(pick("session-title-changed")[0]).toEqual({
      event: "session-title-changed",
      sessionId,
      title: "迁移策略改造",
    });
    // 写进存档（走的是每轮落盘那条路径里的同一份 record），列表也拿得到
    expect(store.records.get(sessionId)!.title).toBe("迁移策略改造");
    expect((await titleManager.list("ws-1", { includeSaved: false }))[0]!.title).toBe(
      "迁移策略改造",
    );
  });

  it("绝不覆盖用户手改的名字：已经有了就不发请求", async () => {
    const { sessionId } = await titleManager.create({ workspaceId: "ws-1", path: "/p" });
    await titleManager.rename({ workspaceId: "ws-1", sessionId, title: "我的名字" });

    await runTurn(sessionId);
    await settled();

    expect(calls).toEqual([]); // 连一次模型调用都不该有
    expect(store.records.get(sessionId)!.title).toBe("我的名字");
    expect(pick("session-title-changed")).toEqual([]);
  });

  it("拿到结果时用户已经改过名：模型的名字让位（那几秒里用户才是对的）", async () => {
    const { sessionId } = await titleManager.create({ workspaceId: "ws-1", path: "/p" });
    let release!: (title: string) => void;
    reply = () => new Promise<string>((resolve) => (release = resolve));

    await runTurn(sessionId);
    await until(() => calls.length === 1);
    // 请求还在路上时用户改了名字
    await titleManager.rename({ workspaceId: "ws-1", sessionId, title: "用户的名字" });
    release("模型的名字");
    await settled();

    expect(store.records.get(sessionId)!.title).toBe("用户的名字");
    expect(pick("session-title-changed")).toEqual([]);
  });

  it("同一段会话只生成一次：第二轮不再发请求", async () => {
    const { sessionId } = await titleManager.create({ workspaceId: "ws-1", path: "/p" });

    await runTurn(sessionId);
    await until(() => pick("session-title-changed").length === 1);
    await runTurn(sessionId, "再问一句");
    await settled();

    expect(calls).toHaveLength(1);
  });

  it("生成失败静默留空：不发事件、不推错误通知、也不重试", async () => {
    const { sessionId } = await titleManager.create({ workspaceId: "ws-1", path: "/p" });
    let fail!: (error: Error) => void;
    reply = () => new Promise<string>((_resolve, reject) => (fail = reject));

    await runTurn(sessionId);
    await until(() => calls.length === 1);
    fail(new Error('API key for endpoint "EP" is not set'));
    await settled();

    // 用户从没要求「起名」这件事：它失败就该像没发生过
    expect(pick("session-title-changed")).toEqual([]);
    expect(pick("session-notice")).toEqual([]);
    expect(store.records.get(sessionId)!.title).toBeUndefined();
    // 这一轮照样结束了（失败的是标题，不是对话）
    expect(pick("session-turn-end").at(-1)).toMatchObject({ sessionId, ok: true });

    // 第二轮不重试（"不许重试轰炸"）
    await runTurn(sessionId, "再问一句");
    await settled();
    expect(calls).toHaveLength(1);
  });

  it("硬超时：到点就取消那次请求，标题留空（时限可注入，用例不等 10 秒）", async () => {
    const timed = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_title",
      storeFor: () => store,
      autoTitleTimeoutMs: 20,
      // 照抄真件：请求挂住，直到 signal 触发才认输（`completeOnce` 就是这么断的）
      autoTitle: (request) =>
        new Promise<string | null>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    resetEvents();
    timed.subscribe((event) => events.push(event));
    const { sessionId } = await timed.create({ workspaceId: "ws-1", path: "/p" });

    timed.send(sessionId, "第一句");
    agent.messages.push({ role: "user", content: "第一句" });
    agent.fire("finally");

    // 等到「这一轮已收尾」与「标题请求已被超时取消」两件事都成立
    await until(() => pick("session-turn-end").length === 1);
    await until(() => pick("session-title-changed").length === 0 && store.records.has(sessionId));
    await settled();

    expect(pick("session-title-changed")).toEqual([]);
    expect(store.records.get(sessionId)!.title).toBeUndefined();
  });
});

describe("SessionManager：迁移策略（omit 与 prune 是两种结局，不是两个开关）", () => {
  let store: MemoryStore;
  let workspace: string;
  let strategyManager: SessionManager;
  let counter = 0;

  beforeEach(async () => {
    store = new MemoryStore();
    counter = 0;
    workspace = await fs.mkdtemp(join(tmpdir(), "aiz-migrate-strategy-"));
    strategyManager = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => `chat_${++counter}`,
      storeFor: () => store,
      handoff: { aiZenDir: join(workspace, "ai-zen"), homeDir: workspace },
    });
    resetEvents();
    strategyManager.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  /**
   * 开一段「真跑过一轮」的会话（`turnId` 到 1，迁移之后要看到它继续累加）。
   *
   * 消息必须照真件的形状开头：真 Agent 的 `messages` 第一条是 `definition.messages` 里的
   * 模板（system）。SDK 的 `omit` 就是按「前 `definition.messages.length` 条是模板」来判
   * 的 —— 假件漏了这条 system，断言就会得到 `omit: undefined`，而真件永远不会那样。
   */
  const openChatted = async (): Promise<string> => {
    const { sessionId } = await strategyManager.create({ workspaceId: "ws-1", path: workspace });
    strategyManager.send(sessionId, "旧任务");
    agent.messages = [
      { role: "system", content: "模板" },
      { role: "user", content: "旧任务" },
      { role: "assistant", content: "旧答复" },
    ];
    agent.fire("finally");
    await settled();
    return sessionId;
  };

  it("omit：同一个 sessionId，历史标 omit 留在原处，不发 idChanged，存档只有一份", async () => {
    const sessionId = await openChatted();

    const result = await strategyManager.migrate(sessionId, undefined, "omit");

    // 还是同一段会话：内容没变（只是旧消息不再发给模型），没有理由换个身份
    expect(result.sessionId).toBe(sessionId);
    expect(pick("session-id-changed")).toEqual([]);

    // 历史留着（可审计 / 可回放），标的是「不再发送」；模板不动，末尾追加交接断点
    const messages = agent.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "模板" });
    expect(messages[1]).toMatchObject({ role: "user", content: "旧任务", omit: true });
    expect(messages[2]).toMatchObject({ role: "assistant", content: "旧答复", omit: true });
    expect(JSON.stringify(messages.at(-1))).toContain(result.handoffPath);

    // 存档就是同一份：没有写出第二个 id，也没有把旧档删掉
    expect([...store.records.keys()]).toEqual([sessionId]);
    expect(store.records.get(sessionId)!.messages).toEqual(messages);
    expect((await store.lastSession())!.id).toBe(sessionId);

    // `turnId` 继续累加（迁移本身也是一轮），收尾事件仍在同一个 id 上
    expect((await strategyManager.snapshot(sessionId)).turnId).toBe(2);
    expect(pick("session-turn-end").at(-1)).toMatchObject({ sessionId, ok: true });

    // 不再有「旧会话已另存」那条通知：它根本没有被另存成一段
    expect(pick("session-notice").map((notice) => notice.code)).toEqual([
      "handoffWriting",
      "migrationDegraded", // 假 Agent 无 write 工具 → 摘要模式
      "handoffPath",
      "handoffMigrated",
      "handoffMigratedHint",
    ]);
  });

  it("prune：显式传与不传逐字同一条路（换 id、旧段作为存档留在旧 id 下）", async () => {
    const sessionId = await openChatted();

    const result = await strategyManager.migrate(sessionId, undefined, "prune");

    expect(result.sessionId).not.toBe(sessionId);
    expect(pick("session-id-changed")).toEqual([
      { event: "session-id-changed", from: sessionId, sessionId: result.sessionId },
    ]);
    // 两份存档：旧的是交接前的完整历史，新的是「模板 + 交接断点」
    expect(store.records.get(sessionId)!.messages).toEqual([
      { role: "system", content: "模板" },
      { role: "user", content: "旧任务" },
      { role: "assistant", content: "旧答复" },
    ]);
    expect(JSON.stringify(store.records.get(result.sessionId)!.messages)).not.toContain("旧任务");
    // 旧会话存档里的通知仍然先说「已存档」（这一条 prune 才有意义）
    expect(pick("session-notice")[0]).toMatchObject({
      code: "handoffArchived",
      params: { sessionId },
    });
  });

  /**
   * 迁移两条分支都要把会话级模型参数带进存档（`recordOf` 是存档形状的唯一出处）。
   *
   * 这条特别容易漏在 `omit` 上：它不换 id、看起来「什么都没动」，于是有人以为存档也不用
   * 重写 —— 但参数是 `recordOf` 拼出来的，漏了它下一次 `attach` 就退回 Agent 定义那份
   * （配给另一个模型的参数）。
   */
  it("omit：会话级模型参数跟着存档走（迁移不丢参数）", async () => {
    const sessionId = await openChatted();
    await strategyManager.setModelParams(sessionId, { reasoning_effort: "high" });

    const result = await strategyManager.migrate(sessionId, undefined, "omit");

    expect(result.sessionId).toBe(sessionId);
    expect(store.records.get(sessionId)!.modelParams).toEqual({ reasoning_effort: "high" });
  });

  it("prune：旧段与新的那段都带着会话级模型参数（同一段对话的两份存档）", async () => {
    const sessionId = await openChatted();
    await strategyManager.setModelParams(sessionId, { reasoning_effort: "high" });

    const result = await strategyManager.migrate(sessionId, undefined, "prune");

    expect(store.records.get(sessionId)!.modelParams).toEqual({ reasoning_effort: "high" });
    expect(store.records.get(result.sessionId)!.modelParams).toEqual({
      reasoning_effort: "high",
    });
  });
});
