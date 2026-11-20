/**
 * `ChatRunner` 的用例：**一段会话一条常驻桥**（PLAN §5）。
 *
 * 断言的东西全是那三个口能说清的事实：
 *
 * - **投递**（`deliver`）：判两件事（会话在不在、agent 活不活）→ 入队；回执只有消息 id；
 * - **中断**（`abort`）：打到活着的 agent 上，关掉输出闸，不是杀死；
 * - **现读**（`state`）：忙闲 + 两道闸 + 死活 + inbox，不落库、不推算。
 *
 * 加两条结构性的：桥的生灭（agent 退役 / 被删 → 桥灭）与「变闲那一刻」（`onIdle`）。
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
import { AgentNS as AgentNSValue, sumUsage } from "@ai-zen/agents-core";

import type { Session } from "../storage/types.js";
import type { InboxInsertInput, StoredInboxEntry } from "../storage/InboxRepository.js";
import type { EventName } from "../wire/events.js";
import { HostError } from "../wire/errors.js";
import type {
  SessionChangedPayload,
  SessionChangeKind,
  MessageAddedPayload,
  MessageChangedPayload,
  StatePayload,
} from "../wire/events.js";
import { AgentRegistry } from "./AgentRegistry.js";
import type {
  AbortedStrategies,
  ChatEventEmitter,
  ChatRunnerOptions,
  SessionDeathKind,
  DeliveryInput,
  InboxStore,
} from "./ChatRunner.js";
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

const SESSION_ID = "c-bridge";
const WORKSPACE_ID = "ws-1";

function makeSession(): Session {
  return {
    id: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    name: "会话",
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
    // 刚建出来 / 还没答过交接题：没有待交接
    pendingHandoff: null,
    pinned: false,
    nameIsAuto: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * 记账式 inbox 仓储（结构上等于 `InboxRepository`，见那个文件的用例钉真表的列与级联）。
 *
 * `source` / `content` 存的时候走一遍 `JSON.stringify`、读的时候走 `JSON.parse` —— 与真仓储
 * 同一个口径：库里只能有「原样」那一份，读回来要能原样还回去（内容一个字都不清理）。
 */
class RecordingInboxStore implements InboxStore {
  /** 还排着的那几行（按入队顺序） */
  readonly rows: Array<{
    messageId: string;
    sessionId: string;
    /** JSON：core 的 `MessageSource` */
    source: string;
    /** JSON：core 的正文 */
    content: string;
    createdAt: string;
    seq: number;
  }> = [];
  /** 每一笔写（按发生顺序）：验「先进队、后取走」这个次序 */
  readonly writes: string[] = [];

  async insert(input: InboxInsertInput): Promise<void> {
    this.writes.push(`insert:${input.messageId}`);
    const seq = this.rows.filter((row) => row.sessionId === input.sessionId).length + 1;
    this.rows.push({
      messageId: input.messageId,
      sessionId: input.sessionId,
      source: JSON.stringify(input.source),
      content: JSON.stringify(input.content),
      createdAt: input.createdAt,
      seq,
    });
  }

  async listBySession(sessionId: string): Promise<StoredInboxEntry[]> {
    return this.rows
      .filter((row) => row.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq)
      .map((row) => ({
        messageId: row.messageId,
        createdAt: row.createdAt,
        source: JSON.parse(row.source) as AgentNS.MessageSource,
        content: JSON.parse(row.content) as AgentNS.MessageContent,
      }));
  }

  async deleteMany(messageIds: readonly string[]): Promise<number> {
    this.writes.push(`delete:${messageIds.join(",")}`);
    let removed = 0;
    for (const messageId of messageIds) {
      const at = this.rows.findIndex((row) => row.messageId === messageId);
      if (at < 0) continue;
      this.rows.splice(at, 1);
      removed += 1;
    }
    return removed;
  }

  async clearBySession(sessionId: string): Promise<number> {
    this.writes.push(`clear:${sessionId}`);
    let removed = 0;
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (this.rows[index]!.sessionId !== sessionId) continue;
      this.rows.splice(index, 1);
      removed += 1;
    }
    return removed;
  }
}

interface Harness {
  runner: ChatRunner;
  registry: AgentRegistry;
  store: RecordingMessageStore;
  /** inbox 的那张表（`inbox`） */
  inbox: RecordingInboxStore;
  clock: ManualClock;
  /** 每一次推出去的事件（按发生顺序） */
  pushed: Array<{ name: EventName; payload: unknown }>;
  /** 变闲那一刻被叫到的那几段会话 */
  idle: string[];
  /** 报「死」那一拍的记录（会话 id + **为什么**：真死 / 退役重建 / 会话被删） */
  dead: Array<{ sessionId: string; kind: SessionDeathKind }>;
  /** 装配过几次（每装配一次 agent 记一笔：复活那条用例要看它） */
  builds: string[];
  /** `ensurePersisted` 被叫过的 id（草稿落库就靠它看） */
  persisted: string[];
  /** 复活（`ChatRunner.start`）：这一段没有 agent 时装上，活着就是幂等 no-op */
  start(): Promise<boolean>;
  /** 投递（不给 `source` 就按用户本人说） */
  deliver(input: DeliveryInput): Promise<{ userMessageId: string }>;
  /**
   * 界面上按一次发送：**先复活、再投递**（PLAN §5.1 那个复合动作的另外两步与这里无关）。
   *
   * 这两个动作在宿主这一层是正交的，所以用例里也得自己编排 —— 本文件的主角是投递，
   * 所以把这固定搭配合成一句；要单验 `deliver` / `start` 的用例直接用那两个口。
   */
  say(input: DeliveryInput): Promise<{ userMessageId: string }>;
  /** 把后台的投递 / 写库推进到「没有立即的后续」为止 */
  settle(): Promise<void>;
  waitFor(check: () => boolean): Promise<void>;
  /** 等到这段会话真的闲下来（已经起来了、且那一格是 idle） */
  waitIdle(): Promise<void>;
  /** 推出去的那些事件里指定名字的载荷 */
  eventsOf<E extends EventName>(name: E): Array<unknown>;
  /** 库里这段会话的行（按写入顺序）；消息是整条那一个对象，这里只取要看的三格 */
  rows(): Promise<
    Array<{
      id: string;
      role: AgentNS.Role;
      content: AgentNS.MessageContent | undefined;
      status: AgentNS.MessageStatus | undefined;
    }>
  >;
}

