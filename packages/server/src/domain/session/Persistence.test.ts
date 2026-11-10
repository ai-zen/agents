/**
 * `Persistence` 的用例：存档的形状、写盘、另存为、续接。
 *
 * 这一组的中心是 `recordOf` —— 存档形状的**唯一定义处**。它漏一个字段就是一类数据
 * 丢失（改过的名字被抹掉、会话级模型 / 参数在下一轮悄悄失效），所以字段过一遍这里
 * 就等于过一遍全部写档路径。
 *
 * 共用脚手架见 `SessionTestSupport.ts`。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "./SessionManager.js";
import { FileSessionStore } from "./store/FileSessionStore.js";
import type { Message } from "@ai-zen/agents-protocol";
import {
  settled,
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

/**
 * 存档与续接：`save` 写下去的那份、以及续接时 Agent 带着的那份，是不是同一份。
 *
 * 与「快照」原本同一个 describe（共用一个注入了假存档的管理器），拆开之后快照留在
 * `SessionManager.test.ts`：那一半验的是「一屏要的事实」，与存档无关。
 */
describe("SessionManager：存档与续接（save / 续接回来的消息）", () => {
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

  it("list 合并存档与活会话：活的那条带 `live`，盘上的那条没有", async () => {
    await store.write({ id: "chat_old", agentId: "default", messages: [] });
    await withStore.create({ workspaceId: "ws-1", path: "/p" });
    await withStore.save("chat_fixed");

    const listed = await withStore.list("ws-1");
    expect(listed.map((entry) => entry.sessionId).sort()).toEqual(["chat_fixed", "chat_old"]);
    expect(listed.find((entry) => entry.sessionId === "chat_fixed")!.live).toBe(true);
    expect(listed.find((entry) => entry.sessionId === "chat_old")!.live).toBe(false);
    // `includeSaved:false` 只看活会话
    expect((await withStore.list("ws-1", { includeSaved: false })).map((e) => e.sessionId)).toEqual(
      ["chat_fixed"],
    );
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
    agent.messages = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];

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
    const store = new FileSessionStore<Message>({ rootDir: root });
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
    // 同一段对话换个名字：轮次编号不清零（轮次不在列表里，看快照）
    expect((await saveManager.snapshot("chat_debug_login")).turnId).toBe(1);
    expect(await saveManager.list("ws-1")).toMatchObject([
      { sessionId: "chat_debug_login", agentId: "default", live: true, phase: null },
    ]);
  });

  it("另存为把会话级模型参数一起带走（存档形状只在 `recordOf` 一处定义，漏一个字段就是一类数据丢失）", async () => {
    await saveManager.create({ workspaceId: "ws-1", path: "/p" });
    agent.messages = [{ role: "user", content: "留档" }];
    saveManager.send("chat_next", "留档");
    agent.fire("open");
    agent.fire("finally");
    await settled();
    await saveManager.setModelParams("chat_next", { reasoning_effort: "high" });

    await saveManager.saveAs("chat_next", "chat_debug_login");

    expect(store.records.get("chat_debug_login")!.modelParams).toEqual({
      reasoning_effort: "high",
    });
  });

  it("目标 id 已被另一段活会话占着：报 session-exists，旧档不动", async () => {
    await saveManager.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_a" });
    await saveManager.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_b" });

    await expect(saveManager.saveAs("chat_a", "chat_b")).rejects.toThrow(/already exists/);
    // 倒序（同毫秒时按 id 倒序）
    expect((await saveManager.list("ws-1")).map((item) => item.sessionId)).toEqual([
      "chat_b",
      "chat_a",
    ]);
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

    const created = await resuming.create({
      workspaceId: "ws-1",
      path: "/p",
      sessionId: "chat_coder",
    });

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

describe("SessionManager：续接不是一次活动（updatedAt）", () => {
  let store: MemoryStore;
  let withStore: SessionManager;
  /** 一段老会话的「最后一次活动」：一个确定的旧时刻（不是「刚刚」） */
  const ARCHIVED_AT = "2024-03-05T06:07:08.900Z";

  /** 轮询到条件成立（等待一律这么写，不固定 sleep） */
  const until = async (
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 2000,
  ): Promise<void> => {
    const deadline = performance.now() + timeoutMs;
    while (!(await condition())) {
      if (performance.now() > deadline) throw new Error("等待条件成立超时");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  beforeEach(() => {
    store = new MemoryStore();
    withStore = new SessionManager({
      createAgent: async () => agent,
      nextSessionId: () => "chat_live",
      storeFor: () => store,
    });
    resetEvents();
    withStore.subscribe((event) => events.push(event));
  });

  /** 摆一段「上次聊到这儿」的存档，并把它的最后活动时间定在 `updatedAt` */
  const archive = (id = "chat_old", updatedAt = ARCHIVED_AT) =>
    store.seed(
      { id, agentId: "default", messages: [{ role: "user", content: "上次聊到这儿" }] as never },
      updatedAt,
    );

  /** `session.list` 里这一条的 `updatedAt`（客户端看到的就是这个值） */
  const listedAt = async (sessionId: string) => {
    const listed = await withStore.list("ws-1");
    const entry = listed.find((item) => item.sessionId === sessionId);
    if (!entry) throw new Error(`list 里没有 ${sessionId}`);
    return entry;
  };

  it("续接（attach）一段存档：`updatedAt` 仍是存档里那个旧时刻", async () => {
    archive();
    // 另一段更近的会话：用来断言「打开一段老会话」不会把它顶到列表最前
    archive("chat_newer", "2024-06-07T08:09:10.000Z");

    await withStore.attach({ workspaceId: "ws-1", path: "/p", sessionId: "chat_old" });

    const entry = await listedAt("chat_old");
    // 本缺陷的回归保护：以前这里是「现在」，于是侧栏里点开一段老会话就把它顶到最前、
    // 时间显示成「现在」。这一条红 = 那次「查看」又在改写「最后一次活动」
    expect(entry.live).toBe(true);
    expect(entry.updatedAt).toBe(ARCHIVED_AT);
    // 顺序也照旧（排序唯一读的就是这个时间）
    expect((await withStore.list("ws-1")).map((item) => item.sessionId)).toEqual([
      "chat_newer",
      "chat_old",
    ]);
  });

  it("`/load` 那条入口（create 带已有 id）同样不改时间", async () => {
    archive();

    // CLI 的 `/load` 走的是这条路：同一个装配逻辑，不是另一套续接
    await withStore.create({ workspaceId: "ws-1", path: "/p", sessionId: "chat_old" });

    expect((await listedAt("chat_old")).updatedAt).toBe(ARCHIVED_AT);
  });

  it("新建会话（没有存档可带回来）：`updatedAt` 是「现在」", async () => {
    const startedAt = new Date().toISOString();

    const { sessionId } = await withStore.create({ workspaceId: "ws-1", path: "/p" });

    // 不用 sleep：比「测试开始之前」晚就够了 —— 断言的是「用的是现在，不是存档里的」，
    // 不是时钟精度
    const entry = await listedAt(sessionId);
    expect(Date.parse(entry.updatedAt)).toBeGreaterThanOrEqual(Date.parse(startedAt));
  });

  it("续接之后真的跑一轮并落盘：`updatedAt` 才变成更新的值", async () => {
    archive();
    await withStore.attach({ workspaceId: "ws-1", path: "/p", sessionId: "chat_old" });
    expect((await listedAt("chat_old")).updatedAt).toBe(ARCHIVED_AT);

    withStore.send("chat_old", "又聊了一句");
    agent.messages = [
      { role: "user", content: "上次聊到这儿" },
      { role: "assistant", content: "答" },
      { role: "user", content: "又聊了一句" },
    ];
    agent.fire("finally");
    // 收尾是异步的（先落盘、再 `session.turnEnd`）：等到那个时间真的变新为止
    await until(
      async () => Date.parse((await listedAt("chat_old")).updatedAt) > Date.parse(ARCHIVED_AT),
    );

    // 落盘那一刻才是「一次活动」：`recordOf` 刷新时间那条不能被修没
    expect(store.records.get("chat_old")!.messages).toHaveLength(3);
  });

  it("续接之后立刻 save：`updatedAt` 变新（保存本身就是一次活动）", async () => {
    archive();
    await withStore.attach({ workspaceId: "ws-1", path: "/p", sessionId: "chat_old" });
    expect((await listedAt("chat_old")).updatedAt).toBe(ARCHIVED_AT);

    await withStore.save("chat_old");

    expect(Date.parse((await listedAt("chat_old")).updatedAt)).toBeGreaterThan(
      Date.parse(ARCHIVED_AT),
    );
  });
});
