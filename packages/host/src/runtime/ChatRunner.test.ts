/**
 * `ChatRunner` 的用例：**一段对话一条常驻桥**（PLAN §5）。
 *
 * 断言的东西全是那三个口能说清的事实：
 *
 * - **投递**（`deliver`）：判两件事（对话在不在、agent 活不活）→ 入队；回执只有消息 id；
 * - **中断**（`abort`）：打到活着的 agent 上，关掉输出闸，不是杀死；
 * - **现读**（`state`）：忙闲 + 两道闸 + 死活 + 待办，不落库、不推算。
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
import type {
  ConversationChangedPayload,
  ConversationChangeKind,
  MessageAddedPayload,
  MessageChangedPayload,
  StatePayload,
} from "../wire/events.js";
import { AgentRegistry } from "./AgentRegistry.js";
import type { ChatEventEmitter, ChatRunnerOptions, ConversationDeathKind, DeliveryInput } from "./ChatRunner.js";
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
    // 刚建出来 / 还没答过交接题：没有待办
    pendingHandoff: null,
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
  /** 报「死」那一拍的记录（对话 id + **为什么**：真死 / 退役重建 / 对话被删） */
  dead: Array<{ conversationId: string; kind: ConversationDeathKind }>;
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
  const dead: Array<{ conversationId: string; kind: ConversationDeathKind }> = [];
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
    onDead: (conversationId, kind) => {
      dead.push({ conversationId, kind });
    },
  };
  const runner = new ChatRunner(runnerOptions);

  const harness: Harness = {
    runner,
    registry: agents,
    store,
    clock,
    pushed,
    idle,
    dead,
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
 * 推出去的最后一条 `conversation.changed` 是哪种变化（死活与交接都走这一条）。
 *
 * 死活没有自己的事件名：它只是 `conversation.changed` 的两种 `change`（`agent_started` /
 * `agent_gone`）—— 这样「没有 agent」就不会被挤回 `state` 那一格。
 */
function lastChange(harness: Harness, name: EventName): ConversationChangeKind | undefined {
  const events = harness.eventsOf(name).map((it) => it as ConversationChangedPayload);
  return events.at(-1)?.change;
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
    // 读数的形状就是 wire 的 `ConversationState`：这一段是谁、四件事各一格、以及这一刻是什么时候
    expect(harness.runner.state(CONVERSATION_ID)).toEqual({
      conversationId: CONVERSATION_ID,
      // 没有 agent：死活那一格是 false；忙闲与两道闸按「没有对象」报
      alive: false,
      status: "idle",
      inputPaused: false,
      outputPaused: false,
      inbox: [],
      // 死了就没有名册、也不在交接态：子 agent 的话只在它自己那个对象里，agent 没了就一起没了
      subAgents: [],
      handoff: null,
      at: new Date(harness.clock.now()).toISOString(),
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
// 中断：打到活着的 agent 上，把输出闸关上
// ---------------------------------------------------------------------------

describe("ChatRunner.abort：打到活着的 agent 上", () => {
  it("活着就掐在途并把输出闸关上（不是杀死）；死了就返回 false", async () => {
    const gate = deferred<void>();
    const harness = createHarness({
      rounds: [{ gate: gate.promise, deltas: [{ content: "说到一半" }] }],
    });

    await harness.deliver(userSays("开跑"));
    await harness.waitFor(() => harness.registry.get(CONVERSATION_ID)?.state === "working");

    expect(harness.runner.abort(CONVERSATION_ID)).toBe(true);
    // 中断完输出闸关着（还能继续），agent 还在：这两件事各是一格
    expect(harness.runner.state(CONVERSATION_ID).outputPaused).toBe(true);
    expect(harness.runner.state(CONVERSATION_ID).alive).toBe(true);
    expect(harness.registry.get(CONVERSATION_ID)).toBeDefined();

    gate.resolve();
    await harness.settle();
    // 闸动了走的是它自己那条事件（`output:paused`），不掺进 `state` 那一条
    expect(harness.eventsOf("output:paused")).toHaveLength(1);
    const states = harness.eventsOf("state").map((it) => it as StatePayload);
    expect(states.every((payload) => payload.status === "working" || payload.status === "idle")).toBe(
      true,
    );

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
    expect(harness.runner.state(CONVERSATION_ID).outputPaused).toBe(true);

    // 自动推来的那一条：只是排队，不替他把闸开开（那不是他按的）
    await harness.deliver(userSays("外面推的", { mayStart: false }));
    expect(harness.registry.get(CONVERSATION_ID)!.isOutputPaused).toBe(true);

    // 用户点发送：开闸
    await harness.deliver(userSays("继续"));
    expect(harness.registry.get(CONVERSATION_ID)!.isOutputPaused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 暂停 / 继续：只翻那道闸
// ---------------------------------------------------------------------------

describe("ChatRunner.pause / resume：只翻输出闸，不投任何东西", () => {
  it("暂停只关输出闸、继续只开闸：忙闲与死活一格都不动", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.deliver(userSays("说点什么"));
    await harness.waitIdle();
    expect(harness.runner.state(CONVERSATION_ID).outputPaused).toBe(false);

    expect(harness.runner.pause(CONVERSATION_ID)).toBe(true);
    // 关的是输出闸；它照样活着、手上照样没活（「闲」与「闸关」必须分得开）
    expect(harness.runner.state(CONVERSATION_ID).outputPaused).toBe(true);
    expect(harness.runner.state(CONVERSATION_ID)).toMatchObject({
      status: "idle",
      alive: true,
      inputPaused: false,
    });
    expect(harness.registry.get(CONVERSATION_ID)!.isOutputPaused).toBe(true);

    expect(harness.runner.resume(CONVERSATION_ID)).toBe(true);
    // 继续只开闸，不投任何东西：待办仍是空的
    expect(harness.runner.state(CONVERSATION_ID)).toMatchObject({
      status: "idle",
      outputPaused: false,
      inbox: [],
    });
  });

  it("没有 agent（死的）回 false —— 没有闸可翻，不是错误", () => {
    const harness = createHarness();
    expect(harness.runner.pause(CONVERSATION_ID)).toBe(false);
    expect(harness.runner.resume(CONVERSATION_ID)).toBe(false);
  });

  it("交接期间 pause / resume 仍拒（`busy` / `handoff_in_progress`），但投递照收", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.deliver(userSays("说点什么"));
    await harness.waitIdle();
    // 交接开始：输出闸由这次交接自己关上（生产上关在写文档那一批的批头）
    harness.runner.beginHandoff(CONVERSATION_ID);
    harness.registry.get(CONVERSATION_ID)!.pauseOutput();

    expect(() => harness.runner.pause(CONVERSATION_ID)).toThrowError(
      expect.objectContaining({
        code: "busy",
        detail: { conversationId: CONVERSATION_ID, reason: "handoff_in_progress" },
      }) as unknown as Error,
    );
    expect(() => harness.runner.resume(CONVERSATION_ID)).toThrowError(
      expect.objectContaining({
        code: "busy",
        detail: { conversationId: CONVERSATION_ID, reason: "handoff_in_progress" },
      }) as unknown as Error,
    );
    // 一个也没生效：闸还是交接收口关上的那道
    expect(harness.registry.get(CONVERSATION_ID)!.isOutputPaused).toBe(true);

    // 投递不拒：交接期间只关输出闸、不关输入闸 —— 话照收，排在 inbox 里
    await expect(harness.deliver(userSays("交接中说的话"))).resolves.toMatchObject({
      userMessageId: expect.any(String),
    });
    expect(harness.runner.state(CONVERSATION_ID).inbox.map((item) => item.preview)).toEqual([
      "交接中说的话",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 四件事各走各的事件
// ---------------------------------------------------------------------------

describe("ChatRunner：四件事各走各的事件（忙闲 / 两道闸 / 死活）", () => {
  it("agent 起来报 `agent_started`；没了报 `agent_gone`（死活不挤进 `state`）", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    expect(lastChange(harness, "conversation.changed")).toBeUndefined();

    await harness.deliver(userSays("说点什么"));
    await harness.waitIdle();
    // 装配出驱动者那一拍：这一段有了 agent
    expect(harness.eventsOf("conversation.changed")).toContainEqual(
      expect.objectContaining({ conversationId: CONVERSATION_ID, change: "agent_started" }),
    );

    harness.runner.forget(CONVERSATION_ID);
    await harness.settle();
    expect(lastChange(harness, "conversation.changed")).toBe("agent_gone");
    // 忙闲那条事件里只有 `working` / `idle`：死活一个字都没进过 `state`
    const states = harness.eventsOf("state").map((it) => it as StatePayload);
    expect(states.map((payload) => payload.status)).toEqual(["working", "idle"]);
  });

  it("两道闸各推自己的那一条：暂停/继续走 `output:*`，关门走 `input:*`", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.deliver(userSays("说点什么"));
    await harness.waitIdle();

    harness.runner.pause(CONVERSATION_ID);
    harness.runner.resume(CONVERSATION_ID);
    // 载荷只带会话 id（哪一道、开还是关由事件名说）
    expect(harness.eventsOf("output:paused")).toEqual([
      { conversationId: CONVERSATION_ID, at: expect.any(String) },
    ]);
    expect(harness.eventsOf("output:resumed")).toEqual([
      { conversationId: CONVERSATION_ID, at: expect.any(String) },
    ]);

    // 输入闸只有关门这一种生产（`stop` / `kill`）：关上门就报 `input:paused`
    harness.registry.get(CONVERSATION_ID)!.pauseInput();
    expect(harness.eventsOf("input:paused")).toEqual([
      { conversationId: CONVERSATION_ID, at: expect.any(String) },
    ]);
    // 两道闸的动一条也没混进忙闲那一条
    const states = harness.eventsOf("state").map((it) => it as StatePayload);
    expect(states.map((payload) => payload.status)).toEqual(["working", "idle"]);
  });
});

// ---------------------------------------------------------------------------
// 交接准入：四条判据，全仓只此一处
// ---------------------------------------------------------------------------

describe("ChatRunner.canHandoffNow：能不能立刻接手一批交接", () => {
  it("没有驱动者 → `no_agent`", () => {
    const harness = createHarness();
    expect(harness.runner.canHandoffNow(CONVERSATION_ID)).toEqual({
      ok: false,
      reason: "no_agent",
    });
  });

  it("手上有活 → `working`", async () => {
    const gate = deferred<void>();
    const harness = createHarness({
      rounds: [{ gate: gate.promise, deltas: [{ content: "说到一半" }] }],
    });
    await harness.deliver(userSays("开跑"));
    await harness.waitFor(() => harness.registry.get(CONVERSATION_ID)?.state === "working");

    expect(harness.runner.canHandoffNow(CONVERSATION_ID)).toEqual({
      ok: false,
      reason: "working",
    });

    gate.resolve();
    await harness.waitIdle();
  });

  it("输出闸关着 → `output_paused`", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.deliver(userSays("说点什么"));
    await harness.waitIdle();
    harness.registry.get(CONVERSATION_ID)!.pauseOutput();

    expect(harness.runner.canHandoffNow(CONVERSATION_ID)).toEqual({
      ok: false,
      reason: "output_paused",
    });
  });

  it("已经在交 → `handoff_in_progress`（它先于闸：交接期间闸本来就关着）", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.deliver(userSays("说点什么"));
    await harness.waitIdle();
    harness.runner.beginHandoff(CONVERSATION_ID);
    // 交接期间闸也是关着的那一种处境：报的仍然是在交接，不是 output_paused
    harness.registry.get(CONVERSATION_ID)!.pauseOutput();

    expect(harness.runner.canHandoffNow(CONVERSATION_ID)).toEqual({
      ok: false,
      reason: "handoff_in_progress",
    });
  });

  it("闲着、闸开着、不在交接 → `ok`", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.deliver(userSays("说点什么"));
    await harness.waitIdle();

    expect(harness.runner.canHandoffNow(CONVERSATION_ID)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// 交接期间照收（只关输出闸）+ 开始那一拍要报一声
// ---------------------------------------------------------------------------

describe("ChatRunner：交接期间照收、只关输出闸；开始那一刻推一条 `handoff_started`", () => {
  it("交接进行中投进来的话照收：投递成功、条目在 inbox 里，交接完成后按原顺序被取走", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.deliver(userSays("交接前"));
    await harness.waitIdle();

    // 交接开始：输出闸关上（这一任不取），输入闸照开
    harness.runner.beginHandoff(CONVERSATION_ID);
    harness.registry.get(CONVERSATION_ID)!.pauseOutput();

    const first = await harness.deliver(userSays("交接中第一句"));
    const second = await harness.deliver(userSays("交接中第二句"));
    // 投递成功：回执只有消息 id
    expect(first.userMessageId).toEqual(expect.any(String));
    expect(second.userMessageId).toEqual(expect.any(String));
    // 两条都在 inbox 里，顺序即取件顺序
    expect(harness.runner.state(CONVERSATION_ID).inbox.map((item) => item.preview)).toEqual([
      "交接中第一句",
      "交接中第二句",
    ]);

    // 交接收口：摘牌 + 开闸（生产上开闸在交接收口那一处）
    harness.runner.endHandoff(CONVERSATION_ID);
    harness.registry.get(CONVERSATION_ID)!.resumeOutput();
    await harness.waitFor(() => harness.runner.state(CONVERSATION_ID).inbox.length === 0);
    await harness.settle();

    // 交接期间收下的那两句一句没丢，按原顺序落成了用户消息
    const users = (await harness.rows()).filter((row) => row.role === AgentNSValue.Role.User);
    expect(users.map((row) => row.content)).toEqual([
      "交接前",
      "交接中第一句",
      "交接中第二句",
    ]);
  });

  it("beginHandoff 之后收到一条 `conversation.changed`，`change === handoff_started`", () => {
    const harness = createHarness();
    harness.runner.beginHandoff(CONVERSATION_ID);

    const changed = harness
      .eventsOf("conversation.changed")
      .map((it) => it as ConversationChangedPayload);
    expect(changed).toEqual([
      {
        conversationId: CONVERSATION_ID,
        // 同步挂牌时读不到会话行：那一格给 `null`（客户端靠 id 定位）
        workspaceId: null,
        change: "handoff_started",
        at: expect.any(String) as unknown as string,
      },
    ]);
    // 交接态本身也读得出来（`state.handoff` 非空）
    expect(harness.runner.state(CONVERSATION_ID).handoff).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 现读：四件事 + 待办
// ---------------------------------------------------------------------------

describe("ChatRunner.state：现读四件事与待办", () => {
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
    expect(readout.status).toBe("working");
    expect(readout.inbox.map((item) => item.preview)).toEqual(["第二条"]);
    expect(readout.inbox[0]!.source).toEqual({ kind: "user" });

    toolGate.resolve();
    await harness.waitIdle();

    // 取件点把它带走了：排队区空，它落成了库里的一条 user
    expect(harness.runner.state(CONVERSATION_ID).inbox).toEqual([]);
    const users = (await harness.rows()).filter((row) => row.role === AgentNSValue.Role.User);
    expect(users.map((row) => row.content)).toEqual(["第一条", "第二条"]);
  });

  it("没 agent 就是死：死活是独立一格，不是忙闲里的一格", async () => {
    const harness = createHarness();
    // 读数的形状就是 wire 的 `ConversationState`：这一段是谁、四件事各一格、以及这一刻是什么时候
    expect(harness.runner.state(CONVERSATION_ID)).toEqual({
      conversationId: CONVERSATION_ID,
      alive: false,
      status: "idle",
      inputPaused: false,
      outputPaused: false,
      inbox: [],
      // 死了就没有名册、也不在交接态：子 agent 的话只在它自己那个对象里，agent 没了就一起没了
      subAgents: [],
      handoff: null,
      at: new Date(harness.clock.now()).toISOString(),
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
    expect(states.map((payload) => payload.status)).toEqual(["working", "idle"]);
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
    // 桥跟着灭：最后报的是「这一段没有 agent 了」，之后不再往外推任何东西
    expect(lastChange(harness, "conversation.changed")).toBe("agent_gone");
    const pushedAtDeath = harness.pushed.length;
    await harness.settle();
    expect(harness.pushed.length).toBe(pushedAtDeath);
    // 读数的形状就是 wire 的 `ConversationState`：这一段是谁、以及这一刻是什么时候，也一起报
    expect(harness.runner.state(CONVERSATION_ID)).toMatchObject({ alive: false, inbox: [] });
  });
});

describe("ChatRunner：报「死」时带上为什么死", () => {
  it("core 说 killed：`terminated`（真死，一次只报一条）", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "回答" }] }] });
    await harness.deliver(userSays("一句"));
    await harness.waitIdle();

    harness.registry.kill(CONVERSATION_ID);
    await harness.settle();

    // 注册表随后还会报一条 `retired`（`conversation-deleted`）：桥已经灭了，不重报
    expect(harness.dead).toEqual([{ conversationId: CONVERSATION_ID, kind: "terminated" }]);
  });

  it("退役（换模型 / 换思考档 / 配置变了）：`retired` —— 不是「这段没了」", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "回答" }] }] });
    await harness.deliver(userSays("一句"));
    await harness.waitIdle();

    // 空闲时改装配事实：当场退役（`ConversationService.setModel` / `setThinking` 走的就是这一手）
    expect(harness.registry.invalidateConversation(CONVERSATION_ID)).toBe(true);
    await harness.settle();

    expect(harness.dead).toEqual([{ conversationId: CONVERSATION_ID, kind: "retired" }]);
    // 「没有 agent 了」照报（那一瞬确实没有驱动者），但**为什么**是退役，下游据此把题留着
    expect(lastChange(harness, "conversation.changed")).toBe("agent_gone");
  });

  it("forget：`forgotten`（对话被删，不是意外死）", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "回答" }] }] });
    await harness.deliver(userSays("一句"));
    await harness.waitIdle();

    harness.runner.forget(CONVERSATION_ID);
    await harness.settle();

    // 先报「对话被删」再硬着陆：`kill` 同步广播的 `killed`（terminated）不会抢在前面
    expect(harness.dead).toEqual([{ conversationId: CONVERSATION_ID, kind: "forgotten" }]);
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
    // 而它的话只在它自己那个对象里（要查就走 `messagesOf` 的名册那条路）。于是落库那份里只有
    // 主线的消息：子 agent 开局那条（`sub-u`）与它后面写出来的那句都不在里面
    const mainline = new Set(
      (harness.runner.messagesOf(CONVERSATION_ID) ?? []).map((message) => message.id),
    );
    expect(harness.store.writes.filter((row) => !mainline.has(row.id))).toEqual([]);
    expect(harness.store.writes.some((row) => row.id === "sub-u")).toBe(false);

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

    // 造这三行时的写不算：下面比的是「修复这一跳又写了哪几行」
    const written = harness.store.writes.length;

    const messages = await harness.runner.reconcile(CONVERSATION_ID);

    expect(messages.map((message) => message.status)).toEqual([
      AgentNSValue.MessageStatus.Completed,
      // 已经吐出来的那半截留在上下文里（keep）
      AgentNSValue.MessageStatus.Completed,
      // 一个字都没输出的那条没有信息量，留在 aborted
      AgentNSValue.MessageStatus.Aborted,
    ]);
    // 只写真变了的那两行（m1 一个字不动）：返回值就是修完之后的消息（「写了哪几行」不在里面了，
    // 所以看仓储的记账）
    expect(harness.store.writes.slice(written).map((row) => row.id)).toEqual(["m2", "m3"]);
    expect(harness.store.peek("m3")?.status).toBe(AgentNSValue.MessageStatus.Aborted);
  });
});