function createHarness(
  options: {
    rounds?: FakeRound[];
    /**
     * 与上一任共用同一份库（消息 + inbox）：模拟「进程没了，库还在」——
     * 新的一条 runner 照着同一份库装第二次。
     */
    store?: RecordingMessageStore;
    inbox?: RecordingInboxStore;
    /**
     * 装配出来的 agent 先关着输出闸。
     *
     * 用例要验的是「放回来的那几条还排着」，而不取件正是它们能留在队列里的那个情形 ——
     * 闸一关，`deliver` 就不会把它们叫起来取走（闸本身怎么开怎么关是另一件事，不在这里验）。
     */
    pauseOnBuild?: boolean;
    /**
     * 这一段还是**草稿**（`session.create` 只发了 id，还没落库）：`sessions.get` 读不到它，
     * 只有 `ensurePersisted` 能把它写成真行。
     */
    draft?: boolean;
    /** 装配卡在这一拍上（验「装配窗口里投进来的话先收着」） */
    buildGate?: Promise<void>;
    /** 中断策略（缺省跟 core 一致：`fill` / `keep`）；验「策略从配置现读」时传 `drop` */
    abortedStrategies?: AbortedStrategies;
  } = {},
): Harness {
  const clock = new ManualClock();
  const store = options.store ?? new RecordingMessageStore();
  const inbox = options.inbox ?? new RecordingInboxStore();
  const session = makeSession();
  /** 草稿落库了没有（`ensurePersisted` 翻它一下，之后 `get` 就读得到） */
  let landed = options.draft !== true;
  /** 真的被叫过 `ensurePersisted` 的 id（验「草稿先落库再装配」） */
  const persisted: string[] = [];
  const { scope } = createFakeScope("/tmp/ai-zen-bridge");
  const scopes = new ScopeRegistry({ createScope: async () => scope });
  const pushed: Array<{ name: EventName; payload: unknown }> = [];
  const idle: string[] = [];
  const dead: Array<{ sessionId: string; kind: SessionDeathKind }> = [];
  const buildContexts: string[] = [];
  let idCursor = 0;

  const agents = new AgentRegistry({
    scopes,
    createAgent: async (context) => {
      buildContexts.push(context.sessionId);
      if (options.buildGate) await options.buildGate;
      const built = new FakeAgent(options.rounds ?? [{ deltas: [{ content: "好" }] }]);
      if (options.pauseOnBuild) built.pauseOutput();
      return built;
    },
  });

  const emit: ChatEventEmitter = (name, payload) => {
    pushed.push({ name, payload });
  };

  const runnerOptions: ChatRunnerOptions = {
    messages: store,
    // 中断策略：本文件不出配置，缺省取 core 的那份
    abortedStrategies: () => options.abortedStrategies ?? { toolRounds: "fill", messages: "keep" },
    // inbox 里还没被取走的那些（三条事件写它、装配时读它）
    inbox,
    sessions: {
      get: async (id: string) => (landed && id === session.id ? session : undefined),
      // 草稿先落库：本文件没有真库，所以「落库」就是把这个开关翻过来（之后 `get` 就读得到）
      ensurePersisted: async (id: string) => {
        if (id !== session.id) {
          throw new HostError("not_found", { params: { entity: "session" } });
        }
        if (!landed) {
          landed = true;
          persisted.push(id);
        }
        return session;
      },
    },
    scopes,
    agents,
    emit,
    clock,
    newId: () => `srv-${(idCursor += 1)}`,
    // 每到一片就写一次：用例要看的正是「落库跟着事件走」，节流会把那一刻推后
    streamWriteIntervalMs: 0,
    onIdle: (sessionId) => void idle.push(sessionId),
    onDead: (sessionId, kind) => {
      dead.push({ sessionId, kind });
    },
  };
  const runner = new ChatRunner(runnerOptions);

  const harness: Harness = {
    runner,
    registry: agents,
    store,
    inbox,
    clock,
    pushed,
    idle,
    dead,
    builds: buildContexts,
    persisted,
    start: () => runner.start(SESSION_ID),
    deliver: (input) => runner.deliver(SESSION_ID, input),
    say: async (input) => {
      await runner.start(SESSION_ID);
      return await runner.deliver(SESSION_ID, input);
    },
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
        const agent = agents.get(SESSION_ID);
        return agent !== undefined && agent.started && agent.state === "idle";
      });
      await harness.settle();
    },
    eventsOf: (name) => pushed.filter((event) => event.name === name).map((event) => event.payload),
    rows: async () => {
      const rows = await store.listBySession(SESSION_ID);
      return rows.map((row) => ({
        id: row.id,
        role: row.message.role,
        content: row.message.content,
        status: row.message.status,
      }));
    },
  };
  return harness;
}

/**
 * 推出去的最后一条 `session.changed` 是哪种变化（死活与交接都走这一条）。
 *
 * 死活没有自己的事件名：它只是 `session.changed` 的两种 `change`（`agent_started` /
 * `agent_gone`）—— 这样「没有 agent」就不会被挤回 `state` 那一格。
 */
function lastChange(harness: Harness, name: EventName): SessionChangeKind | undefined {
  const events = harness.eventsOf(name).map((it) => it as SessionChangedPayload);
  return events.at(-1)?.change;
}

/**
 * 造一条用户投递（最常走的那条路）。
 *
 * 投递本身只有 `{ content, source }` 两样：「它死了要不要叫起来」不在这张入参上（P0 接口正交，
 * PLAN §5.1）—— 要叫醒就先 `start`（用例里那个 `harness.say` 就是这两步，即界面上按一次发送）。
 */
function userSays(content: string): DeliveryInput {
  return { content, source: { kind: "user" } };
}

// ---------------------------------------------------------------------------
// 投递 → 事件到了就写库、推出去
// ---------------------------------------------------------------------------

describe("ChatRunner.deliver：投递进来，事件到了写一条", () => {
  it("投一条用户消息：回执只有消息 id；落地的用户消息与它引出的回答各落一行", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "收到。" }] }] });

    const receipt = await harness.say(userSays("你好"));
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

    await harness.say({
      content: "登录页的测试补齐了",
      source: { kind: "agent", label: "补测试" },
    });
    await harness.waitIdle();

    const rows = await harness.rows();
    const content = String(rows[0]!.content);
    expect(content.split("\n\n")[0]).toMatch(/^\/\/ 这条消息来自 补测试 自动推送（.+）$/);
    expect(content.split("\n\n")[1]).toBe("登录页的测试补齐了");
  });

  it("会话不存在 → `not_found`（且不留下任何东西）", async () => {
    const harness = createHarness();
    await expect(harness.runner.deliver("c-missing", userSays("没有人收了"))).rejects.toMatchObject(
      { code: "not_found" },
    );
    expect(harness.registry.get("c-missing")).toBeUndefined();
    expect(harness.pushed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 生死：投递不叫醒任何人；复活是另一个动作（`start`）
// ---------------------------------------------------------------------------

describe("ChatRunner.deliver：死的目标一律拒（`session_dead`），不管来源是谁", () => {
  it("死了就 `session_dead`：界面发的那一句、别的来源发的那一句，一模一样", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "接着来。" }] }] });

    // 先把这一段跑起来，让它有历史（第一句 + 它的回答）
    await harness.say(userSays("第一句"));
    await harness.waitIdle();
    expect((await harness.rows()).length).toBe(2);

    // 用户按杀死（= 硬着陆）
    harness.runner.forget(SESSION_ID);
    await harness.settle();
    expect(harness.registry.get(SESSION_ID)).toBeUndefined();
    // 读数的形状就是 wire 的 `SessionState`：这一段是谁、四件事各一格、以及这一刻是什么时候
    expect(harness.runner.state(SESSION_ID)).toEqual({
      sessionId: SESSION_ID,
      // 没有 agent：死活那一格是 false；忙闲与两道闸按「没有对象」报
      alive: false,
      status: "idle",
      inputPaused: false,
      outputPaused: false,
      inbox: [],
      // 死了就没有名册、也不在交接态：subagent 的话只在它自己那个对象里，agent 没了就一起没了
      subAgents: [],
      handoff: null,
      at: new Date(harness.clock.now()).toISOString(),
    });

    // **没有「创建者例外」**：界面那个发送按钮投的那一条与定时器投的那一条同一条下场 ——
    // 投递不叫醒任何人（PLAN §5.1）
    for (const source of [{ kind: "user" } as const, { kind: "system", label: "timer" } as const]) {
      await expect(
        harness.runner.deliver(SESSION_ID, { content: "死会话不收", source }),
      ).rejects.toMatchObject({ code: "session_dead" });
    }
    expect(harness.registry.get(SESSION_ID)).toBeUndefined();
    // 一个字节都不收、一个字节都不写：没装配、没入队
    expect(harness.builds).toEqual([SESSION_ID]);
    expect(harness.runner.state(SESSION_ID).inbox).toEqual([]);
  });

  it("先 `start` 再投：装配起来接着跑，历史一条不少", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "接着来。" }] }] });

    await harness.say(userSays("第一句"));
    await harness.waitIdle();
    expect(harness.runner.kill(SESSION_ID)).toBe(true);
    await harness.settle();
    expect(harness.runner.state(SESSION_ID).alive).toBe(false);

    // 界面按发送 = 客户端编排的两步（PLAN §5.1）：先复活，再投递
    await harness.start();
    await harness.deliver(userSays("人发的一句"));
    await harness.waitIdle();

    const revived = harness.registry.get(SESSION_ID);
    expect(revived).toBeDefined();
    // 真的重新装配了一个（不是把死的那个又挂上去：那个已经关门，不可复活）
    expect(harness.builds).toEqual([SESSION_ID, SESSION_ID]);
    // 历史一条不少地装进新 agent（先前的两句 + 这一次的两句）
    expect(revived!.messages.map((message) => message.content)).toEqual([
      "第一句",
      "接着来。",
      "人发的一句",
      "接着来。",
    ]);
    expect((await harness.rows()).map((row) => row.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
    ]);
  });

  it("`deliver` 不动闸：输出闸关着时投进去，`outputPaused` 仍是 `true`", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.say(userSays("先说一句"));
    await harness.waitIdle();
    // 闸关着（生产上：用户按了中断、或者按了暂停）
    harness.runner.pause(SESSION_ID);
    expect(harness.runner.state(SESSION_ID).outputPaused).toBe(true);

    await harness.deliver(userSays("再说一句"));

    // 投递只收不取，也不替谁开闸 —— 「继续」是客户端在投递之前自己调的那一手（PRD 4.4）
    expect(harness.registry.get(SESSION_ID)!.isOutputPaused).toBe(true);
    expect(harness.runner.state(SESSION_ID)).toMatchObject({
      outputPaused: true,
      inbox: [expect.objectContaining({ preview: "再说一句" })],
    });
  });
});

