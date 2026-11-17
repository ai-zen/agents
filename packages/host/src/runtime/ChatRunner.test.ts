/**
 * `ChatRunner` 的用例：**一段对话一条常驻桥**（PLAN §5）。
 *
 * 断言的东西全是那三个口能说清的事实：
 *
 * - **投递**（`deliver`）：判两件事（对话在不在、agent 活不活）→ 入队；回执只有消息 id；
 * - **中断**（`abort`）：打到活着的 agent 上，落在「暂停」格，不是杀死；
 * - **现读**（`state`）：四格 + 待办，不落库、不推算。
 *
 * 加两条结构性的：桥的生灭（agent 退役 / 被删 → 桥灭）与「变闲那一刻」（`onIdle`）。
 *
 * 这里**不断言「轮」**（没有 `done`、没有产出清单、没有结算态），因为那些东西不存在。
 *
 * ## 为什么用真 core `Agent`
 *
 * 事件顺序全在 core 的循环里（`state:working` 先于落地、取件点在内循环末、`messageChanged` 才是
 * 定型）。假 agent 演不出来 —— 它的顺序是我们自己写的，红不了也绿不了。于是与
 * `TestSupport.FakeAgent`（真 `Agent`，只有模型那一侧是脚本）同一套做法，宿主的件全用真的：
 * `AgentRegistry` / `ScopeRegistry` / 记账式消息仓储 / 真的 `emit` 收集器。
 *
 * 不 sleep、不连网：卡点都是手动 resolve 的 `Deferred`。
 */

import { describe, expect, it } from "vitest";
import type { AgentNS } from "@ai-zen/agents-core";
import { AgentNS as AgentNSValue } from "@ai-zen/agents-core";

import type { Conversation } from "../storage/types.js";
import type { EventName } from "../wire/events.js";
import type { MessageAddedPayload, MessageChangedPayload, StatePayload } from "../wire/events.js";
import { AgentRegistry } from "./AgentRegistry.js";
import type { ChatEventEmitter, ChatRunnerOptions, DeliveryInput } from "./ChatRunner.js";
import { ChatRunner } from "./ChatRunner.js";
import { ScopeRegistry } from "./ScopeRegistry.js";
import {
  createFakeScope,
  deferred,
  FakeAgent,
  flushMicrotasks,
  ManualClock,
  RecordingMessageStore,
  type FakeRound,
} from "./TestSupport.js";

const CONVERSATION_ID = "c-bridge";
const WORKSPACE_ID = "ws-1";

