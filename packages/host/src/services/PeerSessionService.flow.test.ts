/**
 * 平级会话的**接线**验收（真 `ChatRunner` + 假/真 agent + 假模型流）：
 *
 *   1. 子会话跑完 → 父对话收到一条**以来源注释开头的**用户消息（来源就是 label 原样，
 *      拼注释的是 core）；父对话空闲时这一条把它**叫醒跑了真一段**（`run.state` 从 running 到
 *      settled）；
 *   2. 父对话**正在跑** → 那条结果排进它这一轮（`run.inbox` 里出现），不新起一轮；
 *   3. 子会话的用量记在**它自己那一轮**，**不**进父对话的 `subAgentUsage`；
 *   4. **`send_to_session`**：在跑 → `state: "running"`（条目在那一段的取件点落地，不新起段）；
 *      空闲 → `state: "idle"`（真的把它叫起来，自起段落库）；对方还没收工 → `state: "settling"`
 *      （先攚着，结算完再落地）；正文注释里的来源名是**调用者**（父用会话名 / peer 用自己的 label）。
 *   5. **回投挂在每一段结算上**：`create_session` 起的第一段只投**一次**（不是两次），之后
 *      `send_to_session` 叫起来的第二段结算**又**投一次 —— 这一条钉的就是「回投跟结算走，不跟
 *      `create` 走」（改前第二段跑完什么都不回投）。
 *
 * 投递只有**一个入口**（`chatRunner.deliver`）：服务不再先 `enqueue` 再 `run`，所以这里也不
 * 再有「猜爸爸在不在跑」的断言，只有「投进去之后它到底落在哪」的断言。
 *
 * 为什么单独一个文件：`ChatRunner` 的 inbox 语义、`source` 落成正文注释、自起段的现场与落库
 * 这几件事都只有「真执行者 + 真仓储」的组合才看得见（与 `ChatRunner.inbox.test.ts` 同一条
 * 理由）；服务自己的判断（深度、限额、拒绝、血缘、截断、投递的受理语义）在
 * `PeerSessionService.test.ts` 里钉。
 *
 * 不 sleep、不连网：假模型流的卡点是手动 resolve 的 `Deferred`。
 */

import { describe, expect, it } from "vitest";
import { Agent, AgentNS } from "@ai-zen/agents-core";

import type { ChatAgent, ChatTurn, TurnSettledFacts } from "../runtime/ChatRunner.js";
import { ChatRunner } from "../runtime/ChatRunner.js";
import { AgentRegistry } from "../runtime/AgentRegistry.js";
import { RunRegistry } from "../runtime/RunRegistry.js";
import { ScopeRegistry } from "../runtime/ScopeRegistry.js";
import type { FakeRound } from "../runtime/TestSupport.js";
import {
  createFakeScope,
  deferred,
  FakeAgent,
  flushMicrotasks,
  ManualClock,
  RecordingMessageStore,
  type Deferred,
} from "../runtime/TestSupport.js";
import type { Conversation, MessageUpsertInput, StoredMessage } from "../storage/types.js";
import type { ConversationCreateParams, ConversationCreateResult, ConversationView } from "../wire/index.js";
import { PeerSessionService } from "./PeerSessionService.js";
import type { PeerSessionConversationCreator } from "./PeerSessionService.js";

const PARENT_ID = "c-parent";

function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    workspaceId: "ws-1",
    name: id,
    pinned: false,
    agentId: "default",
    modelId: "model-1",
    thinkingLevel: null,
    compactedAt: null,
    compactionMode: null,
    nameIsAuto: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 子会话的诞生：与 `conversation.create` 一样把新会话登记进「库里」（ChatRunner 只认那一行） */
class RegisteringCreator implements PeerSessionConversationCreator {
  readonly created: ConversationCreateParams[] = [];
  private seq = 0;
  constructor(private readonly rows: Map<string, Conversation>) {}