// ---------------------------------------------------------------------------
// 复活：`start` 只管「确保这段有 agent」
// ---------------------------------------------------------------------------

describe("ChatRunner.start：确保这段有 agent（不投递、不动闸）", () => {
  it("活的幂等：连调两次只装配一次，第二次回 `false`", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "好" }] }] });

    expect(await harness.start()).toBe(true);
    expect(await harness.start()).toBe(false);

    expect(harness.builds).toEqual([SESSION_ID]);
    expect(harness.registry.get(SESSION_ID)).toBeDefined();
    // 只做「有 agent」这一件：队列里一条也没多出来
    expect(harness.runner.state(SESSION_ID)).toMatchObject({ alive: true, inbox: [] });
  });

  it("草稿会话：先落库再装配（`ensurePersisted` 之后才读得到那一行）", async () => {
    const harness = createHarness({ draft: true });

    // 草稿在库里还没有行：投递连「目标」都找不到（`not_found`），复活才知道怎么办
    await expect(harness.deliver(userSays("草稿里的话"))).rejects.toMatchObject({
      code: "not_found",
    });
    expect(harness.builds).toEqual([]);

    expect(await harness.start()).toBe(true);
    // 落库那一步真的走过（写行 + 那条隐藏的 cwd 消息在 `SessionService` 里）
    expect(harness.persisted).toEqual([SESSION_ID]);
    expect(harness.builds).toEqual([SESSION_ID]);
    expect(harness.runner.state(SESSION_ID).alive).toBe(true);
  });

  it("不存在（不是草稿、库里也没有）→ `not_found`，一个 agent 都不装", async () => {
    const harness = createHarness();
    await expect(harness.runner.start("c-missing")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(harness.builds).toEqual([]);
  });

  it("装配窗口里投进来的话先收着，装好按到达顺序一次推给它（不等待、不丢）", async () => {
    const gate = deferred<void>();
    const harness = createHarness({ buildGate: gate.promise });

    const starting = harness.start();
    await harness.settle();
    // 这一拍它确实还没有 agent —— 但它不是死的：`start` 正在装它
    expect(harness.registry.get(SESSION_ID)).toBeUndefined();
    const first = await harness.deliver(userSays("装配中第一句"));
    const second = await harness.deliver(userSays("装配中第二句"));
    // 收在装配窗口里，界面上按到达顺序看得见（它们真的排着，只是还没人取）
    expect(harness.runner.state(SESSION_ID)).toMatchObject({
      alive: false,
      inbox: [
        expect.objectContaining({ preview: "装配中第一句" }),
        expect.objectContaining({ preview: "装配中第二句" }),
      ],
    });

    gate.resolve();
    expect(await starting).toBe(true);
    await harness.waitIdle();

    // 装好之后按到达顺序落地（回执里那两个 id 就是落地那两条）
    const users = (await harness.rows()).filter((row) => row.role === AgentNSValue.Role.User);
    expect(users.map((row) => row.id)).toEqual([first.userMessageId, second.userMessageId]);
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

    await harness.say(userSays("开跑"));
    await harness.waitFor(() => harness.registry.get(SESSION_ID)?.state === "working");

    expect(harness.runner.abort(SESSION_ID)).toBe(true);
    // 中断完输出闸关着（还能继续），agent 还在：这两件事各是一格
    expect(harness.runner.state(SESSION_ID).outputPaused).toBe(true);
    expect(harness.runner.state(SESSION_ID).alive).toBe(true);
    expect(harness.registry.get(SESSION_ID)).toBeDefined();

    gate.resolve();
    await harness.settle();
    // 闸动了走的是它自己那条事件（`output:paused`），不掺进 `state` 那一条
    expect(harness.eventsOf("output:paused")).toHaveLength(1);
    const states = harness.eventsOf("state").map((it) => it as StatePayload);
    expect(
      states.every((payload) => payload.status === "working" || payload.status === "idle"),
    ).toBe(true);

    // 死会话：没有可掐的东西
    harness.runner.forget(SESSION_ID);
    await harness.settle();
    expect(harness.runner.abort(SESSION_ID)).toBe(false);
  });

  it("中断之后：闸是关着的，投递不会替谁开闸（要开就明调 `resume`）", async () => {
    const gate = deferred<void>();
    const harness = createHarness({
      rounds: [{ gate: gate.promise, deltas: [{ content: "说到一半" }] }],
    });

    await harness.say(userSays("开跑"));
    await harness.waitFor(() => harness.registry.get(SESSION_ID)?.state === "working");
    harness.runner.abort(SESSION_ID);
    gate.resolve();
    await harness.settle();
    expect(harness.runner.state(SESSION_ID).outputPaused).toBe(true);

    // 投递进来两条（一条来自用户、一条来自外部）：两条都只是排队，没有一条顺手开闸
    await harness.deliver(userSays("外面推的"));
    await harness.deliver({
      content: "人按的",
      source: { kind: "user" },
    });
    expect(harness.registry.get(SESSION_ID)!.isOutputPaused).toBe(true);

    // 「用户点发送就是继续」这一手在客户端（PLAN §5.1）：它显式调 `resume`，闸才开
    expect(harness.runner.resume(SESSION_ID)).toBe(true);
    expect(harness.registry.get(SESSION_ID)!.isOutputPaused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 暂停 / 继续：只翻那道闸
// ---------------------------------------------------------------------------

describe("ChatRunner.pause / resume：只翻输出闸，不投任何东西", () => {
  it("暂停只关输出闸、继续只开闸：忙闲与死活一格都不动", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.say(userSays("说点什么"));
    await harness.waitIdle();
    expect(harness.runner.state(SESSION_ID).outputPaused).toBe(false);

    expect(harness.runner.pause(SESSION_ID)).toBe(true);
    // 关的是输出闸；它照样活着、手上照样没活（「闲」与「闸关」必须分得开）
    expect(harness.runner.state(SESSION_ID).outputPaused).toBe(true);
    expect(harness.runner.state(SESSION_ID)).toMatchObject({
      status: "idle",
      alive: true,
      inputPaused: false,
    });
    expect(harness.registry.get(SESSION_ID)!.isOutputPaused).toBe(true);

    expect(harness.runner.resume(SESSION_ID)).toBe(true);
    // 继续只开闸，不投任何东西：inbox 仍是空的
    expect(harness.runner.state(SESSION_ID)).toMatchObject({
      status: "idle",
      outputPaused: false,
      inbox: [],
    });
  });

  it("没有 agent（死的）回 false —— 没有闸可翻，不是错误", () => {
    const harness = createHarness();
    expect(harness.runner.pause(SESSION_ID)).toBe(false);
    expect(harness.runner.resume(SESSION_ID)).toBe(false);
  });

  it("交接期间 pause / resume 仍拒（`busy` / `handoff_in_progress`），但投递照收", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.say(userSays("说点什么"));
    await harness.waitIdle();
    // 交接开始：输出闸由这次交接自己关上（生产上关在写文档那一批的批头）
    harness.runner.beginHandoff(SESSION_ID);
    harness.registry.get(SESSION_ID)!.pauseOutput();

    expect(() => harness.runner.pause(SESSION_ID)).toThrowError(
      expect.objectContaining({
        code: "busy",
        detail: { sessionId: SESSION_ID, reason: "handoff_in_progress" },
      }) as unknown as Error,
    );
    expect(() => harness.runner.resume(SESSION_ID)).toThrowError(
      expect.objectContaining({
        code: "busy",
        detail: { sessionId: SESSION_ID, reason: "handoff_in_progress" },
      }) as unknown as Error,
    );
    // 一个也没生效：闸还是交接收口关上的那道
    expect(harness.registry.get(SESSION_ID)!.isOutputPaused).toBe(true);

    // 投递不拒：交接期间只关输出闸、不关输入闸 —— 话照收，排在 inbox 里
    await expect(harness.say(userSays("交接中说的话"))).resolves.toMatchObject({
      userMessageId: expect.any(String),
    });
    expect(harness.runner.state(SESSION_ID).inbox.map((item) => item.preview)).toEqual([
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
    expect(lastChange(harness, "session.changed")).toBeUndefined();

    await harness.say(userSays("说点什么"));
    await harness.waitIdle();
    // 装配出 agent 那一拍：这一段有了 agent
    expect(harness.eventsOf("session.changed")).toContainEqual(
      expect.objectContaining({ sessionId: SESSION_ID, change: "agent_started" }),
    );

    harness.runner.forget(SESSION_ID);
    await harness.settle();
    expect(lastChange(harness, "session.changed")).toBe("agent_gone");
    // 忙闲那条事件里只有 `working` / `idle`：死活一个字都没进过 `state`
    const states = harness.eventsOf("state").map((it) => it as StatePayload);
    expect(states.map((payload) => payload.status)).toEqual(["working", "idle"]);
  });

  it("两道闸各推自己的那一条：暂停/继续走 `output:*`，关门走 `input:*`", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.say(userSays("说点什么"));
    await harness.waitIdle();

    harness.runner.pause(SESSION_ID);
    harness.runner.resume(SESSION_ID);
    // 载荷只带会话 id（哪一道、开还是关由事件名说）
    expect(harness.eventsOf("output:paused")).toEqual([
      { sessionId: SESSION_ID, at: expect.any(String) },
    ]);
    expect(harness.eventsOf("output:resumed")).toEqual([
      { sessionId: SESSION_ID, at: expect.any(String) },
    ]);

    // 输入闸只有关门这一种生产（`stop` / `kill`）：关上门就报 `input:paused`
    harness.registry.get(SESSION_ID)!.pauseInput();
    expect(harness.eventsOf("input:paused")).toEqual([
      { sessionId: SESSION_ID, at: expect.any(String) },
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
  it("没有agent → `no_agent`", () => {
    const harness = createHarness();
    expect(harness.runner.canHandoffNow(SESSION_ID)).toEqual({
      ok: false,
      reason: "no_agent",
    });
  });

  it("手上有活 → `working`", async () => {
    const gate = deferred<void>();
    const harness = createHarness({
      rounds: [{ gate: gate.promise, deltas: [{ content: "说到一半" }] }],
    });
    await harness.say(userSays("开跑"));
    await harness.waitFor(() => harness.registry.get(SESSION_ID)?.state === "working");

    expect(harness.runner.canHandoffNow(SESSION_ID)).toEqual({
      ok: false,
      reason: "working",
    });

    gate.resolve();
    await harness.waitIdle();
  });

  it("输出闸关着 → `output_paused`", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.say(userSays("说点什么"));
    await harness.waitIdle();
    harness.registry.get(SESSION_ID)!.pauseOutput();

    expect(harness.runner.canHandoffNow(SESSION_ID)).toEqual({
      ok: false,
      reason: "output_paused",
    });
  });

  it("已经在交 → `handoff_in_progress`（它先于闸：交接期间闸本来就关着）", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.say(userSays("说点什么"));
    await harness.waitIdle();
    harness.runner.beginHandoff(SESSION_ID);
    // 交接期间闸也是关着的那一种处境：报的仍然是在交接，不是 output_paused
    harness.registry.get(SESSION_ID)!.pauseOutput();

    expect(harness.runner.canHandoffNow(SESSION_ID)).toEqual({
      ok: false,
      reason: "handoff_in_progress",
    });
  });

  it("闲着、闸开着、不在交接 → `ok`", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.say(userSays("说点什么"));
    await harness.waitIdle();

    expect(harness.runner.canHandoffNow(SESSION_ID)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// 交接期间照收（只关输出闸）+ 开始那一拍要报一声
// ---------------------------------------------------------------------------

describe("ChatRunner：交接期间照收、只关输出闸；开始那一刻推一条 `handoff_started`", () => {
  it("交接进行中投进来的话照收：投递成功、条目在 inbox 里，交接完成后按原顺序被取走", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });
    await harness.say(userSays("交接前"));
    await harness.waitIdle();

    // 交接开始：输出闸关上（这一任不取），输入闸照开
    harness.runner.beginHandoff(SESSION_ID);
    harness.registry.get(SESSION_ID)!.pauseOutput();

    const first = await harness.say(userSays("交接中第一句"));
    const second = await harness.say(userSays("交接中第二句"));
    // 投递成功：回执只有消息 id
    expect(first.userMessageId).toEqual(expect.any(String));
    expect(second.userMessageId).toEqual(expect.any(String));
    // 两条都在 inbox 里，顺序即取件顺序
    expect(harness.runner.state(SESSION_ID).inbox.map((item) => item.preview)).toEqual([
      "交接中第一句",
      "交接中第二句",
    ]);

    // 交接收口：摘牌 + 开闸（生产上开闸在交接收口那一处）
    harness.runner.endHandoff(SESSION_ID);
    harness.registry.get(SESSION_ID)!.resumeOutput();
    await harness.waitFor(() => harness.runner.state(SESSION_ID).inbox.length === 0);
    await harness.settle();

    // 交接期间收下的那两句一句没丢，按原顺序落成了用户消息
    const users = (await harness.rows()).filter((row) => row.role === AgentNSValue.Role.User);
    expect(users.map((row) => row.content)).toEqual(["交接前", "交接中第一句", "交接中第二句"]);
  });

  it("beginHandoff 之后收到一条 `session.changed`，`change === handoff_started`", () => {
    const harness = createHarness();
    harness.runner.beginHandoff(SESSION_ID);

    const changed = harness.eventsOf("session.changed").map((it) => it as SessionChangedPayload);
    expect(changed).toEqual([
      {
        sessionId: SESSION_ID,
        // 同步挂牌时读不到会话行：那一格给 `null`（客户端靠 id 定位）
        workspaceId: null,
        change: "handoff_started",
        at: expect.any(String) as unknown as string,
      },
    ]);
    // 交接态本身也读得出来（`state.handoff` 非空）
    expect(harness.runner.state(SESSION_ID).handoff).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 现读：四件事 + inbox
// ---------------------------------------------------------------------------

describe("ChatRunner.state：现读四件事与 inbox", () => {
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

    await harness.say(userSays("第一条"));
    await harness.waitFor(() => harness.registry.get(SESSION_ID)?.state === "working");

    // 它正卡在工具里：下一条只能排着
    await harness.say(userSays("第二条"));
    const readout = harness.runner.state(SESSION_ID);
    expect(readout.status).toBe("working");
    expect(readout.inbox.map((item) => item.preview)).toEqual(["第二条"]);
    expect(readout.inbox[0]!.source).toEqual({ kind: "user" });

    toolGate.resolve();
    await harness.waitIdle();

    // 取件点把它带走了：排队区空，它落成了库里的一条 user
    expect(harness.runner.state(SESSION_ID).inbox).toEqual([]);
    const users = (await harness.rows()).filter((row) => row.role === AgentNSValue.Role.User);
    expect(users.map((row) => row.content)).toEqual(["第一条", "第二条"]);
  });

  it("没 agent 就是死：死活是独立一格，不是忙闲里的一格", async () => {
    const harness = createHarness();
    // 读数的形状就是 wire 的 `SessionState`：这一段是谁、四件事各一格、以及这一刻是什么时候
    expect(harness.runner.state(SESSION_ID)).toEqual({
      sessionId: SESSION_ID,
      alive: false,
      status: "idle",
      inputPaused: false,
      outputPaused: false,
      inbox: [],
      // 死了就没有名册、也不在交接态：subagent 的话只在它自己那个对象里，agent 没了就一起没了
      subAgents: [],
      handoff: null,
      at: new Date(harness.clock.now()).toISOString(),
    });

    await harness.say(userSays("起来"));
    await harness.waitIdle();
    expect(harness.runner.state(SESSION_ID).status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// 变闲那一刻
// ---------------------------------------------------------------------------

describe("ChatRunner：变闲那一刻", () => {
  it("闲下来之后：写库已经落干净、报一格 idle、叫一次 onIdle", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "说完了" }] }] });

    await harness.say(userSays("说点什么"));
    await harness.waitIdle();
    await harness.waitFor(() => harness.idle.length === 1);

    // 这一跳只是「此刻它闲了」，不带任何结果
    expect(harness.idle).toEqual([SESSION_ID]);
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

describe("ChatRunner：一段会话一条桥", () => {
  it("同一段会话再跑一次还是同一个 agent（常驻），且落库接着往下写", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "回答" }] }] });

    await harness.say(userSays("第一句"));
    await harness.waitIdle();
    const first = harness.registry.get(SESSION_ID);

    await harness.say(userSays("第二句"));
    await harness.waitFor(() => harness.idle.length === 2);
    await harness.settle();

    // 桥是常驻的：同一个 agent（一段会话一个），历史在它内存里接着长
    expect(harness.registry.get(SESSION_ID)).toBe(first);
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
    await harness.say(userSays("一句"));
    await harness.waitIdle();
    const agent = harness.registry.get(SESSION_ID)!;

    harness.runner.forget(SESSION_ID);
    await harness.settle();

    expect(harness.registry.get(SESSION_ID)).toBeUndefined();
    // 硬着陆 = 真的死了（push 会抛 `closed`），不是「从账上消失而已」
    expect(() =>
      agent.push({ content: "往死的那一个投", priority: "high", source: { kind: "user" } }),
    ).toThrow();
    // 桥跟着灭：最后报的是「这一段没有 agent 了」，之后不再往外推任何东西
    expect(lastChange(harness, "session.changed")).toBe("agent_gone");
    const pushedAtDeath = harness.pushed.length;
    await harness.settle();
    expect(harness.pushed.length).toBe(pushedAtDeath);
    // 读数的形状就是 wire 的 `SessionState`：这一段是谁、以及这一刻是什么时候，也一起报
    expect(harness.runner.state(SESSION_ID)).toMatchObject({ alive: false, inbox: [] });
  });
});

describe("ChatRunner：报「死」时带上为什么死", () => {
  it("core 说 killed：`terminated`（真死，一次只报一条）", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "回答" }] }] });
    await harness.say(userSays("一句"));
    await harness.waitIdle();

    harness.registry.kill(SESSION_ID);
    await harness.settle();

    // 注册表随后还会报一条 `retired`（`session-deleted`）：桥已经灭了，不重报
    expect(harness.dead).toEqual([{ sessionId: SESSION_ID, kind: "terminated" }]);
  });

  it("退役（换模型 / 换思考档 / 配置变了）：`retired` —— 不是「这段没了」", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "回答" }] }] });
    await harness.say(userSays("一句"));
    await harness.waitIdle();

    // 空闲时改装配事实：当场退役（`SessionService.setModel` / `setThinking` 走的就是这一手）
    expect(harness.registry.invalidateSession(SESSION_ID)).toBe(true);
    await harness.settle();

    expect(harness.dead).toEqual([{ sessionId: SESSION_ID, kind: "retired" }]);
    // 「没有 agent 了」照报（那一瞬确实没有 agent），但**为什么**是退役，下游据此把题留着
    expect(lastChange(harness, "session.changed")).toBe("agent_gone");
  });

  it("forget：`forgotten`（会话被删，不是意外死）", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "回答" }] }] });
    await harness.say(userSays("一句"));
    await harness.waitIdle();

    harness.runner.forget(SESSION_ID);
    await harness.settle();

    // 先报「会话被删」再硬着陆：`kill` 同步广播的 `killed`（terminated）不会抢在前面
    expect(harness.dead).toEqual([{ sessionId: SESSION_ID, kind: "forgotten" }]);
  });
});