function makeConversation(): Conversation {
  return {
    id: CONVERSATION_ID,
    workspaceId: WORKSPACE_ID,
    name: "对话",
    agentId: "default",
    modelId: "model-1",
    thinkingLevel: null,
    compactedAt: null,
    compactionMode: null,
    // v4 的四列：两条阈值跟模型走、开关关（用户建的那侧）、没有血缘
    handoffThreshold: null,
    guardThreshold: null,
    autoHandoff: false,
    lineage: null,
    pinned: false,
    nameIsAuto: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

interface Harness {
  runner: ChatRunner;
  registry: AgentRegistry;
  store: RecordingMessageStore;
  clock: ManualClock;
  /** 每一次推出去的事件（按发生顺序） */
  pushed: Array<{ name: EventName; payload: unknown }>;
  /** 变闲那一刻被叫到的那几段对话 */
  idle: string[];
  /** 装配过几次（每装配一次 agent 记一笔：复活那条用例要看它） */
  builds: string[];
  /** 投递（省掉重复的 `source` 样板：不给就按用户本人说） */
  deliver(input: DeliveryInput): Promise<{ userMessageId: string }>;
  /** 把后台的投递 / 写库推进到「没有立即的后续」为止 */
  settle(): Promise<void>;
  waitFor(check: () => boolean): Promise<void>;
  /** 等到这段对话真的闲下来（已经起来了、且那一格是 idle） */
  waitIdle(): Promise<void>;
  /** 推出去的那些事件里指定名字的载荷 */
  eventsOf<E extends EventName>(name: E): Array<unknown>;
  /** 库里这段对话的行（按写入顺序） */
  rows(): Promise<Array<{ id: string; role: string; content: unknown; status: string }>>;
}

function createHarness(options: { rounds?: FakeRound[] } = {}): Harness {
  const clock = new ManualClock();
  const store = new RecordingMessageStore();
  const conversation = makeConversation();
  const { scope } = createFakeScope("/tmp/ai-zen-bridge");
  const scopes = new ScopeRegistry({ createScope: async () => scope });
  const pushed: Array<{ name: EventName; payload: unknown }> = [];
  const idle: string[] = [];
  const buildContexts: string[] = [];
  let idCursor = 0;

  const agents = new AgentRegistry({
    scopes,
    createAgent: async (context) => {
      buildContexts.push(context.conversationId);
      return new FakeAgent(options.rounds ?? [{ deltas: [{ content: "好" }] }]);
    },
  });

  const emit: ChatEventEmitter = (name, payload) => {
    pushed.push({ name, payload });
  };

  const runnerOptions: ChatRunnerOptions = {
    messages: store,
    conversations: {
      get: async (id: string) => (id === conversation.id ? conversation : undefined),
    },
    scopes,
    agents,
    emit,
    clock,
    newId: () => `srv-${(idCursor += 1)}`,
    // 每到一片就写一次：用例要看的正是「落库跟着事件走」，节流会把那一刻推后
    streamWriteIntervalMs: 0,
    onIdle: (conversationId) => void idle.push(conversationId),
  };
  const runner = new ChatRunner(runnerOptions);

  const harness: Harness = {
    runner,
    registry: agents,
    store,
    clock,
    pushed,
    idle,
    builds: buildContexts,
    deliver: (input) => runner.deliver(CONVERSATION_ID, input),
    settle: async () => {
      for (let i = 0; i < 16; i += 1) await flushMicrotasks();
    },
    async waitFor(check) {
      for (let i = 0; i < 200; i += 1) {
        if (check()) return;
        await flushMicrotasks();
      }
      throw new Error("condition not reached");
    },
    async waitIdle() {
      // `state` 的初值也是 idle，所以「起来了」与「那一格」要一起看
      await harness.waitFor(() => {
        const agent = agents.get(CONVERSATION_ID);
        return agent !== undefined && agent.started && agent.state === "idle";
      });
      await harness.settle();
    },
    eventsOf: (name) =>
      pushed.filter((event) => event.name === name).map((event) => event.payload),
    rows: async () => {
      const rows = await store.listByConversation(CONVERSATION_ID);
      return rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        status: row.status,
      }));
    },
  };
  return harness;
}

/**
 * 造一条用户投递（最常走的那条路）。
 *
 * 这一段的第一句都从界面投进来（这个用例集模拟的就是「用户发消息」那一条路）：对话还没有驱动者时
 * 只有创建者能把它叫起来，所以第一句带 `mayStart`。后面几句加不加都一样（已经活着就不看这一格）。
 */
function userSays(content: string, extra: Partial<DeliveryInput> = {}): DeliveryInput {
  return { content, source: { kind: "user" }, mayStart: true, ...extra };
}

// ---------------------------------------------------------------------------
// 投递 → 事件到了就写库、推出去
// ---------------------------------------------------------------------------