  async create(params: ConversationCreateParams): Promise<ConversationCreateResult> {
    this.created.push(params);
    this.seq += 1;
    const id = `c-child-${this.seq}`;
    this.rows.set(
      id,
      conversation(id, { workspaceId: params.workspaceId, agentId: params.agentId }),
    );
    return { conversation: { id } as unknown as ConversationView };
  }

  async ensurePersisted(conversationId: string): Promise<Conversation> {
    const row = this.rows.get(conversationId);
    if (!row) throw new Error(`conversation ${conversationId} not registered`);
    return row;
  }
}

interface Harness {
  runner: ChatRunner;
  service: PeerSessionService;
  store: RecordingMessageStore;
  creator: RegisteringCreator;
  /** 每一段会话最近一次装配出来的 agent（要拿它当 `ctx.agent`） */
  agents: Map<string, Agent>;
  /** 每一轮的结算事实（`source` 就在这里） */
  settled: TurnSettledFacts[];
  /** 父对话（或任意会话）此刻那一轮 */
  turnOf(conversationId: string): ChatTurn | undefined;
  /** 把后台的投递 / 结算推进到「没有立即的后续」为止 */
  idle(): Promise<void>;
  waitFor(check: () => boolean): Promise<void>;
}

/**
 * 记账式仓储 + 一个卡点：第一笔命中 `gateOn` 的写进来时先停住。
 *
 * 这是「已经**受理**、现场还没建」那个窗口的可精确到达入口（`ChatRunner.run` 里 `runs.start`
 * 之后、`createRuntime` 之前正停在这里）。
 */
class GatedStore extends RecordingMessageStore {
  gateOn?: (row: MessageUpsertInput) => boolean;
  gate?: Deferred<void>;
  entered?: () => void;

  override async upsert(input: MessageUpsertInput): Promise<void> {
    const gate = this.gate;
    if (gate && this.gateOn?.(input)) {
      this.gate = undefined;
      this.gateOn = undefined;
      this.entered?.();
      await gate.promise;
    }
    await super.upsert(input);
  }
}