// ---------------------------------------------------------------------------
// 杀死：用户按的那一手（不是删除）
// ---------------------------------------------------------------------------

describe("ChatRunner.kill：用户按杀死（PRD 4.4 的三条死路之一）", () => {
  it("杀掉活着的会话：alive 为 false、inbox 空、库里那几行一条不剩，而消息一条不少", async () => {
    const toolGate = deferred<void>();
    const harness = createHarness({ rounds: [stuckInToolRound(toolGate.promise)] });

    // 第一条被取走、卡在工具里，后两句只能排着（各自落一行）
    await harness.say(userSays("第一条"));
    await harness.waitFor(() => harness.registry.get(SESSION_ID)?.state === "working");
    await harness.say(userSays("第二条"));
    await harness.say(userSays("第三条"));
    await harness.waitFor(() => harness.inbox.rows.length === 2);
    const messageIds = (await harness.rows()).map((row) => row.id);

    expect(harness.runner.kill(SESSION_ID)).toBe(true);
    await harness.settle();

    // 库里的 inbox 行跟着没了。这一条**只有**在「先 agents.kill、再拆桥」时才成立：
    // `agent.kill()` 同步广播的 `inboxCleared` 得有人听（桥先拆掉，那些行就留成孤行，
    // 下一次装配又被放回队列）
    await harness.waitFor(() => harness.inbox.rows.length === 0);
    expect(harness.inbox.writes.at(-1)).toBe(`clear:${SESSION_ID}`);

    // 死 = 这一段没有 agent 实例了，inbox 也空了
    expect(harness.registry.get(SESSION_ID)).toBeUndefined();
    expect(harness.runner.state(SESSION_ID)).toMatchObject({ alive: false, inbox: [] });

    // 杀死不是删除：消息一行不少（在途那条只是被掐断，不是没了）
    expect((await harness.rows()).map((row) => row.id)).toEqual(messageIds);

    toolGate.resolve();
    await harness.settle();
  });

  it("作废的那几条不会被下一次装配放回队列（杀了不会复活）", async () => {
    const toolGate = deferred<void>();
    // 上一任与这一任共用同一份库（进程没了 / 重开段会话，库还在）
    const store = new RecordingMessageStore();
    const inbox = new RecordingInboxStore();

    const before = createHarness({ store, inbox, rounds: [stuckInToolRound(toolGate.promise)] });
    await before.say(userSays("第一条"));
    await before.waitFor(() => before.registry.get(SESSION_ID)?.state === "working");
    await before.say(userSays("第二条"));
    await before.say(userSays("第三条"));
    await before.waitFor(() => inbox.rows.length === 2);

    expect(before.runner.kill(SESSION_ID)).toBe(true);
    await before.settle();
    // 库里那两行被清了 —— 所以「关掉再打开」时它们没有东西可恢复
    await before.waitFor(() => inbox.rows.length === 0);

    const after = createHarness({ store, inbox, pauseOnBuild: true });
    await after.say(userSays("重开之后的一句"));
    expect(after.runner.state(SESSION_ID).inbox.map((item) => item.preview)).toEqual([
      "重开之后的一句",
    ]);

    toolGate.resolve();
  });

  it("杀完再投报 `session_dead`（不复活）；先 `start` 才重新装配起来，历史一句不少", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "好" }] }] });
    await harness.say(userSays("第一句"));
    await harness.waitIdle();

    expect(harness.runner.kill(SESSION_ID)).toBe(true);
    await harness.settle();
    expect(harness.runner.state(SESSION_ID).alive).toBe(false);

    // 任何投递都不复活会话（PRD 4.2 / 4.4）：报「这段没了」，而不是叫起一个新的
    await expect(harness.deliver(userSays("外面的一句"))).rejects.toMatchObject({
      code: "session_dead",
    });
    expect(harness.runner.state(SESSION_ID).alive).toBe(false);
    expect(harness.builds).toEqual([SESSION_ID]);

    // 界面按发送的两步（PLAN §5.1）：先复活，再投 —— 记忆照旧在（会话行与消息一个字没动）
    await harness.start();
    await harness.deliver(userSays("人发的一句"));
    await harness.waitIdle();

    expect(harness.runner.state(SESSION_ID).alive).toBe(true);
    expect(harness.builds).toEqual([SESSION_ID, SESSION_ID]);
    expect(harness.runner.messagesOf(SESSION_ID)!.map((message) => message.content)).toEqual([
      "第一句",
      "好",
      "人发的一句",
      "好",
    ]);
  });

  it("本来就是死的：回 `false`，不抛错、一个字节都不写", () => {
    const harness = createHarness();

    expect(harness.runner.kill(SESSION_ID)).toBe(false);

    // 什么都没动：没有装配、没有落库、没有推事件
    expect(harness.builds).toEqual([]);
    expect(harness.store.writes).toEqual([]);
    expect(harness.inbox.writes).toEqual([]);
    expect(harness.pushed).toEqual([]);
  });

  it("交接期间拒（`busy` / `handoff_in_progress`）：agent 没被杀掉", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "好" }] }] });
    await harness.say(userSays("一句"));
    await harness.waitIdle();
    harness.runner.beginHandoff(SESSION_ID);

    expect(() => harness.runner.kill(SESSION_ID)).toThrowError(
      expect.objectContaining({
        code: "busy",
        detail: { sessionId: SESSION_ID, reason: "handoff_in_progress" },
      }) as unknown as Error,
    );
    // 一个也没生效：agent 还在（读数仍报活着）
    expect(harness.registry.get(SESSION_ID)).toBeDefined();
    expect(harness.runner.state(SESSION_ID).alive).toBe(true);

    harness.runner.endHandoff(SESSION_ID);
  });

  it("杀死只报一条 `agent_gone`（core 的 `killed` 不重报），并带上「为什么死」", async () => {
    const harness = createHarness({ rounds: [{ deltas: [{ content: "好" }] }] });
    await harness.say(userSays("一句"));
    await harness.waitIdle();

    harness.runner.kill(SESSION_ID);
    await harness.settle();

    const gone = (harness.eventsOf("session.changed") as SessionChangedPayload[]).filter(
      (payload) => payload.change === "agent_gone",
    );
    expect(gone).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, change: "agent_gone" }),
    ]);
    // 真死（`terminated`），不是「换一个 agent 接着干」的退役
    expect(harness.dead).toEqual([{ sessionId: SESSION_ID, kind: "terminated" }]);
  });
});