describe("ChatRunner.deliver：投递进来，事件到了写一条", () => {
  it("投一条用户消息：回执只有消息 id；落地的用户消息与它引出的回答各落一行", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "收到。" }] }] });

    const receipt = await harness.deliver(userSays("你好"));
    // 回执里没有状态、没有「叫醒了没有」、没有结果
    expect(Object.keys(receipt)).toEqual(["userMessageId"]);

    await harness.waitIdle();

    const rows = await harness.rows();
    expect(rows.map((row) => row.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
    ]);
    // 落地那条用的就是回执里的 id（D5：客户端先画的那条与落地的是同一条）
    expect(rows[0]!.id).toBe(receipt.userMessageId);
    // 用户本人说的话不加来源注释（core 的 `{ kind: "user" }`）
    expect(rows[0]!.content).toBe("你好");
    expect(rows[1]!.content).toBe("收到。");
    expect(rows[1]!.status).toBe(AgentNSValue.MessageStatus.Completed);

    // 推出去的是整条 core 消息（`message.added` 建槽、`message.changed` 收口）
    const added = harness.eventsOf("message.added").map((it) => it as MessageAddedPayload);
    expect(added.map((payload) => payload.message.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
    ]);
    expect(harness.eventsOf("message.delta").length).toBeGreaterThan(0);
    const changed = harness.eventsOf("message.changed").map((it) => it as MessageChangedPayload);
    expect(changed.some((payload) => payload.message.id === rows[1]!.id)).toBe(true);
  });

  it("别的来源投进来：正文最前面带来源注释，库里的与模型看到的是同一份", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "看到了。" }] }] });

    await harness.deliver({
      content: "登录页的测试补齐了",
      source: { kind: "agent", label: "补测试" },
      // 这一段还没有驱动者，第一条由创建者叫起来（来源是谁与能不能起来是两回事）
      mayStart: true,
    });
    await harness.waitIdle();

    const rows = await harness.rows();
    const content = String(rows[0]!.content);
    expect(content.split("\n\n")[0]).toMatch(/^\/\/ 这条消息来自 补测试 自动推送（.+）$/);
    expect(content.split("\n\n")[1]).toBe("登录页的测试补齐了");
  });

  it("对话不存在 → `not_found`（且不留下任何东西）", async () => {
    const harness = createHarness();
    await expect(
      harness.runner.deliver("c-missing", userSays("没有人收了")),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(harness.registry.get("c-missing")).toBeUndefined();
    expect(harness.pushed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 生死：死对话投不进去，只有创建者能把它叫起来
// ---------------------------------------------------------------------------

describe("ChatRunner.deliver：死对话一律拒，只有创建者能叫起来（`mayStart`）", () => {
  it("外部来源投到死对话 → `conversation_dead`；`mayStart` 才装配起来接着跑", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "接着来。" }] }] });

    // 先把这一段跑起来，让它有历史（第一句 + 它的回答）
    await harness.deliver(userSays("第一句"));
    await harness.waitIdle();
    expect((await harness.rows()).length).toBe(2);

    // 用户按杀死（= 硬着陆，不可复活）
    harness.runner.forget(CONVERSATION_ID);
    await harness.settle();
    expect(harness.registry.get(CONVERSATION_ID)).toBeUndefined();
    expect(harness.runner.state(CONVERSATION_ID)).toEqual({
      status: "dead",
      inbox: [],
      // 死了就没有名册、也不在交接态：子 agent 的话只在它自己那个对象里，agent 没了就一起没了
      subAgents: [],
      handoff: null,
    });

    // 外面投进来：拒（这一条路不许死而复生）
    await expect(
      harness.deliver(userSays("外面的一句", { mayStart: false })),
    ).rejects.toMatchObject({
      code: "conversation_dead",
    });
    expect(harness.registry.get(CONVERSATION_ID)).toBeUndefined();

    // 界面那个发送按钮（创建者）：把它叫起来、再投递
    await harness.deliver(userSays("界面发的一句", { mayStart: true }));
    await harness.waitIdle();

    const revived = harness.registry.get(CONVERSATION_ID);
    expect(revived).toBeDefined();
    // 真的重新装配了一个（不是把死的那个又挂上去：那个已经关门，不可复活）
    expect(harness.builds).toEqual([CONVERSATION_ID, CONVERSATION_ID]);
    // 历史一条不少地装进新 agent（先前的两句 + 这一次的两句）
    expect(revived!.messages.map((message) => message.content)).toEqual([
      "第一句",
      "接着来。",
      "界面发的一句",
      "接着来。",
    ]);
    expect((await harness.rows()).map((row) => row.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
    ]);
  });

  it("`mayStart` 只认 `true`：给了别的真值也叫不起来", async () => {
    const harness = createHarness();
    await expect(
      harness.runner.deliver(CONVERSATION_ID, {
        content: "偷偷叫起来",
        source: { kind: "system", label: "timer" },
        // 类型上就不该是别的值；这一条防的是「真值判断」被写回来
        mayStart: false,
      }),
    ).rejects.toMatchObject({ code: "conversation_dead" });
    expect(harness.registry.get(CONVERSATION_ID)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 中断：打到活着的 agent 上，落在「暂停」格
// ---------------------------------------------------------------------------

describe("ChatRunner.abort：打到活着的 agent 上", () => {
  it("活着就掐在途并落在暂停格（不是杀死）；死了就返回 false", async () => {
    const gate = deferred<void>();
    const harness = createHarness({
      rounds: [{ gate: gate.promise, deltas: [{ content: "说到一半" }] }],
    });

    await harness.deliver(userSays("开跑"));
    await harness.waitFor(() => harness.registry.get(CONVERSATION_ID)?.state === "working");

    expect(harness.runner.abort(CONVERSATION_ID)).toBe(true);
    // 中断完是「暂停」：还能继续，agent 还在
    expect(harness.runner.state(CONVERSATION_ID).status).toBe("paused");
    expect(harness.registry.get(CONVERSATION_ID)).toBeDefined();

    gate.resolve();
    await harness.settle();
    const states = harness.eventsOf("state").map((it) => it as StatePayload);
    expect(states.map((payload) => payload.status)).toContain("paused");

    // 死对话：没有可掐的东西
    harness.runner.forget(CONVERSATION_ID);
    await harness.settle();
    expect(harness.runner.abort(CONVERSATION_ID)).toBe(false);
  });

  it("中断之后：用户点发送＝继续（开闸），别的来源不开闸", async () => {
    const gate = deferred<void>();
    const harness = createHarness({
      rounds: [{ gate: gate.promise, deltas: [{ content: "说到一半" }] }],
    });

    await harness.deliver(userSays("开跑"));
    await harness.waitFor(() => harness.registry.get(CONVERSATION_ID)?.state === "working");
    harness.runner.abort(CONVERSATION_ID);
    gate.resolve();
    await harness.settle();
    expect(harness.runner.state(CONVERSATION_ID).status).toBe("paused");

    // 自动推来的那一条：只是排队，不替他把闸开开（那不是他按的）
    await harness.deliver(userSays("外面推的", { mayStart: false }));
    expect(harness.registry.get(CONVERSATION_ID)!.isOutputPaused).toBe(true);

    // 用户点发送：开闸
    await harness.deliver(userSays("继续"));
    expect(harness.registry.get(CONVERSATION_ID)!.isOutputPaused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 现读：四格 + 待办
// ---------------------------------------------------------------------------

describe("ChatRunner.state：现读四格与待办", () => {
  it("忙时压着的那一条看得见（顺序即取件顺序），取走之后就不在了", async () => {
    const toolGate = deferred<void>();
    const harness = createHarness({
      rounds: [
        {
          deltas: [{ content: "先跑个工具" }],
          toolCalls: [{ id: "t1", name: "echo" }],
          toolGate: toolGate.promise,
        },
      ],
    });

    await harness.deliver(userSays("第一条"));
    await harness.waitFor(() => harness.registry.get(CONVERSATION_ID)?.state === "working");

    // 它正卡在工具里：下一条只能排着
    await harness.deliver(userSays("第二条"));
    const readout = harness.runner.state(CONVERSATION_ID);
    expect(readout.status).toBe("busy");
    expect(readout.inbox.map((item) => item.preview)).toEqual(["第二条"]);
    expect(readout.inbox[0]!.source).toEqual({ kind: "user" });

    toolGate.resolve();
    await harness.waitIdle();

    // 取件点把它带走了：排队区空，它落成了库里的一条 user
    expect(harness.runner.state(CONVERSATION_ID).inbox).toEqual([]);
    const users = (await harness.rows()).filter((row) => row.role === AgentNSValue.Role.User);
    expect(users.map((row) => row.content)).toEqual(["第一条", "第二条"]);
  });

  it("没 agent 就是死：四格里的「死」不是一格状态，是没有对象", async () => {
    const harness = createHarness();
    expect(harness.runner.state(CONVERSATION_ID)).toEqual({
      status: "dead",
      inbox: [],
      // 死了就没有名册、也不在交接态：子 agent 的话只在它自己那个对象里，agent 没了就一起没了
      subAgents: [],
      handoff: null,
    });

    await harness.deliver(userSays("起来"));
    await harness.waitIdle();
    expect(harness.runner.state(CONVERSATION_ID).status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// 变闲那一刻
// ---------------------------------------------------------------------------

describe("ChatRunner：变闲那一刻", () => {
  it("闲下来之后：写库已经落干净、报一格 idle、叫一次 onIdle", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });

    await harness.deliver(userSays("说点什么"));
    await harness.waitIdle();
    await harness.waitFor(() => harness.idle.length === 1);

    // 这一跳只是「此刻它闲了」，不带任何结果
    expect(harness.idle).toEqual([CONVERSATION_ID]);
    const states = harness.eventsOf("state").map((it) => it as StatePayload);
    expect(states.map((payload) => payload.status)).toEqual(["busy", "idle"]);
    // 「闲了」那一刻库里已经是完整的两行（不是落后一片的样子）
    const rows = await harness.rows();
    expect(rows.map((row) => row.content)).toEqual(["说点什么", "说完了"]);
  });
});

// ---------------------------------------------------------------------------
// 桥的生灭
// ---------------------------------------------------------------------------

describe("ChatRunner：一段对话一条桥", () => {
  it("同一段对话再跑一次还是同一个 agent（常驻），且落库接着往下写", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "回答" }] }] });

    await harness.deliver(userSays("第一句"));
    await harness.waitIdle();
    const first = harness.registry.get(CONVERSATION_ID);

    await harness.deliver(userSays("第二句"));
    await harness.waitFor(() => harness.idle.length === 2);
    await harness.settle();

    // 桥是常驻的：同一个 agent（一段对话一个），历史在它内存里接着长
    expect(harness.registry.get(CONVERSATION_ID)).toBe(first);
    expect(first!.messages.map((message) => message.content)).toEqual([
      "第一句",
      "回答",
      "第二句",
      "回答",
    ]);
    expect((await harness.rows()).map((row) => row.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
    ]);
  });

  it("forget：硬着陆那个 agent，桥跟着灭（之后再投一律拒）", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "回答" }] }] });
    await harness.deliver(userSays("一句"));
    await harness.waitIdle();
    const agent = harness.registry.get(CONVERSATION_ID)!;

    harness.runner.forget(CONVERSATION_ID);
    await harness.settle();

    expect(harness.registry.get(CONVERSATION_ID)).toBeUndefined();
    // 硬着陆 = 真的死了（push 会抛 `closed`），不是「从账上消失而已」
    expect(() =>
      agent.push({ content: "往死的那一个投", priority: "high", source: { kind: "user" } }),
    ).toThrow();
    // 桥跟着灭：最后报的那一格是「死」，之后这一段不再往外推任何东西
    const states = harness.eventsOf("state").map((it) => it as StatePayload);
    expect(states.at(-1)?.status).toBe("dead");
    const pushedAtDeath = harness.pushed.length;
    await harness.settle();
    expect(harness.pushed.length).toBe(pushedAtDeath);
    expect(harness.runner.state(CONVERSATION_ID)).toEqual({
      status: "dead",
      inbox: [],
      // 死了就没有名册、也不在交接态：子 agent 的话只在它自己那个对象里，agent 没了就一起没了
      subAgents: [],
      handoff: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 子 Agent
// ---------------------------------------------------------------------------

describe("ChatRunner：子 Agent 的消息不落库，只推事件", () => {
  it("子 agent 说的话一行也不写库，事件照推（带那次委派的 toolCallId）", async () => {
    const harness = createHarness({
      rounds: [
        {
          toolCalls: [{ id: "t1", name: "delegate" }],
          subAgent: {
            name: "helper",
            messages: [
              {
                id: "sub-u",
                role: AgentNSValue.Role.User,
                status: AgentNSValue.MessageStatus.Completed,
                content: "办一下",
              } as AgentNS.Message,
            ],
            stream: ["办好了"],
          },
        },
      ],
    });

    await harness.deliver(userSays("交给助手"));
    await harness.waitIdle();

    // 子 agent 的话**不入库**（`CORE.md` §17）：它是临时工，不是一段会话。库是这条对话的转录，
    // 而它的话只在它自己那个对象里（要查就走 `messagesOf` 的名册那条路）
    const delegated = harness.store.writes.filter((row) => row.parentToolCallId === "t1");
    expect(delegated).toEqual([]);

    // 推出去时带 `toolCallId`，客户端据此把它归到那次委派那一栏（事件是重建那一栏的唯一来源）
    const deltas = harness.eventsOf("message.delta") as Array<{ toolCallId?: string }>;
    expect(deltas.some((payload) => payload.toolCallId === "t1")).toBe(true);
    const added = harness.eventsOf("message.added") as Array<{ toolCallId?: string }>;
    expect(added.some((payload) => payload.toolCallId === "t1")).toBe(true);

    // 名册：现读 core 的登记，跑完只看 `endedAt` 标上（不移除）
    const readout = harness.runner.state(CONVERSATION_ID);
    expect(readout.subAgents).toEqual([{ toolCallId: "t1", name: "delegate", state: "ended" }]);

    // 它说过的话顺「父的名册 → 那个子 agent → 它的 `messages`」取：开局的任务 + 它的回答
    const subMessages = harness.runner.messagesOf(CONVERSATION_ID, { toolCallId: "t1" });
    expect(subMessages?.map((message) => message.content)).toEqual(["办一下", "办好了"]);
  });
});

// ---------------------------------------------------------------------------
// 装载即修复
// ---------------------------------------------------------------------------

describe("ChatRunner.reconcile：装载即修复", () => {
  it("在途的行当作被中断：有内容的按 keep 回收成 completed，没内容的留在 aborted；只写真变了的行", async () => {
    const harness = createHarness();
    harness.store.seed({
      id: "m1",
      conversationId: CONVERSATION_ID,
      role: AgentNSValue.Role.User as string,
      status: AgentNSValue.MessageStatus.Completed as string,
      content: "说过的话",
      createdAt: 1,
    });
    harness.store.seed({
      id: "m2",
      conversationId: CONVERSATION_ID,
      role: AgentNSValue.Role.Assistant as string,
      status: AgentNSValue.MessageStatus.Pending as string,
      content: "说到一半",
      createdAt: 2,
    });
    harness.store.seed({
      id: "m3",
      conversationId: CONVERSATION_ID,
      role: AgentNSValue.Role.Assistant as string,
      status: AgentNSValue.MessageStatus.Writing as string,
      content: null,
      createdAt: 3,
    });

    const result = await harness.runner.reconcile(CONVERSATION_ID);

    expect(result.messages.map((message) => message.status)).toEqual([
      AgentNSValue.MessageStatus.Completed,
      // 已经吐出来的那半截留在上下文里（keep）
      AgentNSValue.MessageStatus.Completed,
      // 一个字都没输出的那条没有信息量，留在 aborted
      AgentNSValue.MessageStatus.Aborted,
    ]);
    // 只写真变了的那两行（m1 一个字不动）
    expect(result.repairedIds).toEqual(["m2", "m3"]);
    expect(harness.store.peek("m3")?.status).toBe(AgentNSValue.MessageStatus.Aborted);
  });
});