/** 造一套真接线：真 `ChatRunner`、真注册表、真记账仓储；假件只在模型那一侧 */
function createHarness(options: {
  /** 子会话说什么（每次装配 agent 时现算；返回 `FakeRound[]`） */
  childRounds?: () => FakeRound[];
  /**
   * 父对话的 agent 怎么造。缺省是假 agent（不演「叫醒」：假件没有段的生命周期）。
   *
   * 要看「投递把父对话叫起来跑了一段」时给它一个**真** core `Agent`（`scriptedAgent`）——
   * 那一路的全部难点（`status(running)` → 宿主同步建现场 → 落地 → 结算）都在 core 里，假件
   * 演不出来。
   */
  parentAgent?: () => ChatAgent;
  /** 子会话的 agent 怎么造（给了就用它，不看 `childRounds`） */
  childAgent?: (conversationId: string) => ChatAgent;
  /** 仓储（缺省一个新记账仓储；要卡点就传一个 `GatedStore`） */
  store?: RecordingMessageStore;
}): Harness {
  const clock = new ManualClock();
  const store = options.store ?? new RecordingMessageStore();
  const rows = new Map<string, Conversation>([[PARENT_ID, conversation(PARENT_ID)]]);
  const creator = new RegisteringCreator(rows);
  const { scope } = createFakeScope("/tmp/ai-zen-peer");
  const scopes = new ScopeRegistry({ createScope: async () => scope });
  const runs = new RunRegistry({ clock });
  const agents = new Map<string, Agent>();
  const settled: TurnSettledFacts[] = [];

  let idCursor = 0;
  // `chatRunner` 比 `agentRegistry` 后造：接线层（`app.ts`）也是这么接的 —— 闭包住一个可变引用，
  // 调用那一刻才去取
  let runner: ChatRunner | undefined;
  const registry = new AgentRegistry({
    scopes,
    runs,
    createAgent: async (context) => {
      let agent: ChatAgent;
      if (context.conversationId === PARENT_ID) {
        agent = options.parentAgent
          ? options.parentAgent()
          : new FakeAgent([]);
      } else {
        agent = options.childAgent
          ? options.childAgent(context.conversationId)
          : new FakeAgent(options.childRounds ? options.childRounds() : []);
      }
      // 宿主就是这么做的（`app.ts` 的 `defaultAgentFactory`）：造出 agent 之后登记它属于哪段会话
      service.bind(agent, context.conversationId);
      agents.set(context.conversationId, agent as unknown as Agent);
      return agent;
    },
    // 一段的边界（core 的 `status`）：agent 被 `deliver()` 叫醒的那一段没有受理，现场只能从
    // 这条事件里建（与 `app.ts` 同一条接线）
    onStatus: (event) => runner?.onAgentStatus(event),
  });

  runner = new ChatRunner({
    messages: store,
    conversations: { get: async (id: string) => rows.get(id) },
    scopes,
    runs,
    agents: registry,
    emit: () => {},
    clock,
    newId: () => `srv-${(idCursor += 1)}`,
    streamWriteIntervalMs: 0,
    onTurnSettled: (facts) => {
      settled.push(facts);
      // 与 `app.ts` 同一条接线：一段结算 → 若这段会话是派生会话，就把这一段的结果投回父对话
      // （回投不在这里判，`settleSegment` 只看 `records` 里有没有它）
      void service.settleSegment(facts);
    },
  });

  const service = new PeerSessionService({
    conversations: { get: async (id: string) => rows.get(id) },
    conversationCreator: creator,
    messages: { listByConversation: async (id: string) => await listMain(store, id) },
    chatRunner: {
      run: (params) => runner.run(params),
      deliver: (conversationId, input) => runner.deliver(conversationId, input),
    },
    now: () => clock.now(),
    onError: () => {},
  });

  return {
    runner,
    service,
    store,
    creator,
    agents,
    settled,
    turnOf: (conversationId) => runner.turn(conversationId),
    idle: async () => {
      for (let i = 0; i < 12; i += 1) await flushMicrotasks();
    },
    async waitFor(check) {
      for (let i = 0; i < 60; i += 1) {
        if (check()) return;
        await flushMicrotasks();
      }
      throw new Error("condition not reached");
    },
  };
}

/** 仓储里某段会话的主线消息（本服务读的就是这一份） */
async function listMain(store: RecordingMessageStore, conversationId: string): Promise<StoredMessage[]> {
  return await store.listByConversation(conversationId);
}

// ---------------------------------------------------------------------------
// 真 core `Agent` + 脚本化假流（与 `ChatRunner.selfStart.test.ts` 同一套做法）
// ---------------------------------------------------------------------------

/** 一个 chunk（只填 core 用到的两格） */
function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/**
 * 按脚本吐正文的真 core `Agent`：第 n 次请求回 `texts[n]`，然后停。
 *
 * 为什么要真 `Agent`：条目「投递到静态的父对话 → 它自己起一段 → 落库 → 结算」这条链的难点全在
 * core 的时序里（`status(running)` 先于 inbox 落地、`flushInbox` 在段体之前），假 agent 演不出来。
 */
function scriptedAgent(texts: string[]): ChatAgent {
  let cursor = 0;
  const script = texts.slice();
  const round = (): unknown[] => {
    const text = script[cursor] ?? "（脚本用完了）";
    cursor += 1;
    return [chunk({ content: text }), chunk({}, "stop")];
  };
  const client = {
    chat: {
      completions: {
        create: async () => {
          const data = round();
          return {
            async *[Symbol.asyncIterator]() {
              for (const item of data) yield item;
            },
          };
        },
      },
    },
  } as unknown as ConstructorParameters<typeof Agent>[0]["client"];
  return new Agent({ client, model: "gpt-4" }) as unknown as ChatAgent;
}

/** 父对话的那个 agent（工具回调里的 `ctx.agent`） */
function callerOf(h: Harness, conversationId = PARENT_ID): Agent {
  const agent = h.agents.get(conversationId);
  if (!agent) throw new Error(`no agent built for ${conversationId}`);
  return agent;
}