// ---------------------------------------------------------------------------
// subagent
// ---------------------------------------------------------------------------

describe("ChatRunner：subagent 的消息不落库，只推事件", () => {
  it("subagent 说的话一行也不写库，事件照推（带那次委派的 toolCallId）", async () => {
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

    await harness.say(userSays("交给助手"));
    await harness.waitIdle();

    // subagent 的话**不入库**（`CORE.md` §17）：它是临时工，不是一段会话。库是这条会话的转录，
    // 而它的话只在它自己那个对象里（要查就走 `messagesOf` 的名册那条路）。于是落库那份里只有
    // 主线的消息：subagent 开局那条（`sub-u`）与它后面写出来的那句都不在里面
    const mainline = new Set(
      (harness.runner.messagesOf(SESSION_ID) ?? []).map((message) => message.id),
    );
    expect(harness.store.writes.filter((row) => !mainline.has(row.id))).toEqual([]);
    expect(harness.store.writes.some((row) => row.id === "sub-u")).toBe(false);

    // 推出去时带 `toolCallId`，客户端据此把它归到那次委派那一栏（事件是重建那一栏的唯一来源）
    const deltas = harness.eventsOf("message.delta") as Array<{ toolCallId?: string }>;
    expect(deltas.some((payload) => payload.toolCallId === "t1")).toBe(true);
    const added = harness.eventsOf("message.added") as Array<{ toolCallId?: string }>;
    expect(added.some((payload) => payload.toolCallId === "t1")).toBe(true);

    // 名册：现读 core 的登记，跑完只看 `endedAt` 标上（不移除）
    const readout = harness.runner.state(SESSION_ID);
    expect(readout.subAgents).toEqual([{ toolCallId: "t1", name: "delegate", state: "ended" }]);

    // 它说过的话顺「父的名册 → 那个 subagent → 它的 `messages`」取：开局的任务 + 它的回答
    const subMessages = harness.runner.messagesOf(SESSION_ID, { toolCallId: "t1" });
    expect(subMessages?.map((message) => message.content)).toEqual(["办一下", "办好了"]);
  });

  /**
   * 委派花了多少是**消息身上的事实**，所以它跟 `usage` 走同一条 `data` 通道落库：
   * 不另开列、不靠宿主算，重开之后照样读得回来（PRD 3.9：累计必须含所有层级的 subagent）。
   */
  it("委派那一拍之后，落库的那条 tool 消息带着这次委派的用量", async () => {
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
            usage: { prompt_tokens: 700, completion_tokens: 70, total_tokens: 770 },
          },
        },
      ],
    });

    await harness.say(userSays("交给助手"));
    await harness.waitIdle();
    await harness.settle();

    const toolRow = harness.store.writes
      .filter((row) => row.message.role === AgentNSValue.Role.Tool)
      .at(-1);
    expect(toolRow?.message.subAgentUsage).toEqual({
      prompt_tokens: 700,
      completion_tokens: 70,
      total_tokens: 770,
    });
    // 与它自身那次响应的 `usage` 互斥：这条 tool 消息没有 `usage`
    expect(toolRow?.message.usage).toBeUndefined();
  });

  it("重开之后这个字段还在：从行里还原出来的消息带着它，一处求和即整棵树", async () => {
    const harness = createHarness();
    harness.store.seed({
      id: "a-row",
      sessionId: SESSION_ID,
      createdAt: 1,
      message: {
        id: "a-row",
        role: AgentNSValue.Role.Assistant,
        status: AgentNSValue.MessageStatus.Completed,
        content: "我派个人去查",
        usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
      },
    });
    harness.store.seed({
      id: "t-row",
      sessionId: SESSION_ID,
      createdAt: 2,
      message: {
        id: "t-row",
        role: AgentNSValue.Role.Tool,
        status: AgentNSValue.MessageStatus.Completed,
        content: "查完了",
        tool_call_id: "t1",
        // subagent 自己那条 tool 消息上的孙级已经含在里面了
        subAgentUsage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
      },
    });

    const messages = await harness.runner.reconcile(SESSION_ID);

    expect(messages.map((message) => message.id)).toEqual(["a-row", "t-row"]);
    expect(messages[1]?.subAgentUsage).toEqual({
      prompt_tokens: 200,
      completion_tokens: 30,
      total_tokens: 230,
    });
    // 这次委派那部分没有被写成第二份：整棵树一份求和
    expect(sumUsage(messages)).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 230,
      total_tokens: 1230,
    });
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
      sessionId: SESSION_ID,
      createdAt: 1,
      message: {
        id: "m1",
        role: AgentNSValue.Role.User,
        status: AgentNSValue.MessageStatus.Completed,
        content: "说过的话",
      },
    });
    harness.store.seed({
      id: "m2",
      sessionId: SESSION_ID,
      createdAt: 2,
      message: {
        id: "m2",
        role: AgentNSValue.Role.Assistant,
        status: AgentNSValue.MessageStatus.Pending,
        content: "说到一半",
      },
    });
    harness.store.seed({
      id: "m3",
      sessionId: SESSION_ID,
      createdAt: 3,
      // 一个字都没输出的那条：正文为空
      message: {
        id: "m3",
        role: AgentNSValue.Role.Assistant,
        status: AgentNSValue.MessageStatus.Writing,
      },
    });

    // 造这三行时的写不算：下面比的是「修复这一跳又写了哪几行」
    const written = harness.store.writes.length;

    const messages = await harness.runner.reconcile(SESSION_ID);

    expect(messages.map((message) => message.status)).toEqual([
      AgentNSValue.MessageStatus.Completed,
      // 已经吐出来的那半截留在上下文里（keep）
      AgentNSValue.MessageStatus.Completed,
      // 一个字都没输出的那条没有信息量，留在 aborted
      AgentNSValue.MessageStatus.Aborted,
    ]);
    // 只写真变了的那两行（m1 一个字不动）：返回值就是修完之后的消息，所以看仓储的记账
    expect(harness.store.writes.slice(written).map((row) => row.id)).toEqual(["m2", "m3"]);
    expect(harness.store.peek("m3")?.message.status).toBe(AgentNSValue.MessageStatus.Aborted);
  });

  it("策略从配置现读：`drop` 时那半截助手消息连库里的行一起删", async () => {
    const harness = createHarness({ abortedStrategies: { messages: "drop" } });
    harness.store.seed({
      id: "m1",
      sessionId: SESSION_ID,
      createdAt: 1,
      message: {
        id: "m1",
        role: AgentNSValue.Role.Assistant,
        status: AgentNSValue.MessageStatus.Pending,
        content: "说到一半",
      },
    });

    const messages = await harness.runner.reconcile(SESSION_ID);

    // `drop`：这条不该留在历史里，库里那行也不该在
    expect(messages).toEqual([]);
    expect(harness.store.peek("m1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// inbox 落库：进队 / 取走 / 清空，三条事件各写各的行
// ---------------------------------------------------------------------------

/** 一次请求卡在工具里的脚本：投递照收，但那几条只能排着（没人取走） */
function stuckInToolRound(toolGate: Promise<void>): FakeRound {
  return {
    deltas: [{ content: "先跑个工具" }],
    toolCalls: [{ id: "t1", name: "echo" }],
    toolGate,
  };
}

describe("ChatRunner：inbox 落库（一有变化就入库）", () => {
  it("进来一条落一行；被取走就删那一行（先进队、后离开）", async () => {
    const toolGate = deferred<void>();
    const harness = createHarness({ rounds: [stuckInToolRound(toolGate.promise)] });

    await harness.say(userSays("第一条"));
    await harness.waitFor(() => harness.registry.get(SESSION_ID)?.state === "working");

    // 第一条进来时落过一行，随即被取走 —— 库里那一行跟着没了
    await harness.waitFor(() => harness.inbox.writes.length >= 2);
    expect(harness.inbox.writes[0]).toMatch(/^insert:/);
    expect(harness.inbox.writes[1]).toMatch(/^delete:/);
    await harness.waitFor(() => harness.inbox.rows.length === 0);

    // 它卡在工具里：后面这两条只能排队，各自落一行（逐条实时写，不攒批）
    await harness.say(userSays("第二条"));
    await harness.say(userSays("第三条"));
    await harness.waitFor(() => harness.inbox.rows.length === 2);
    expect(harness.inbox.rows.map((row) => row.content)).toEqual([
      JSON.stringify("第二条"),
      JSON.stringify("第三条"),
    ]);
    expect(harness.inbox.rows.map((row) => row.source)).toEqual([
      JSON.stringify({ kind: "user" }),
      JSON.stringify({ kind: "user" }),
    ]);

    toolGate.resolve();
    await harness.waitIdle();
    // 取走 = 删行：库里一条不剩
    await harness.waitFor(() => harness.inbox.rows.length === 0);
  });

  it("`/clear` 之后库里干净（清空是作废，不是取件）", async () => {
    const toolGate = deferred<void>();
    const harness = createHarness({ rounds: [stuckInToolRound(toolGate.promise)] });

    await harness.say(userSays("第一条"));
    await harness.waitFor(() => harness.registry.get(SESSION_ID)?.state === "working");
    await harness.say(userSays("第二条"));
    await harness.say(userSays("第三条"));
    await harness.waitFor(() => harness.inbox.rows.length === 2);

    // 不取件的时候也照样清（清空不看输出闸），库里那两行一起没
    harness.runner.pause(SESSION_ID);
    expect(harness.runner.clearInbox(SESSION_ID)).toBe(2);
    await harness.waitFor(() => harness.inbox.rows.length === 0);
    expect(harness.inbox.writes.at(-1)).toBe(`clear:${SESSION_ID}`);

    toolGate.resolve();
    harness.runner.resume(SESSION_ID);
    await harness.waitIdle();
    expect(harness.inbox.rows).toEqual([]);
  });
  it("进程收尾（把 agent 全 kill 掉）不作废库里那些条目：下次打开它们还在等", async () => {
    const toolGate = deferred<void>();
    const harness = createHarness({ rounds: [stuckInToolRound(toolGate.promise)] });

    await harness.say(userSays("第一条"));
    await harness.waitFor(() => harness.registry.get(SESSION_ID)?.state === "working");
    await harness.say(userSays("第二条"));
    await harness.waitFor(() => harness.inbox.rows.length === 1);

    // `HostApp.stop()` 那一步：先标记「这是收尾」，再把 agent 全部硬着陆（存量在内存里作废）——
    // 但库里那几行是「上次没处理完的话」，必须留着（PRD 4.12：打开就是上次的样子）
    harness.runner.markShuttingDown();
    harness.registry.disposeAll();
    await harness.settle();
    expect(harness.inbox.rows.map((row) => row.content)).toEqual([JSON.stringify("第二条")]);
    expect(harness.inbox.writes.some((write) => write.startsWith("clear:"))).toBe(false);

    toolGate.resolve();
  });
});

// ---------------------------------------------------------------------------
// 关掉再打开：还没被取走的那几句还在（PRD 1.2 / 4.12）
// ---------------------------------------------------------------------------

describe("ChatRunner：装配时把还没被取走的条目放回", () => {
  it("未消费的那几句：顺序、createdAt、内容都与存下去的那一份逐字相同", async () => {
    const toolGate = deferred<void>();
    // 上一任与这一任共用同一份库（进程没了，库还在）
    const store = new RecordingMessageStore();
    const inbox = new RecordingInboxStore();

    const before = createHarness({ store, inbox, rounds: [stuckInToolRound(toolGate.promise)] });
    await before.say(userSays("第一句"));
    await before.waitFor(() => before.registry.get(SESSION_ID)?.state === "working");
    await before.say(userSays("第二句"));
    await before.say(userSays("第三句"));
    await before.say(userSays("第四句"));
    await before.waitFor(() => inbox.rows.length === 3);

    // 把「存下来的那一刻」改成很久以前：这一格要验的正是「读回来的是存下来的那个值，
    // 不是重启那一刻」，而真投递盖的时间在同一次用例里几乎落在同一毫秒
    const longAgo = [
      "2025-05-06T07:08:09.000Z",
      "2025-05-06T07:08:10.000Z",
      "2025-05-06T07:08:11.000Z",
    ];
    inbox.rows.forEach((row, index) => {
      row.createdAt = longAgo[index]!;
    });
    // 存下去的那三行（这一刻的库里的事实）
    const stored = inbox.rows.map((row) => ({ ...row }));

    // 「关掉」= 丢掉旧的 runner 与 registry（不 kill：kill 是「作废存量」，这里要验的正相反）
    const after = createHarness({ store, inbox, pauseOnBuild: true });
    await after.say(userSays("重启后的一句"));

    // 界面上看得见：放回来的那三句按原顺序排在队头，新投的那条在它们后面
    const readout = after.runner.state(SESSION_ID);
    expect(readout.inbox.map((item) => item.preview)).toEqual([
      "第二句",
      "第三句",
      "第四句",
      "重启后的一句",
    ]);
    // createdAt 是当时存下来的那一刻，不是「重启那一刻」
    expect(readout.inbox.slice(0, 3).map((item) => item.createdAt)).toEqual(longAgo);

    // 队列里那三条就是库里读回来的那三条：id / 时间 / 正文逐字相同（一个字段都没被重算）
    const restored = after.registry.get(SESSION_ID)!.inboxPending.slice(0, 3);
    expect(restored.map((entry) => JSON.stringify(entry.content))).toEqual(
      stored.map((row) => row.content),
    );
    expect(restored.map((entry) => entry.createdAt)).toEqual(stored.map((row) => row.createdAt));
    expect(restored.map((entry) => ("messageId" in entry ? entry.messageId : undefined))).toEqual(
      stored.map((row) => row.messageId),
    );
    // 恢复不是新变化：没有为它们再插一行 —— 库里那三行各只出现一次，多出来的只有新投的那一条
    const ids = inbox.rows.map((row) => row.messageId);
    expect(ids.filter((id) => stored.some((row) => row.messageId === id))).toEqual(
      stored.map((row) => row.messageId),
    );
    expect(ids).toHaveLength(stored.length + 1);
  });

  it("已经在记忆里的那条被扔掉（落地过、只是那一删丢了），它那一行也删掉", async () => {
    const store = new RecordingMessageStore();
    // 记忆里已经有这条消息：上一次它落地了，只是 `inboxTaken` 那一删没跑到
    store.seed({
      id: "m-已经落地",
      sessionId: SESSION_ID,
      createdAt: 1,
      message: {
        id: "m-已经落地",
        role: AgentNSValue.Role.User,
        status: AgentNSValue.MessageStatus.Completed,
        content: "落地过的一句",
      },
    });
    const inbox = new RecordingInboxStore();
    await inbox.insert({
      messageId: "m-已经落地",
      sessionId: SESSION_ID,
      source: { kind: "user" },
      content: "落地过的一句",
      createdAt: "2026-01-02T03:04:05.000Z",
    });
    await inbox.insert({
      messageId: "m-还在等",
      sessionId: SESSION_ID,
      source: { kind: "user" },
      content: "还在等的一句",
      createdAt: "2026-01-02T03:04:06.000Z",
    });

    const harness = createHarness({ store, inbox, pauseOnBuild: true });
    await harness.say(userSays("新的一句"));

    // 队列里只有「还在等的那一句」与新投的这一句：落地过的那条没有放回来
    const agent = harness.registry.get(SESSION_ID)!;
    expect(
      agent.inboxPending.map((entry) => ("messageId" in entry ? entry.messageId : undefined)),
    ).toEqual(["m-还在等", "srv-1"]);
    // 那一行也被删掉了（不删的话，每重启一次就白读一遍）；库里只剩「还在等的」与新投的那一条
    expect(inbox.rows.map((row) => row.messageId)).toEqual(["m-还在等", "srv-1"]);
    expect(inbox.writes).toContain("delete:m-已经落地");
  });
});