/** 父对话里由投递产生的用户消息（正文带来源注释的那一条；同一条按 id 去重，取最后一笔写） */
function deliveredRows(h: Harness): Array<{ id: string; content: unknown }> {
  const byId = new Map<string, { id: string; content: unknown }>();
  for (const row of h.store.writes) {
    if (row.conversationId !== PARENT_ID) continue;
    if (row.role !== AgentNS.Role.User) continue;
    if (typeof row.content !== "string" || !row.content.startsWith("// 这条消息来自")) continue;
    byId.set(row.id, { id: row.id, content: row.content });
  }
  return [...byId.values()];
}

/** 父对话那个 agent 的 inbox（假 agent 不会取件，于是「投了几次」就数它） */
function parentInbox(h: Harness): AgentNS.InboxEntry[] {
  const agent = h.agents.get(PARENT_ID) as unknown as FakeAgent | undefined;
  return agent ? agent.inbox : [];
}

describe("平级会话：子会话跑完 → 父对话收到结果", () => {
  it("父对话空闲 → 投递把它叫醒跑一段（真 turn + 落库），正文以来源注释开头", async () => {
    const h = createHarness({
      childRounds: () => [
        { deltas: [{ content: "补了" }, { content: " 3 个用例，全绿。" }], usage: usage(120, 30) },
      ],
      // 父对话用真 core `Agent`：这一条要看的正是「静态的 agent 被投递叫醒跑了一段」
      parentAgent: () => scriptedAgent(["先看着，我这就去。", "收到，我接着干。"]),
    });

    // 父对话先跑一轮，好让它那个 agent 被装配出来（工具回调里拿到的就是它）
    const seeding = await h.runner.run({
      conversationId: PARENT_ID,
      input: { content: "你先看看项目" },
    });
    await seeding.done;

    const created = await h.service.create({
      caller: callerOf(h),
      prompt: "把登录页的测试补齐",
      label: "补测试",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    // 子会话跑完（假流立刻结束），服务在结算之后投递 → 父对话空闲 → 起一段
    await h.waitFor(() => h.service.record(created.sessionId)?.resultDelivered === "delivered");
    // 那一段是投递叫起来的自起段：等它把那条消息落库、并把 answering 走完
    await h.waitFor(() =>
      deliveredRows(h).some((row) => typeof row.content === "string"),
    );
    await h.idle();

    const rows = deliveredRows(h);
    expect(rows).toHaveLength(1);
    const content = rows[0]!.content as string;
    // 逐字：core 的 `inboxEntryContent` 拼的那一行 + 子会话最后一条助手消息
    expect(content.split("\n\n")[0]).toMatch(/^\/\/ 这条消息来自 补测试 自动推送（.+）$/);
    expect(content.split("\n\n")[1]).toBe("补了 3 个用例，全绿。");

    // 它真的跑了一段：那一段的回答也落库了（父子两段各自一行 assistant）
    const parentRows = await listMain(h.store, PARENT_ID);
    expect(parentRows.map((row) => row.role)).toEqual([
      AgentNS.Role.User,
      AgentNS.Role.Assistant,
      AgentNS.Role.User,
      AgentNS.Role.Assistant,
    ]);
    expect(parentRows[3]!.content).toBe("收到，我接着干。");

    // 叫醒那一轮的 `source` 不是 `user`：所以交接线不会给没人看的对话挂问题
    // （自起段的来源在宿主这一层只答得出「不是用户，是投递」，见 `SOURCE_INBOX`）
    const wake = h.settled.filter(
      (facts) => facts.conversationId === PARENT_ID && facts.source !== "user",
    );
    expect(wake).toHaveLength(1);
    expect(wake[0]!.conversationId).toBe(PARENT_ID);
    // 子会话自己那一轮的来源是「父对话」（它的正文最前面那行注释也这么写）
    const childSettled = h.settled.filter((facts) => facts.conversationId === created.sessionId);
    expect(childSettled.map((facts) => facts.source)).toEqual(["父对话"]);
  });

  it("父对话正在跑 → 那条结果排进它这一轮（run.inbox 里出现），不新起一轮", async () => {
    const parentGate: Deferred<void> = deferred<void>();
    const childGate: Deferred<void> = deferred<void>();
    const h = createHarness({
      childRounds: () => [{ gate: childGate.promise, deltas: [{ content: "子会话说完了" }] }],
      parentAgent: () =>
        new FakeAgent([{ gate: parentGate.promise, deltas: [{ content: "我在忙" }] }]),
    });

    // 父对话正在跑一轮（卡在等首字）
    const parentTurn = await h.runner.run({ conversationId: PARENT_ID, input: { content: "忙起来" } });

    const created = await h.service.create({ caller: callerOf(h), prompt: "并行去查一下" });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    // 子会话跑完 → 投递：父对话在跑，于是入队（不是再起一轮）
    childGate.resolve();
    await h.waitFor(() => h.service.record(created.sessionId)?.resultDelivered === "delivered");

    // 还是同一轮：没有第二个父对话轮次
    expect(h.turnOf(PARENT_ID)).toBe(parentTurn);
    const inbox = parentTurn.runState().inbox;
    expect(inbox).toHaveLength(1);
    // 缺省 label 本身就是「会话 N」：source 原样用它，于是正文读作「来自 会话 1 自动推送」
    expect(inbox[0]!.source).toBe("会话 1");
    expect(inbox[0]!.preview).toBe("子会话说完了");

    // 放行父对话，让它安静收尾
    parentGate.resolve();
    await parentTurn.done;
  });
});

describe("回投挂在「每一段结算」上（真 ChatRunner）", () => {
  it("子会话第一段（create_session 起的那段）结算 → 只回投一次，不是两次", async () => {
    const h = createHarness({
      childRounds: () => [{ deltas: [{ content: "第一段：查完了。" }] }],
      // 父对话用假 agent（不会自起段）：这一条要数的是「投了几次」，不是「被叫起来之后干了什么」
      parentAgent: () => new FakeAgent([]),
    });
    const seeding = await h.runner.run({ conversationId: PARENT_ID, input: { content: "先热身" } });
    await seeding.done;

    const created = await h.service.create({ caller: callerOf(h), prompt: "去查一下", label: "查" });
    if (!created.ok) throw new Error("unreachable");
    await h.waitFor(() => parentInbox(h).length >= 1);
    await h.idle();

    // 一次，不是两次：改前那一句 `turn.done.then(...)` 与这一条结算都还在的话，这里会是 2
    expect(parentInbox(h)).toHaveLength(1);
    expect(parentInbox(h)[0]!.source).toBe("查");
    expect(String(parentInbox(h)[0]!.content)).toContain("第一段：查完了。");
    expect(h.service.record(created.sessionId)?.resultDelivered).toBe("delivered");
  });

  it("之后父 send_to_session → 子第二段结算 → 又回投一次（本单修的那个洞）", async () => {
    const h = createHarness({
      // 真 core `Agent`：第二段是被投递**叫醒**的自起段，只有真的段才演得出来
      childAgent: () => scriptedAgent(["第一段：查完了。", "第二段：边界用例也补上了。"]),
      parentAgent: () => new FakeAgent([]),
    });
    const seeding = await h.runner.run({ conversationId: PARENT_ID, input: { content: "先热身" } });
    await seeding.done;

    const created = await h.service.create({ caller: callerOf(h), prompt: "去查一下", label: "查" });
    if (!created.ok) throw new Error("unreachable");
    // 第一段跑完 → 回投一次（父对话是假 agent，条目留在它的 inbox 里）
    await h.waitFor(() => parentInbox(h).length === 1 && h.turnOf(created.sessionId) === undefined);
    await h.idle();

    // 父接着跟子说话：子会话空闲 → 被叫起来跑第二段
    const sent = await h.service.send({
      caller: callerOf(h),
      sessionId: created.sessionId,
      content: "再补一下边界用例",
    });
    expect(sent).toEqual({ ok: true, state: "idle" });

    // 第二段结算 → 又回投一次（改前：这条路上什么都没推回来）
    await h.waitFor(() => parentInbox(h).length >= 2);
    await h.idle();

    expect(parentInbox(h)).toHaveLength(2);
    // 正文是**第二段**最后说的那句话，不是第一段的
    expect(String(parentInbox(h)[1]!.content)).toContain("第二段：边界用例也补上了。");
    expect(parentInbox(h)[1]!.source).toBe("查");
  });
});

describe("平级会话：用量口径", () => {
  it("子会话的用量记在它自己那一轮，不进父对话的 subAgentUsage", async () => {
    const h = createHarness({
      childRounds: () => [{ deltas: [{ content: "我做完了" }], usage: usage(1000, 500) }],
      parentAgent: () => new FakeAgent([{ deltas: [{ content: "收到" }], usage: usage(20, 2) }]),
    });

    const seeding = await h.runner.run({ conversationId: PARENT_ID, input: { content: "先热身" } });
    await seeding.done;

    const created = await h.service.create({ caller: callerOf(h), prompt: "跑一个长任务" });
    if (!created.ok) throw new Error("unreachable");
    await h.waitFor(() => h.service.record(created.sessionId)?.resultDelivered === "delivered");
    await h.idle();

    // 子会话自己那一行上记着它花的钱
    const childAssistant = h.store.writes.filter(
      (row) => row.conversationId === created.sessionId && row.role === AgentNS.Role.Assistant,
    );
    expect(childAssistant.some((row) => row.data?.usage !== undefined)).toBe(true);

    // 父对话那些行一个 `subAgentUsage` 都没有：平级会话不是子代理（两套口径，绝不合并）
    const parentRows = h.store.writes.filter((row) => row.conversationId === PARENT_ID);
    expect(parentRows.length).toBeGreaterThan(0);
    expect(parentRows.every((row) => row.data?.subAgentUsage === undefined)).toBe(true);
  });
});

describe("send_to_session：接着说话（真 ChatRunner）", () => {
  it("对方在跑 → state running，条目在那一段的取件点落地（不新起段）", async () => {
    const childGate: Deferred<void> = deferred<void>();
    const h = createHarness({
      childRounds: () => [{ gate: childGate.promise, deltas: [{ content: "我正在跑" }] }],
      parentAgent: () => new FakeAgent([{ deltas: [{ content: "收到" }] }]),
    });
    // 父对话先跑一轮：拿它那个 agent 当 `ctx.agent`
    const seeding = await h.runner.run({ conversationId: PARENT_ID, input: { content: "先热身" } });
    await seeding.done;

    const created = await h.service.create({
      caller: callerOf(h),
      prompt: "跑一个长任务",
      label: "长任务",
    });
    if (!created.ok) throw new Error("unreachable");
    const childTurn = h.turnOf(created.sessionId)!;
    await h.waitFor(() => childTurn.runState().status === "running");

    const sent = await h.service.send({
      caller: callerOf(h),
      sessionId: created.sessionId,
      content: "顺便把这句也带上",
    });
    expect(sent).toEqual({ ok: true, state: "running" });

    // 还是那一段：没有第二个现场，条目在它的 inbox 里等取件点
    expect(h.turnOf(created.sessionId)).toBe(childTurn);
    const inbox = childTurn.runState().inbox;
    expect(inbox).toHaveLength(1);
    // 来源名由宿主解析：调用者是普通会话，用会话行上的 `name`
    expect(inbox[0]!.source).toBe("会话「c-parent」");
    expect(inbox[0]!.preview).toBe("顺便把这句也带上");

    childGate.resolve();
    await childTurn.done;
    await h.idle();

    // 取件点把它落成了 user 行（正文带来源注释），而且没有起第二段
    const rows = await listMain(h.store, created.sessionId);
    const sentRows = sendRows(rows);
    expect(sentRows).toHaveLength(1);
    expect(String(sentRows[0]!.content)).toContain("顺便把这句也带上");
    expect(String(sentRows[0]!.content)).toContain("// 这条消息来自 会话「c-parent」 自动推送");
    expect(rows.filter((row) => row.role === AgentNS.Role.Assistant)).toHaveLength(1);
  });

  it("对方空闲 → state idle，真的把它叫起来（自起段多一条 user + 一条 assistant）", async () => {
    const h = createHarness({
      childAgent: () => scriptedAgent(["第一段说完了。", "第二段：收到，接着做。"]),
      parentAgent: () => new FakeAgent([]),
    });
    const seeding = await h.runner.run({ conversationId: PARENT_ID, input: { content: "先热身" } });
    await seeding.done;

    const created = await h.service.create({ caller: callerOf(h), prompt: "先去查一下", label: "查" });
    if (!created.ok) throw new Error("unreachable");
    // 第一段真的跑完并结算了（结果也已投回父对话）
    await h.waitFor(
      () => h.turnOf(created.sessionId) === undefined && h.service.record(created.sessionId)?.state === "idle",
    );
    await h.idle();

    const sent = await h.service.send({
      caller: callerOf(h),
      sessionId: created.sessionId,
      content: "顺便再查第二件事",
    });
    expect(sent).toEqual({ ok: true, state: "idle" });

    // 它真的被叫起来了：自起段跑完落库（user + assistant 各多一条）
    await h.waitFor(() => {
      const rows = h.store.writes.filter((row) => row.conversationId === created.sessionId);
      return (
        rows.filter((row) => row.role === AgentNS.Role.User).length >= 2 &&
        rows.filter((row) => row.role === AgentNS.Role.Assistant).length >= 2
      );
    });
    await h.idle();

    const rows = await listMain(h.store, created.sessionId);
    expect(rows.map((row) => row.role)).toEqual([
      AgentNS.Role.User,
      AgentNS.Role.Assistant,
      AgentNS.Role.User,
      AgentNS.Role.Assistant,
    ]);
    // 叫醒它那一条的正文注释里写的是**调用者**（父对话的名字）
    const sentRows = sendRows(rows);
    expect(sentRows).toHaveLength(1);
    expect(String(sentRows[0]!.content)).toContain("// 这条消息来自 会话「c-parent」 自动推送");
    expect(String(sentRows[0]!.content)).toContain("顺便再查第二件事");
    expect(rows[3]!.content).toBe("第二段：收到，接着做。");
  });

  it("对方还没收工（已受理、现场还没建）→ state settling，攚到那一段结算完才落地", async () => {
    const store = new GatedStore();
    const gate: Deferred<void> = deferred<void>();
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    store.gate = gate;
    store.entered = () => signalEntered();
    // 子会话那一段的第一笔写（用户那句）：此刻 `runs` 里已经在跑、现场还没建
    store.gateOn = (row) => row.conversationId === "c-child-1" && row.role === AgentNS.Role.User;

    const h = createHarness({
      store,
      childAgent: () => scriptedAgent(["第一段说完了。", "第二段：攚着的那条收到了。"]),
      parentAgent: () => new FakeAgent([]),
    });
    const seeding = await h.runner.run({ conversationId: PARENT_ID, input: { content: "先热身" } });
    await seeding.done;

    // 不 await：子会话那一轮已经**受理**（`runs` 里在跑），现场还没建
    const creating = h.service.create({ caller: callerOf(h), prompt: "跑一段", label: "跑" });
    await entered;
    const childId = "c-child-1";
    expect(h.creator.created).toHaveLength(1);
    expect(h.turnOf(childId)).toBeUndefined();

    const sent = await h.service.send({
      caller: callerOf(h),
      sessionId: childId,
      content: "窗口里到达的一句",
    });
    // 那一段还没收工：这一条先攚着，当场不假装已投进某一段
    expect(sent).toEqual({ ok: true, state: "settling" });
    // 攚着 = 还没有落成任何消息（连开头那句 user 都还卡在写库里）
    expect(h.store.writes.filter((row) => row.conversationId === childId)).toHaveLength(0);

    gate.resolve();
    const created = await creating;
    if (!created.ok) throw new Error("unreachable");

    // 那一段结算完，攚下的那一批才投出去（= 自起一段，正文带来源注释）
    await h.waitFor(() => {
      const rows = h.store.writes.filter((row) => row.conversationId === childId);
      return (
        rows.filter((row) => row.role === AgentNS.Role.User).length >= 2 &&
        rows.filter((row) => row.role === AgentNS.Role.Assistant).length >= 2
      );
    });
    await h.idle();

    const rows = await listMain(h.store, childId);
    const sentRows = sendRows(rows);
    expect(sentRows).toHaveLength(1);
    expect(String(sentRows[0]!.content)).toContain("窗口里到达的一句");
    expect(String(sentRows[0]!.content)).toContain("// 这条消息来自 会话「c-parent」 自动推送");
    expect(rows.filter((row) => row.role === AgentNS.Role.Assistant)).toHaveLength(2);
  });

  it("子→父：回 state idle 并把父对话叫起来，正文注释里是那个 peer 的 label", async () => {
    const h = createHarness({
      childRounds: () => [{ deltas: [{ content: "我没查到那一行" }] }],
      parentAgent: () =>
        scriptedAgent(["先热身。", "收到子会话的结果，我接着干。", "收到它发来的话，我去看看。"]),
    });
    const seeding = await h.runner.run({ conversationId: PARENT_ID, input: { content: "先热身" } });
    await seeding.done;

    const created = await h.service.create({ caller: callerOf(h), prompt: "查一件事", label: "补测试" });
    if (!created.ok) throw new Error("unreachable");
    // 子会话跑完 → 结果先投回父对话，父对话被叫醒跑了一段（这一条不是本用例要看的）
    await h.waitFor(() => notedRowsIn(h, PARENT_ID).length >= 1 && h.turnOf(PARENT_ID) === undefined);
    await h.idle();
    expect(String(notedRowsIn(h, PARENT_ID)[0]!.content)).toContain("// 这条消息来自 补测试 自动推送");

    // 子会话（它自己就是 peer）及回到父对话
    const sent = await h.service.send({
      caller: callerOf(h, created.sessionId),
      sessionId: PARENT_ID,
      content: "需要更多信息",
    });
    expect(sent).toEqual({ ok: true, state: "idle" });

    await h.waitFor(() => notedRowsIn(h, PARENT_ID).length >= 2);
    await h.idle();

    const noted = notedRowsIn(h, PARENT_ID);
    // peer 发父：来源名是它自己的 label（不是会话行上的名字），于是注释读作「来自 会话「补测试」」
    const sentRow = noted[noted.length - 1]!;
    expect(String(sentRow.content)).toContain("// 这条消息来自 会话「补测试」 自动推送");
    expect(String(sentRow.content)).toContain("需要更多信息");
  });
});

/** 仓储里某段会话里「由投递 / 发送落地」的那几行 user（同一个 id 只算最后一次写） */
function notedRowsIn(
  h: Harness,
  conversationId: string,
): Array<{ id: string; content: unknown }> {
  const byId = new Map<string, { id: string; content: unknown }>();
  for (const row of h.store.writes) {
    if (row.conversationId !== conversationId) continue;
    if (row.role !== AgentNS.Role.User) continue;
    if (typeof row.content !== "string" || !row.content.startsWith("// 这条消息来自")) continue;
    byId.set(row.id, { id: row.id, content: row.content });
  }
  return [...byId.values()];
}

/** 主线行里「由 `send_to_session` 落地」的那几行 user（注释读作「来自 会话「…」」） */
function sendRows(rows: StoredMessage[]): StoredMessage[] {
  return rows.filter(
    (row) =>
      row.role === AgentNS.Role.User &&
      typeof row.content === "string" &&
      row.content.startsWith("// 这条消息来自 会话「"),
  );
}

/** 一轮的用量（`prompt` / `completion` 两个数就够本文的断言） */
function usage(promptTokens: number, completionTokens: number): AgentNS.Usage {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}
