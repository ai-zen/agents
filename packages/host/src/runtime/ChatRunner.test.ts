/**
 * `ChatRunner` 的用例：一轮对话的完整时序、六态推进、增量事件与边流边写、中止、修复、用量。
 *
 * 全程不调模型：agent 由工厂注入假 agent（`FakeAgent`），它把 core 在 `send()` 里做的事
 * 按同一顺序演一遍，攒消息调用 core 的 `applyChunk`。于是用例验证的是本包的接线
 * （事件在哪一刻推、库里什么时候有行、谁被释放），而不是 core 的算法。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentNS } from "@ai-zen/agents-core";
import { AgentNS as AgentNSValue, applyChunk, Message } from "@ai-zen/agents-core";
import { AutoMigratePlugin, Scope } from "@ai-zen/agents-sdk";
import type { HandoffService } from "@ai-zen/agents-sdk";
import type { OuterLoopContext } from "@ai-zen/agents-core";

import {
  ConversationRepository,
  Database,
  MessageRepository,
  migrate,
  WorkspaceRepository,
} from "../storage/index.js";
import type { Conversation, MessageUpsertInput, StoredMessage } from "../storage/types.js";
import type { Language } from "../i18n/index.js";
import type { EventMap, EventName } from "../wire/events.js";
import { HostError } from "../wire/errors.js";
import type { GenerationPhaseName, LocalMessageContentSection, RunState } from "../wire/states.js";
import type {
  AgentBuildContext,
  ChatAgent,
  ChatRunnerOptions,
  QueuedTurn,
  TurnSettledFacts,
} from "./ChatRunner.js";
import { ChatRunner, createSdkAgentFactory, DEFAULT_STREAM_WRITE_INTERVAL_MS } from "./ChatRunner.js";
import { AgentRegistry } from "./AgentRegistry.js";
import { RunRegistry } from "./RunRegistry.js";
import { ScopeRegistry } from "./ScopeRegistry.js";
import type { FakeRound } from "./TestSupport.js";
import {
  createFakeScope,
  deferred,
  FakeAgent,
  flushMicrotasks,
  ManualClock,
  RecordingEventBus,
  RecordingMessageStore,
  RecordingScopePlugin,
  type Deferred,
} from "./TestSupport.js";

const CONVERSATION_ID = "c-1";
const WORKSPACE_ID = "ws-1";
const TEN_MINUTES = 10 * 60 * 1000;

/** 一段对话（助手创建时定死；模型与思考档位是这段会话自己的，见 F-B4 / F-B6） */
function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: CONVERSATION_ID,
    workspaceId: WORKSPACE_ID,
    name: "对话",
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

interface Harness {
  runner: ChatRunner;
  store: RecordingMessageStore;
  runs: RunRegistry;
  scopes: ScopeRegistry;
  /** agent 的持有者：一轮跑完要从这里消失，Scope 则仍在 */
  agents: AgentRegistry;
  clock: ManualClock;
  plugin: RecordingScopePlugin;
  events: Array<{ name: EventName; payload: EventMap[EventName] }>;
  builds: AgentBuildContext[];
  /** 用例关心的推送 */
  pushed: <E extends EventName>(name: E) => Array<EventMap[E]>;
  phases: () => GenerationPhaseName[];
  lastRunState: () => RunState;
}

function createHarness(options: {
  rounds?: FakeRound[];
  agent?: ChatAgent;
  /** 每次装配 agent 时现造一个 */
  agentFactory?: () => ChatAgent;
  /** 直接接管装配（要卡住「agent 还没装好」那一段时用） */
  buildAgent?: (context: AgentBuildContext) => Promise<ChatAgent>;
  /** 换一份消息仓储（要看「写库还没写完」那一段时用） */
  store?: RecordingMessageStore;
  /** 素材相关的注入点（`ChatRunner` 只在有它们时才做对应的事） */
  prepareAttachments?: ChatRunnerOptions["prepareAttachments"];
  prepareHistory?: ChatRunnerOptions["prepareHistory"];
  linkMessageAssets?: ChatRunnerOptions["linkMessageAssets"];
  conversation?: Conversation;
  streamWriteIntervalMs?: number;
  history?: MessageUpsertInput[];
  /** 一轮结算之后的回调（R59） */
  onTurnSettled?: (facts: TurnSettledFacts) => void;
  /** 内部错误的去处 */
  onError?: ChatRunnerOptions["onError"];
  language?: Language;
}): Harness {
  const clock = new ManualClock();
  const store = options.store ?? new RecordingMessageStore();
  for (const row of options.history ?? []) store.seed(row);

  const conversation = options.conversation ?? makeConversation();
  const { scope, plugin } = createFakeScope("/tmp/ai-zen-project");
  const scopes = new ScopeRegistry({ createScope: async () => scope });
  const runs = new RunRegistry({ clock });

  const events: Array<{ name: EventName; payload: EventMap[EventName] }> = [];
  const builds: AgentBuildContext[] = [];
  let idCursor = 0;
  const agent = options.agent ?? new FakeAgent(options.rounds ?? []);

  const agents = new AgentRegistry({
    scopes,
    runs,
    createAgent: async (context) => {
      builds.push(context);
      if (options.buildAgent) return await options.buildAgent(context);
      return options.agentFactory ? options.agentFactory() : agent;
    },
  });

  const runner = new ChatRunner({
    messages: store,
    conversations: {
      get: async (id: string) => (id === conversation.id ? conversation : undefined),
    },
    scopes,
    runs,
    agents,
    emit: (name, payload) => {
      events.push({ name, payload });
    },
    clock,
    newId: () => `srv-${++idCursor}`,
    streamWriteIntervalMs: options.streamWriteIntervalMs ?? 0,
    onTurnSettled: options.onTurnSettled,
    onError: options.onError,
    ...(options.prepareAttachments === undefined
      ? {}
      : { prepareAttachments: options.prepareAttachments }),
    ...(options.prepareHistory === undefined ? {} : { prepareHistory: options.prepareHistory }),
    ...(options.linkMessageAssets === undefined
      ? {}
      : { linkMessageAssets: options.linkMessageAssets }),
    defaultLanguage: options.language,
  });

  const pushed = <E extends EventName>(name: E): Array<EventMap[E]> =>
    events.filter((event) => event.name === name).map((event) => event.payload as EventMap[E]);

  return {
    runner,
    store,
    runs,
    scopes,
    agents,
    clock,
    plugin,
    events,
    builds,
    pushed,
    phases: () =>
      pushed("run.state")
        .filter((payload) => payload.run.status === "running")
        .map((payload) => payload.run.generation?.phase ?? "connected"),
    lastRunState: () => pushed("run.state").at(-1)!.run,
  };
}

/** 一次普通的一轮：两片正文 + 收尾用量 */
function plainRounds(): FakeRound[] {
  return [{ deltas: [{ content: "你" }, { content: "好" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }];
}

let harness: Harness;

beforeEach(() => {
  harness = createHarness({ rounds: plainRounds() });
});

describe("ChatRunner：受理", () => {
  it("受理即返回两个宿主分配的 id，并且两条消息在返回前就落库（PRD L6 / F-I12）", async () => {
    const gate = deferred<void>();
    const custom = createHarness({ rounds: [{ gate: gate.promise, deltas: [{ content: "稍等" }] }] });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "在吗" },
    });

    expect(turn.userMessageId).toBe("srv-1");
    expect(turn.assistantMessageId).toBe("srv-2");
    expect(turn.attachments).toEqual([]);
    expect(turn.acceptedAt).toBe(new Date(custom.clock.now()).toISOString());

    const user = custom.store.peek(turn.userMessageId)!;
    expect(user.role).toBe(AgentNSValue.Role.User);
    expect(user.status).toBe(AgentNSValue.MessageStatus.Completed);
    expect(user.content).toBe("在吗");

    // 助手占位：客户端拿这个 id 接流
    const placeholder = custom.store.peek(turn.assistantMessageId)!;
    expect(placeholder.role).toBe(AgentNSValue.Role.Assistant);
    expect(placeholder.status).toBe(AgentNSValue.MessageStatus.Pending);

    gate.resolve();
    await turn.done;
  });

  it("对话不存在时报 not_found，且不占着轮次、不计 Scope 依赖", async () => {
    await expect(
      harness.runner.run({ conversationId: "c-missing", input: { content: "hi" } }),
    ).rejects.toMatchObject({ code: "not_found" });

    expect(harness.runs.size()).toBe(0);
    expect(harness.scopes.workspaceIds()).toEqual([]);
    expect(harness.store.writes).toEqual([]);
  });

  it("已经在跑的对话再来一轮：直接拒（busy），不排队也不打断上一轮（PRD D14）", async () => {
    const gate = deferred<void>();
    const custom = createHarness({ rounds: [{ gate: gate.promise, deltas: [{ content: "慢慢来" }] }] });

    const first = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一次" },
    });

    let error: unknown;
    try {
      await custom.runner.run({ conversationId: CONVERSATION_ID, input: { content: "第二次" } });
    } catch (caught) {
      error = caught;
    }
    expect(HostError.is(error)).toBe(true);
    expect((error as HostError).code).toBe("busy");
    // 第二次一条消息都没写
    expect(custom.store.writes).toHaveLength(2);

    gate.resolve();
    const settlement = await first.done;
    expect(settlement.outcome).toBe("completed");

    // 上一轮结束后可以再开一轮
    const second = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第二次" },
    });
    await second.done;
  });

  it("把对话的身份（助手 / 模型）与 Scope 交给工厂，历史一并给过去", async () => {
    const turn = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "你好" },
    });
    await turn.done;

    expect(harness.builds).toHaveLength(1);
    const build = harness.builds[0]!;
    expect(build.conversationId).toBe(CONVERSATION_ID);
    expect(build.workspaceId).toBe(WORKSPACE_ID);
    expect(build.agentId).toBe("default");
    expect(build.modelId).toBe("model-1");
    expect(build.scope.cwd).toBe("/tmp/ai-zen-project");
    expect(build.history).toEqual([]);
  });

  it("会话行上的思考档位也一并交给工厂（档位属于模型，由这里透传）", async () => {
    const custom = createHarness({ conversation: makeConversation({ thinkingLevel: "high" }) });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "你好" },
    });
    await turn.done;

    // 非空值才有说服力：硬编码 null 也能让「档位为 null」那种断言通过
    expect(custom.builds[0]!.thinkingLevel).toBe("high");
  });
});

describe("ChatRunner：六态与增量", () => {
  it("六态按顺序推进，等工具时只列还在跑的那些（PRD L8 / F-I3）", async () => {
    const custom = createHarness({
      rounds: [
        {
          // 先思考、再出正文、最后拼两个工具调用
          deltas: [
            { reasoning_content: "想一" },
            { reasoning_content: "想二" },
            { content: "我去看看" },
            { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read", arguments: "{" } }] },
          ],
          toolCalls: [
            { id: "t1", name: "read" },
            { id: "t2", name: "ls" },
          ],
        },
        { deltas: [{ content: "看完了" }] },
      ],
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看这个目录" },
    });
    await turn.done;

    // 两个工具都定型之后不再停在「在等工具」：那一态描述的事已经不成立，回到「连上」，
    // 接着是下一轮的首字与正文（L8：并行时逐个减少，减到空就换态）
    expect(custom.phases()).toEqual([
      // 受理即推一次（「刚连上」；自己那一句不排队，所以入队不再另推一次）
      "connected",
      "awaiting_first_token",
      "thinking",
      "generating",
      // 两个工具调用各拼出一片（片到一片就变一次列表）
      "assembling_tool_calls",
      "assembling_tool_calls",
      // 并行两个工具：逐个开始、逐个结束（列表逐个缩到空才换态）
      "awaiting_tools",
      "awaiting_tools",
      "awaiting_tools",
      "connected",
      "awaiting_first_token",
      "generating",
    ]);

    // 「在等哪几个工具」是列表：并行时逐个减少（不是布尔，也不是一次报全）
    const runningCounts = custom
      .pushed("run.state")
      .filter((payload) => payload.run.generation?.phase === "awaiting_tools")
      .map((payload) => {
        const generation = payload.run.generation;
        return generation?.phase === "awaiting_tools" ? generation.runningTools.length : -1;
      });
    expect(runningCounts).toEqual([1, 2, 1]);
    // 最后一条「等工具」快照里没有还在跑的工具：不会有「等一个空列表」的态出网
    expect(runningCounts.every((count) => count > 0)).toBe(true);
  });

  it("增量事件搬的是 core 的 `AgentNS.Delta`，同一片刻推给客户端", async () => {
    const turn = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "说点什么" },
    });
    await turn.done;

    const deltas = harness.pushed("message.delta");
    expect(deltas).toHaveLength(2);
    expect(deltas.map((payload) => payload.seq)).toEqual([0, 1]);
    for (const payload of deltas) {
      expect(payload.messageId).toBe(turn.assistantMessageId);
      expect(payload.conversationId).toBe(CONVERSATION_ID);
    }
    expect(deltas.map((payload) => payload.delta.content).join("")).toBe("你好");
  });
});

describe("ChatRunner：边流边写（PRD D15）", () => {
  it("同一条消息行随流增长，最终版与内存一致", async () => {
    const turn = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "写长一点" },
    });
    await turn.done;

    // 这道用例用「每片都写」（节流 0），于是能看见行内容逐步长起来
    const rows = harness.store.historyOf(turn.assistantMessageId);
    const contents = rows.map((row) => row.content);
    expect(contents[0]).toBeNull();
    expect(contents).toContain("你");
    expect(contents).toContain("你好");

    const final = harness.store.peek(turn.assistantMessageId)!;
    expect(final.content).toBe("你好");
    expect(final.status).toBe(AgentNSValue.MessageStatus.Completed);
    // 用量钉在同一条消息上（core 的 applyChunk 写的），不是另存一份
    expect(final.data?.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });

  it("节流生效时不会每到一片就写一次，但最终版一定写", async () => {
    const interval = 1000;
    const custom = createHarness({ rounds: plainRounds(), streamWriteIntervalMs: interval });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "写长一点" },
    });
    await turn.done;

    // 没有推进时钟：节流点没到，中间的片不落库
    const writes = custom.store.historyOf(turn.assistantMessageId);
    expect(writes.map((row) => row.content)).toEqual([null, "你好"]);
    expect(interval).toBeLessThan(DEFAULT_STREAM_WRITE_INTERVAL_MS * 10);
  });
});

describe("ChatRunner：结算", () => {
  it("跑完 agent 仍在（常驻），Scope 也仍在（两者的生灭都不挂钩在一轮上）", async () => {
    const agent = new FakeAgent(plainRounds());
    const custom = createHarness({ agent });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "你好" },
    });
    const settlement = await turn.done;

    expect(settlement.outcome).toBe("completed");
    expect(settlement.problem).toBeNull();
    expect(custom.runs.isRunning(CONVERSATION_ID)).toBe(false);

    // 结算态：六态清空、结局写清、助手消息 id 还在（重连要按它拉）
    const run = custom.lastRunState();
    expect(run.status).toBe("settled");
    expect(run.outcome).toBe("completed");
    expect(run.generation).toBeNull();
    expect(run.assistantMessageId).toBe(turn.assistantMessageId);
    expect(run.settledAt).not.toBeNull();

    // 用量的事件也发了（F-I5 的三个口径在载荷里）
    expect(custom.pushed("usage")).toHaveLength(1);
    expect(custom.pushed("conversation.changed")[0]?.change).toBe("messages_persisted");

    // agent 常驻：结算不摘登记，下一段拿到的还是它（旧行为在这里是「跑完即丢」）
    expect(custom.agents.get(CONVERSATION_ID)).toBe(agent);
    expect(custom.agents.conversationIds()).toEqual([CONVERSATION_ID]);
    // 只是留着，不是“还在跑”：结算之后再叫停不会碰到它（那一轮已经没了）
    turn.abort("已经跑完了");
    expect(agent.abortCalls).toBe(0);
    // 结算之后的快照里没有「还排着的东西」：inbox 说的是这一轮的事，而这一轮已收工
    expect(run.inbox).toEqual([]);

    // 而 Scope 一直在（没有空闲计时、没有自动回收）：推多久都不会自己消失，
    // 也没人收到「MCP 关闭」那一下 —— 它活到显式 dispose 或进程退出
    expect(custom.scopes.get(WORKSPACE_ID)).toBeDefined();
    expect(custom.scopes.workspaceIds()).toEqual([WORKSPACE_ID]);
    custom.clock.advance(TEN_MINUTES * 24);
    await flushMicrotasks();
    expect(custom.scopes.get(WORKSPACE_ID)).toBeDefined();
    expect(custom.plugin.disposeCalls).toBe(0);
  });

  it("装配 agent 失败：助手占位有个终态（error），失败原因进结算态", async () => {
    const custom = createHarness({
      agent: {
        messages: [],
        append: () => {
          throw new Error("不该被叫");
        },
        send: async () => {
          throw new Error("不该被叫");
        },
        abort: () => undefined,
        // 装配就没成：这一轮从没打开过入队门，inbox 这两个口不该被叫到
        inbox: [],
        deliver: () => {
          throw new Error("不该被叫");
        },
        events: { on: () => undefined },
      },
    });
    const broken = new ChatRunner({
      messages: custom.store,
      conversations: {
        get: async (id) =>
          id === CONVERSATION_ID ? makeConversation() : undefined,
      },
      scopes: custom.scopes,
      runs: custom.runs,
      agents: new AgentRegistry({
        scopes: custom.scopes,
        runs: custom.runs,
        createAgent: async () => {
          throw new Error("模型没配端点");
        },
      }),
      emit: () => undefined,
      clock: custom.clock,
      newId: () => `srv-fail`,
    });

    const turn = await broken.run({
      conversationId: CONVERSATION_ID,
      input: { content: "你好" },
    });
    const settlement = await turn.done;

    expect(settlement.outcome).toBe("error");
    expect(settlement.problem?.messageKey).toBe("error.internal");
    expect(custom.store.peek(turn.assistantMessageId)?.status).toBe(
      AgentNSValue.MessageStatus.Error,
    );
    expect(custom.runs.isRunning(CONVERSATION_ID)).toBe(false);
  });

  it("子 Agent 的委派被记进 RunState，用完的用量含它的那一份", async () => {
    // 一次真的委派：core 的 `AgentToolLazy` 造一个一次性子 agent、跑它、收尸，
    // 把它的用量钉在那条工具结果消息上 —— 宿主只是订阅 `subAgentStarted/Finished`。
    const custom = createHarness({
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
              },
            ],
            stream: ["办好了"],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          },
        },
      ],
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "交给助手" },
    });
    const settlement = await turn.done;

    expect(settlement.run.subagents).toHaveLength(1);
    const snapshot = settlement.run.subagents[0]!;
    expect(snapshot.name).toBe("helper");
    expect(snapshot.toolCallId).toBe("t1");
    expect(snapshot.status).toBe("done");
    // 「问题 + 它说的那句」= 2 条（与 core 里那个子 agent 的 messages 一致）
    expect(snapshot.messageCount).toBe(2);
    expect(snapshot.usage).toEqual({ prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 });
    expect(snapshot.finishedAt).not.toBeNull();
  });

  it("子 Agent 说过的话也落库，挂在那次委派的工具调用上（F-I7）", async () => {
    const custom = createHarness({
      rounds: [
        {
          deltas: [{ tool_calls: [{ index: 0, id: "call-9", type: "function", function: { name: "delegate", arguments: "{}" } }] }],
          toolCalls: [{ id: "call-9", name: "delegate" }],
          subAgent: {
            name: "helper",
            // 子 agent 开局手里只有那条问题；「方案是这样」是它这一轮自己说出来的
            messages: [
              {
                id: "inner-u",
                role: AgentNSValue.Role.User,
                status: AgentNSValue.MessageStatus.Completed,
                content: "把方案说一下",
              },
            ],
            stream: ["方案是这样"],
          },
        },
      ],
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "交给助手" },
    });
    const settlement = await turn.done;

    // 条数就是真落下去的条数
    expect(settlement.run.subagents[0]?.messageCount).toBe(2);

    // 落库的两条都带 parentToolCallId（回看靠它），且不在主线历史里
    // （流式时会先写一条还没长出正文的行，所以这里读的是**最终版**）
    const subRows = (await custom.store.listByConversation(CONVERSATION_ID)).filter(
      (row) => row.parentToolCallId === "call-9",
    );
    expect(subRows.map((row) => row.content)).toEqual(["把方案说一下", "方案是这样"]);
    expect(subRows.every((row) => row.conversationId === CONVERSATION_ID)).toBe(true);
  });
});

describe("ChatRunner：cwd 不再按轮拼进消息（F-D9）", () => {
  it("用户消息原样落库：不带注入段，也不标 hidden", async () => {
    const custom = createHarness({ rounds: plainRounds(), language: "zh" });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看这里" },
    });
    await turn.done;

    const row = custom.store.peek(turn.userMessageId);
    expect(row?.content).toBe("看看这里");
    expect(row?.data).toBeNull();
  });

  it("历史里那条 hidden 的 cwd 消息会装进这一轮（模型看得到，只是不给人看）", async () => {
    const custom = createHarness({
      rounds: plainRounds(),
      history: [
        {
          id: "cwd-1",
          conversationId: CONVERSATION_ID,
          role: AgentNSValue.Role.User as string,
          status: AgentNSValue.MessageStatus.Completed as string,
          omit: false,
          content: "当前目录是 /tmp/ai-zen-project",
          data: { hidden: true },
          createdAt: 0,
        },
      ],
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看这里" },
    });
    await turn.done;

    // 取历史要连 hidden 的一起取，否则模型下一轮就不知道自己在哪个目录
    const history = custom.builds[0]?.history ?? [];
    expect(history.map((message) => message.id)).toContain("cwd-1");
    expect(history[0]?.hidden).toBe(true);
    // 这一轮没有重写它（只有用例自己 seed 的那一笔）
    expect(custom.store.historyOf("cwd-1")).toHaveLength(1);
    expect(custom.store.peek("cwd-1")?.data).toEqual({ hidden: true });
  });
});

describe("ChatRunner：这一轮是谁叫起来的（source）", () => {
  /** 叫起这一轮的那个来源 —— core 的判别结构（不再是自由字符串） */
  const AUTO_SOURCE: AgentNS.MessageSource = { kind: "agent", label: "会话「会话 3」" };

  /** core 给非 user 来源加的那行注释（形状归 core 的 `inboxEntryContent`，这里只按它的口径断言） */
  const NOTE = /^\/\/ 这条消息来自 会话「会话 3」 自动推送（.+）$/;

  it("非 user 来源：落库那份与交给 agent 那份都以来源注释开头，正文在其后", async () => {
    const agent = new FakeAgent(plainRounds());
    const custom = createHarness({ agent });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "别的会话跑完了，结果是这样" },
      source: AUTO_SOURCE,
    });
    const settlement = await turn.done;

    // ① 库里那份：用户下次回看到的就是它（注释里的时间是宿主自己的时钟）
    const stored = custom.store.peek(turn.userMessageId)?.content as string;
    const [storedNote, ...storedBody] = stored.split("\n\n");
    expect(storedNote).toMatch(NOTE);
    expect(storedBody.join("\n\n")).toBe("别的会话跑完了，结果是这样");

    // ② 交给 agent 那份：那条 user 消息由 **core** 从 inbox 落地，注释也是 core 按 `source` 加的
    //    （时间取条目自己的 `createdAt`），所以这里按形状断言 —— 注释只包一次
    const sent = agent.messages.filter((message) => message.id === turn.userMessageId);
    expect(sent).toHaveLength(1);
    const sentContent = sent[0]?.content as string;
    const [sentNote, ...sentBody] = sentContent.split("\n\n");
    expect(sentNote).toMatch(NOTE);
    expect(sentBody.join("\n\n")).toBe("别的会话跑完了，结果是这样");

    // 结算快照里的同一份内容就是它
    expect(settlement.produced.find((m) => m.id === turn.userMessageId)?.content).toBe(sentContent);

    // ③ 来源本身落进了那一列（core 的判别结构，不是字符串）
    expect(custom.store.peek(turn.userMessageId)?.source).toEqual(AUTO_SOURCE);
  });

  it("不给 source（用户自己发的）：两份都原样，一个字都不变", async () => {
    const agent = new FakeAgent(plainRounds());
    const custom = createHarness({ agent });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "在吗" },
    });
    await turn.done;

    expect(custom.store.peek(turn.userMessageId)?.content).toBe("在吗");
    expect(custom.store.peek(turn.userMessageId)?.source).toEqual({ kind: "user" });
    const sent = agent.messages.filter((message) => message.id === turn.userMessageId);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toBe("在吗");
    expect(sent[0]?.source).toEqual({ kind: "user" });
  });

  it("跑中入队也穿透来源：带 source 的那条落地带注释，不带的原样", async () => {
    const toolGate = deferred<void>();
    const agent = new FakeAgent([
      {
        deltas: [{ content: "我查一下。" }],
        toolCalls: [{ id: "call-1", name: "read", arguments: "{}" }],
        toolGate: toolGate.promise,
      },
      { deltas: [{ content: "查到了。" }] },
    ]);
    const custom = createHarness({ agent });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看文件" },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (agent.messages.some((message) => message.role === AgentNSValue.Role.Tool)) break;
      await flushMicrotasks();
    }

    const pushed = await custom.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "会话 3 的结果" },
      source: AUTO_SOURCE,
    });
    const typed = await custom.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "我自己补一句" },
    });
    expect(pushed).not.toBeNull();
    expect(typed).not.toBeNull();

    // 两条都真的进了 core 的队列（core 只给个数，条目本身现读 `inboxPending` —— 客户端看的也是它）
    expect(agent.inboxSize).toBe(2);
    const queue = custom.lastRunState().inbox;
    expect(queue.map((item) => item.source)).toEqual([AUTO_SOURCE, { kind: "user" }]);
    expect(queue.map((item) => item.preview)).toEqual(["会话 3 的结果", "我自己补一句"]);

    toolGate.resolve();
    const settlement = await turn.done;

    const landedOf = (id: string) => settlement.messages.find((message) => message.id === id);
    // core 落地那一刻（`inboxEntryContent`）给它加了注释行，正文在注释之后
    // （注释里的时间是条目自己的 `createdAt`，所以这一条按形状断言）
    const pushedContent = landedOf(pushed!.userMessageId)?.content;
    expect(typeof pushedContent).toBe("string");
    const [noteLine, ...body] = (pushedContent as string).split("\n\n");
    expect(noteLine).toMatch(/^\/\/ 这条消息来自 会话「会话 3」 自动推送（.+）$/);
    expect(body.join("\n\n")).toBe("会话 3 的结果");
    // 同一份内容进了库（用户回看时看到的也是它）
    expect(custom.store.peek(pushed!.userMessageId)?.content).toBe(pushedContent);

    // 不给来源的那条：一个字都不变
    expect(landedOf(typed!.userMessageId)?.content).toBe("我自己补一句");
    expect(custom.store.peek(typed!.userMessageId)?.content).toBe("我自己补一句");
  });

  it("非 user 来源 + 带附件：库里那份也带注释行，__asset_id 段原封不动", async () => {
    const toolGate = deferred<void>();
    const agent = new FakeAgent([
      {
        deltas: [{ content: "我查一下。" }],
        toolCalls: [{ id: "call-1", name: "read", arguments: "{}" }],
        toolGate: toolGate.promise,
      },
      { deltas: [{ content: "查到了。" }] },
    ]);
    const custom = createHarness({
      agent,
      // 带 `storedContent` 的那一档：落地时它整份覆盖行内容（真实现是 `AssetService`）
      prepareAttachments: async ({ input }) => ({
        content: input.content,
        attachments: [],
        storedContent: STORED_CONTENT,
      }),
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看文件" },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (agent.messages.some((message) => message.role === AgentNSValue.Role.Tool)) break;
      await flushMicrotasks();
    }

    const queued = await custom.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "会话 3 的结果" },
      source: AUTO_SOURCE,
    });
    expect(queued).not.toBeNull();

    toolGate.resolve();
    const settlement = await turn.done;

    // ① 发给模型那份：注释行还是 core 拼的那一行（只加一次）
    const landed = settlement.messages.find((message) => message.id === queued!.userMessageId);
    expect((landed?.content as string).split("\n\n")[0]).toMatch(
      /^\/\/ 这条消息来自 会话「会话 3」 自动推送（.+）$/,
    );

    // ② 库里那份：不再与模型那份分叉 —— 同样以注释行开头（而且只加这一次）
    const stored = custom.store.peek(queued!.userMessageId)
      ?.content as unknown as LocalMessageContentSection[];
    expect(Array.isArray(stored)).toBe(true);
    const note = stored[0] as unknown as { type: string; text: string };
    expect(note.type).toBe("text");
    // 注释里的时间是条目自己的 `createdAt`，这里按形状断言
    expect(note.text).toMatch(/^\/\/ 这条消息来自 会话「会话 3」 自动推送（.+）\n\n$/);
    expect(JSON.stringify(stored).match(/这条消息来自/g)).toHaveLength(1);
    // ③ 素材引用段原封不动地留在后面（只是前面多了一段文本）
    expect(stored.slice(1)).toEqual(STORED_CONTENT);
  });
});

describe("ChatRunner：一轮结算之后报事实（R59）", () => {  it("结算时回调 onTurnSettled，带本轮用量 / 交接线 / 语言", async () => {
    const settled: TurnSettledFacts[] = [];
    const custom = createHarness({
      rounds: [
        {
          deltas: [{ content: "好" }],
          usage: { prompt_tokens: 120, completion_tokens: 5, total_tokens: 125 },
        },
      ],
      // 模型上的交接线由 Scope 的配置提供（该假 Scope 里没有这个模型 → 0，这里只验回调本身）
      language: "zh",
      onTurnSettled: (facts) => settled.push(facts),
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "说点什么" },
    });
    await turn.done;

    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      conversationId: CONVERSATION_ID,
      outcome: "completed",
      // 跑完的段没有失败事实（失败 / 中止时这一格才非空：派生会话靠它把原因转述出去）
      problem: null,
      promptTokens: 120,
      language: "zh",
    });
    expect(typeof settled[0]?.handoffTokens).toBe("number");
  });

  it("回调里抛错不影响这一轮（只记日志）", async () => {
    const problems: string[] = [];
    const custom = createHarness({
      rounds: plainRounds(),
      onTurnSettled: () => {
        throw new Error("回调炸了");
      },
    });
    void problems;

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "说点什么" },
    });
    const settlement = await turn.done;
    expect(settlement.outcome).toBe("completed");
  });
});

describe("ChatRunner：中止（PRD D14 / D15）", () => {
  it("在途消息以 Aborted 落库，结局是 aborted（不是 error）", async () => {
    const gate = deferred<void>();
    const custom = createHarness({ rounds: [{ gate: gate.promise, deltas: [{ content: "马上" }] }] });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "先等等" },
    });
    // 请求已发出、第一个字还没来（六态停在等首字）
    await flushMicrotasks();
    expect(custom.lastRunState().generation?.phase).toBe("awaiting_first_token");

    turn.abort("用户按了停");
    expect(custom.runs.list()[0]?.aborted).toBe(true);

    gate.resolve();
    const settlement = await turn.done;

    expect(settlement.outcome).toBe("aborted");
    expect(settlement.problem).toBeNull();
    expect(custom.store.peek(turn.assistantMessageId)?.status).toBe(
      AgentNSValue.MessageStatus.Aborted,
    );
    expect(custom.lastRunState().outcome).toBe("aborted");
    expect(custom.lastRunState().status).toBe("settled");
  });

  it("中止得比 agent 装配还早：占位照样落成 Aborted，不留一条永远在写的行", async () => {
    const gate = deferred<void>();
    const custom = createHarness({ rounds: [{ gate: gate.promise }] });
    let releaseBuild: (agent: ChatAgent) => void = () => undefined;
    const builder = new ChatRunner({
      messages: custom.store,
      conversations: { get: async () => makeConversation() },
      scopes: custom.scopes,
      runs: custom.runs,
      agents: new AgentRegistry({
        scopes: custom.scopes,
        runs: custom.runs,
        createAgent: () => new Promise<ChatAgent>((resolve) => (releaseBuild = resolve)),
      }),
      emit: () => undefined,
      clock: custom.clock,
      newId: () => `srv-early`,
    });

    const turn = await builder.run({ conversationId: CONVERSATION_ID, input: { content: "喂" } });
    turn.abort("不等了");
    releaseBuild(new FakeAgent([{ deltas: [{ content: "迟到的回答" }] }]));
    const settlement = await turn.done;

    expect(settlement.outcome).toBe("aborted");
    expect(custom.store.peek(turn.assistantMessageId)?.status).toBe(
      AgentNSValue.MessageStatus.Aborted,
    );
  });
});

describe("ChatRunner：装载/重启后的修复（PRD D15）", () => {
  /** 上一次进程崩在写的时候：工具轮次只剩一条结果，另有一条纯内容消息没写完 */
  function crashedHistory(): MessageUpsertInput[] {
    return [
      {
        id: "m-user",
        conversationId: CONVERSATION_ID,
        role: AgentNSValue.Role.User,
        status: AgentNSValue.MessageStatus.Completed,
        omit: false,
        content: "帮我改两个文件",
        data: null,
        createdAt: 1,
      },
      {
        id: "m-tools",
        conversationId: CONVERSATION_ID,
        role: AgentNSValue.Role.Assistant,
        // 崩在写的时候：状态还是 writing
        status: AgentNSValue.MessageStatus.Writing,
        omit: false,
        content: "",
        data: {
          tool_calls: [
            { index: 0, id: "t1", type: "function", function: { name: "edit", arguments: "{}" } },
            { index: 1, id: "t2", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        createdAt: 2,
      },
      {
        id: "m-tool-1",
        conversationId: CONVERSATION_ID,
        role: AgentNSValue.Role.Tool,
        status: AgentNSValue.MessageStatus.Completed,
        omit: false,
        content: "改好了",
        data: { tool_call_id: "t1", name: "edit" },
        createdAt: 3,
      },
      {
        id: "m-tool-2",
        conversationId: CONVERSATION_ID,
        role: AgentNSValue.Role.Tool,
        status: AgentNSValue.MessageStatus.Pending,
        omit: false,
        content: "",
        data: { tool_call_id: "t2", name: "read" },
        createdAt: 4,
      },
      {
        id: "m-half",
        conversationId: CONVERSATION_ID,
        role: AgentNSValue.Role.Assistant,
        status: AgentNSValue.MessageStatus.Writing,
        omit: false,
        content: "半截回答",
        data: null,
        createdAt: 5,
      },
    ];
  }

  it("在途消息当 Aborted → 工具轮次 fill（整轮进出，缺的补原因）→ 纯内容 keep（内容留下）", async () => {
    const custom = createHarness({ history: crashedHistory() });

    const result = await custom.runner.reconcile(CONVERSATION_ID);
    const byId = new Map(result.messages.map((message) => [message.id, message]));

    // 工具轮次：assistant 与两条结果都回到上下文（宿主要求 N 个调用对 N 条结果）
    expect(byId.get("m-tools")?.status).toBe(AgentNSValue.MessageStatus.Completed);
    expect(byId.get("m-tools")?.omit).toBe(false);
    expect(byId.get("m-tool-1")?.status).toBe(AgentNSValue.MessageStatus.Completed);
    const filled = byId.get("m-tool-2")!;
    expect(filled.status).toBe(AgentNSValue.MessageStatus.Completed);
    expect(filled.content).toBe("用户中断了会话");

    // 纯内容：已输出的半截留下，模型下一轮能接着半截说
    expect(byId.get("m-half")?.status).toBe(AgentNSValue.MessageStatus.Completed);
    expect(byId.get("m-half")?.content).toBe("半截回答");

    // 改动写回了库（status / omit 两列必须落盘）
    expect(result.repairedIds.sort()).toEqual(["m-half", "m-tool-2", "m-tools"]);
    expect(custom.store.peek("m-tool-2")?.content).toBe("用户中断了会话");
    expect(custom.store.peek("m-half")?.status).toBe(AgentNSValue.MessageStatus.Completed);
    // 没变的那两条不该被重写
    expect(custom.store.writes.filter((row) => row.id === "m-user")).toHaveLength(1);
  });

  it("修好之后再发一轮：历史就是修好的那一份（在途的不会带进新请求）", async () => {
    const custom = createHarness({ history: crashedHistory(), rounds: plainRounds() });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "接着说" },
    });
    const settlement = await turn.done;

    const historyIds = settlement.messages
      .filter((message) => message.id.startsWith("m-"))
      .map((message) => message.id);
    expect(historyIds).toEqual(["m-user", "m-tools", "m-tool-1", "m-tool-2", "m-half"]);
    // 传进工厂的历史已经不带 pending/writing 了
    expect(
      custom.builds[0]!.history.some(
        (message) =>
          message.status === AgentNSValue.MessageStatus.Pending ||
          message.status === AgentNSValue.MessageStatus.Writing,
      ),
    ).toBe(false);
  });
});

describe("ChatRunner：用量三个口径（PRD F-I5）", () => {
  it("本轮 / 累计（含子 Agent）/ 速率都给全", async () => {
    const history: MessageUpsertInput[] = [
      {
        id: "m-old-answer",
        conversationId: CONVERSATION_ID,
        role: AgentNSValue.Role.Assistant,
        status: AgentNSValue.MessageStatus.Completed,
        omit: false,
        content: "上一轮的回答",
        data: { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
        createdAt: 1,
      },
      {
        id: "m-old-tool",
        conversationId: CONVERSATION_ID,
        role: AgentNSValue.Role.Tool,
        status: AgentNSValue.MessageStatus.Completed,
        omit: false,
        content: "上一轮的子 Agent 结果",
        data: { tool_call_id: "t0", subAgentUsage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } },
        createdAt: 2,
      },
    ];

    const custom = createHarness({
      history,
      rounds: [
        {
          usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
          toolCalls: [{ id: "t1", name: "delegate" }],
          // 真委派：子 agent 那一份用量由 core 算出来，钉在那条工具结果消息的 `subAgentUsage` 上
          subAgent: {
            name: "helper",
            messages: [
              {
                id: "sub-u",
                role: AgentNSValue.Role.User,
                status: AgentNSValue.MessageStatus.Completed,
                content: "办一下",
              },
            ],
            stream: ["办好了"],
            usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 },
          },
        },
      ],
    });
    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "再来一轮" },
    });
    // 这一轮跑了两秒（假时钟在发请求之后、结算之前推进）
    custom.clock.advance(2000);
    const settlement = await turn.done;

    // 本轮：这一次请求 + 它派出去的子 Agent
    expect(settlement.usage.turn).toEqual({ prompt_tokens: 230, completion_tokens: 23, total_tokens: 253 });
    // 累计：上一轮（含它自己的子 Agent）+ 本轮
    expect(settlement.usage.total).toEqual({ prompt_tokens: 380, completion_tokens: 38, total_tokens: 418 });
    // 累计里由子 Agent 贡献的那部分（漏了它，用户会发现账单比界面大）
    expect(settlement.usage.subAgent).toEqual({ prompt_tokens: 80, completion_tokens: 8, total_tokens: 88 });
    // 速率按输出 token / 秒算
    expect(settlement.usage.rate).toEqual({
      value: 11.5,
      unit: "tokens_per_second",
      basis: "completion",
    });
  });
});

describe("真装配：压缩按会话类型归一（派生会话自动压 / 用户会话交还给提问）", () => {
  /** 压缩标记写在这一刻（断言它落到了会话行上） */
  const COMPACTED_AT = 4242;

  /** 装配现场：真 Scope（交接线 100）+ 真 SDK agent + 真库里的那一行会话 */
  interface Assembly {
    agent: ChatAgent;
    /** 插件真的调了 `service.migrate` 的那几次（替身记账） */
    migrations: Array<{ promptTokens: number; handoffTokens: number; mode?: string }>;
    conversations: ConversationRepository;
    cleanup(): Promise<void>;
  }

  /** 按给定会话类型装配一次（`derived` 决定 `resolveMode` 回 `"self"` 还是 `null`） */
  async function assemble(options: { derived?: boolean; busy?: boolean } = {}): Promise<Assembly> {
    const dir = await mkdtemp(join(tmpdir(), "ai-zen-sdk-factory-"));
    const agentsDir = join(dir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "a1.json"),
      JSON.stringify({ id: "a1", name: "助手", modelId: "model-1", messages: [], custom: true }),
      "utf-8",
    );

    const scope = new Scope({
      cwd: dir,
      agentsDir,
      getConfig: () => ({
        endpoints: [{ id: "e1", name: "端点", baseUrl: "https://example.test/v1", apiKey: "k" }],
        models: [
          {
            id: "model-1",
            name: "模型",
            endpointId: "e1",
            tokenThresholds: { handoff: 100, guard: 200 },
          },
        ],
      }),
    });

    // 真库：压缩标记要真的落到会话行上（`onCompacted` 就是 app.ts 里那条接线）
    const db = new Database(join(dir, "ai-zen.db"));
    await migrate(db);
    const conversations = new ConversationRepository(db);
    await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
      WORKSPACE_ID,
      "项目",
      dir,
      1,
    ]);
    await conversations.create({
      id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      name: "会话",
      agentId: "a1",
      modelId: "model-1",
      createdAt: 1,
    });

    // 交接服务替身：`busy` 与 `migrate` 是插件唯一用到的两格
    const migrations: Assembly["migrations"] = [];
    const handoff = {
      busy: options.busy ?? false,
      migrate: async (input: { promptTokens: number; handoffTokens: number; mode?: string }) => {
        migrations.push(input);
        // 真服务回的是 HandoffContext：插件靠它报「实际用了哪个执行者」
        return { mode: input.mode ?? "self" };
      },
    } as unknown as HandoffService;

    const factory = createSdkAgentFactory({
      handoff: () => handoff,
      isDerivedSession: () => options.derived === true,
      onCompacted: async (context, mode) => {
        await conversations.markCompacted(context.conversationId, mode, COMPACTED_AT);
      },
    });
    const agent = await factory({
      conversationId: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      agentId: "a1",
      modelId: "model-1",
      thinkingLevel: null,
      scope,
      history: [],
    });

    return {
      agent,
      migrations,
      conversations,
      cleanup: async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  /** 装配出来的那个交接线插件（`Agent.use` 之后就在 `_plugins` 里） */
  function autoMigrateOf(agent: ChatAgent): AutoMigratePlugin {
    const plugins = (agent as unknown as { _plugins: unknown[] })._plugins;
    const found = plugins.find((plugin) => plugin instanceof AutoMigratePlugin);
    if (!found) throw new Error("装配里没有 AutoMigratePlugin");
    return found as AutoMigratePlugin;
  }

  /**
   * 让插件看见一次「一圈跑完了、用量是这么多」。
   *
   * core 重写之后插件落在 `onIdle`（`onAfterSend` 已删除）：它不带 ctx，agent 是在
   * `onOuterLoopStart` 那一刻认领的 —— 所以这里按 core 的真实次序演一遍。
   */
  async function afterSend(agent: ChatAgent, promptTokens: number): Promise<void> {
    const stub = {
      lastUsage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
    };
    const plugin = autoMigrateOf(agent);
    plugin.onOuterLoopStart?.({ agent: stub } as unknown as OuterLoopContext);
    await plugin.onIdle?.();
  }

  it("派生会话越过交接线：自己压（migrate 被调一次，mode 是 self），会话行记 auto", async () => {
    const assembly = await assemble({ derived: true });
    try {
      // 交接线是 100（配置里那个模型的 tokenThresholds.handoff）：9999 远超它
      await afterSend(assembly.agent, 9999);

      expect(assembly.migrations).toHaveLength(1);
      expect(assembly.migrations[0]).toMatchObject({
        promptTokens: 9999,
        // 与 askHandoffAfterSettle 同一个来源：生效模型上的那条线，不另算一份
        handoffTokens: 100,
        mode: "self",
      });
      // 压缩标记落到会话行上：`auto`（派生会话没人看着，插件自己压）
      expect(await assembly.conversations.get(CONVERSATION_ID)).toMatchObject({
        compactedAt: COMPACTED_AT,
        compactionMode: "auto",
      });
    } finally {
      await assembly.cleanup();
    }
  });

  it("用户会话越过交接线：插件不迁移（要不要压交还给宿主的提问路径），行上也没有标记", async () => {
    const assembly = await assemble({ derived: false });
    try {
      await afterSend(assembly.agent, 9999);

      // `resolveMode` 回 null = 本次不迁移：压不压由一轮结算之后的那个问题决定
      expect(assembly.migrations).toEqual([]);
      expect(await assembly.conversations.get(CONVERSATION_ID)).toMatchObject({
        compactedAt: null,
        compactionMode: null,
      });
    } finally {
      await assembly.cleanup();
    }
  });

  it("递归防护：交接回合自己产生的 onIdle 不再触发迁移（service.busy 让行）", async () => {
    const assembly = await assemble({ derived: true, busy: true });
    try {
      // 交接回合本身也是往同一个 agent 里推一轮，它收尾时 `onIdle` 会再到这里：busy 时必须让行
      await afterSend(assembly.agent, 9999);
      expect(assembly.migrations).toEqual([]);
      expect(await assembly.conversations.get(CONVERSATION_ID)).toMatchObject({
        compactionMode: null,
      });
    } finally {
      await assembly.cleanup();
    }
  });
});


describe("ChatRunner：接口面", () => {
  it("`RunRegistry` 本身就是服务层要的那个窄接口（只问忙不忙）", () => {
    const runs = new RunRegistry({ clock: new ManualClock() });
    const view: { isRunning(conversationId: string): boolean } = runs;
    expect(view.isRunning("c-1")).toBe(false);
  });

  it("中止走注册表那一条路：`runner.abort` 与句柄是同一件事", async () => {
    const gate = deferred<void>();
    const custom = createHarness({ rounds: [{ gate: gate.promise }] });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "喂" },
    });
    expect(custom.runner.abort(CONVERSATION_ID, "停")).toBe(true);
    expect(custom.runner.abort("c-other")).toBe(false);

    gate.resolve();
    const settlement = await turn.done;
    expect(settlement.outcome).toBe("aborted");
  });

  it("重连拉现场时能拿到流中的快照，结算后就拿不到了（PRD L5）", async () => {
    const gate = deferred<void>();
    const custom = createHarness({ rounds: [{ gate: gate.promise, deltas: [{ content: "来" }] }] });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "在吗" },
    });
    await flushMicrotasks();

    const live = custom.runner.turn(CONVERSATION_ID);
    expect(live).toBe(turn);
    const snapshot = live!.runState();
    expect(snapshot.status).toBe("running");
    expect(snapshot.assistantMessageId).toBe(turn.assistantMessageId);
    expect(snapshot.generation?.phase).toBe("awaiting_first_token");

    gate.resolve();
    await turn.done;
    // 轮次已经不在跑：“现场”改由 conversation.state 合库里的快照给
    expect(custom.runner.turn(CONVERSATION_ID)).toBeUndefined();
  });

  it("历史里的消息原样还原成 core 消息（内容段、工具调用、用量都不丢）", async () => {
    const stored: StoredMessage = {
      id: "m-1",
      conversationId: CONVERSATION_ID,
      seq: 1,
      role: AgentNSValue.Role.Assistant,
      status: AgentNSValue.MessageStatus.Completed,
      omit: true,
      parentToolCallId: null,
      content: [{ index: 0, type: "text", text: "带图的回答" }, { index: 1, type: "image_url", image_url: { url: "https://example.com/a.png" } }],
      data: {
        reasoning_content: "想过",
        tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "ls", arguments: "{}" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const custom = createHarness({});

    // reconcile 的入参就是库里的行；顺带证明「不知道的字段形态」不会被误读成别的类型
    custom.store.seed({
      id: stored.id,
      conversationId: stored.conversationId,
      role: stored.role,
      status: stored.status,
      omit: stored.omit,
      content: stored.content as unknown as MessageUpsertInput["content"],
      data: stored.data,
      createdAt: stored.createdAt,
    });

    const result = await custom.runner.reconcile(CONVERSATION_ID);
    const message = result.messages[0]! as AgentNS.Message;
    expect(message.content).toEqual(stored.content);
    expect(message.reasoning_content).toBe("想过");
    expect(message.tool_calls?.[0]?.function?.name).toBe("ls");
    expect(message.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    expect(message.omit).toBe(true);
  });
});

describe("ChatRunner：与真实存储对接", () => {
  it("一轮跑完后从 SQLite 读回来：状态、内容、用量都在同一条消息上", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-zen-runtime-"));
    const db = new Database(join(dir, "ai-zen.db"));
    try {
      await migrate(db);
      const workspaces = new WorkspaceRepository(db);
      const conversations = new ConversationRepository(db);
      const messages = new MessageRepository(db);

      await workspaces.create({ id: WORKSPACE_ID, name: "项目", cwd: dir, createdAt: 1 });
      await conversations.create({
        id: CONVERSATION_ID,
        workspaceId: WORKSPACE_ID,
        name: "对话",
        agentId: "default",
        modelId: "model-1",
        createdAt: 2,
      });

      const clock = new ManualClock();
      const { scope } = createFakeScope(dir);
      const scopes = new ScopeRegistry({ createScope: async () => scope });
      const runs = new RunRegistry({ clock });
      let idCursor = 0;
      const runner = new ChatRunner({
        messages,
        conversations,
        scopes,
        runs,
        agents: new AgentRegistry({
          scopes,
          runs,
          createAgent: async () => new FakeAgent(plainRounds()),
        }),
        emit: () => undefined,
        clock,
        newId: () => `db-${++idCursor}`,
        streamWriteIntervalMs: 0,
      });

      const turn = await runner.run({
        conversationId: CONVERSATION_ID,
        input: { content: "落库看看" },
      });
      await turn.done;

      const stored = await messages.listByConversation(CONVERSATION_ID);
      expect(stored.map((row) => row.id)).toEqual([turn.userMessageId, turn.assistantMessageId]);

      const assistant = stored.at(-1)!;
      expect(assistant.status).toBe(AgentNSValue.MessageStatus.Completed);
      expect(assistant.content).toBe("你好");
      expect(assistant.data?.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      });

      // 重启之后按库里那份修复：已经结算的消息不会被改动
      const reconciled = await runner.reconcile(CONVERSATION_ID);
      expect(reconciled.repairedIds).toEqual([]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("真装配：会话级模型与思考档位（F-B4 / F-B6）", () => {
  /** 造一个真 Scope：两个模型，只有 model-1 挂着思考策略表 */
  function makeScope(dir: string, agentsDir: string): Scope {
    return new Scope({
      cwd: dir,
      agentsDir,
      getConfig: () => ({
        endpoints: [{ id: "e1", name: "端点", baseUrl: "https://example.test/v1", apiKey: "k" }],
        models: [
          {
            id: "model-1",
            name: "模型一",
            endpointId: "e1",
            tokenThresholds: { handoff: 100, guard: 200 },
            reasoningPreset: "test-preset",
          },
          {
            id: "model-2",
            name: "模型二",
            endpointId: "e1",
            tokenThresholds: { handoff: 50, guard: 150 },
          },
        ],
        defaultModel: "model-2",
      }),
    });
  }

  const PRESETS = {
    "test-preset": { levels: { low: { reasoning_effort: "low" }, high: { reasoning_effort: "high" } } },
  };

  async function build(input: {
    agentModelId?: string;
    agentParams?: Record<string, unknown>;
    conversationModelId: string;
    thinkingLevel: string | null;
  }): Promise<{ modelConfig: Record<string, unknown> }> {
    const dir = await mkdtemp(join(tmpdir(), "ai-zen-session-params-"));
    try {
      const agentsDir = join(dir, "agents");
      await mkdir(agentsDir, { recursive: true });
      await writeFile(
        join(agentsDir, "a1.json"),
        JSON.stringify({
          id: "a1",
          name: "助手",
          messages: [],
          custom: true,
          ...(input.agentModelId === undefined ? {} : { modelId: input.agentModelId }),
          ...(input.agentParams === undefined ? {} : { modelParams: input.agentParams }),
        }),
        "utf-8",
      );
      const factory = createSdkAgentFactory({ thinkingPresets: () => PRESETS });
      const agent = await factory({
        conversationId: CONVERSATION_ID,
        workspaceId: WORKSPACE_ID,
        agentId: "a1",
        modelId: input.conversationModelId,
        thinkingLevel: input.thinkingLevel,
        scope: makeScope(dir, agentsDir),
        history: [],
      });
      const withConfig = agent as unknown as { modelConfig: Record<string, unknown> };
      return { modelConfig: withConfig.modelConfig };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("档位展开成参数补丁，叠在助手定义的参数之上", async () => {
    const { modelConfig } = await build({
      agentModelId: "model-1",
      agentParams: { reasoning_effort: "low", temperature: 0.2 },
      conversationModelId: "model-1",
      thinkingLevel: "high",
    });
    expect(modelConfig).toMatchObject({ reasoning_effort: "high", temperature: 0.2 });
  });

  it("没选档位时就是助手定义上的那份参数", async () => {
    const { modelConfig } = await build({
      agentModelId: "model-1",
      agentParams: { reasoning_effort: "low" },
      conversationModelId: "model-1",
      thinkingLevel: null,
    });
    expect(modelConfig).toMatchObject({ reasoning_effort: "low" });
  });

  it("会话把模型换掉之后，助手定义上那份参数不跟着走（它是给旧模型配的）", async () => {
    const { modelConfig } = await build({
      agentModelId: "model-1",
      agentParams: { reasoning_effort: "high", thinking: { type: "enabled" } },
      conversationModelId: "model-2",
      thinkingLevel: null,
    });
    expect(modelConfig).not.toHaveProperty("reasoning_effort");
    expect(modelConfig).not.toHaveProperty("thinking");
  });

  it("换过模型之后即使档位名还在，也不会把旧模型的补丁发出去", async () => {
    // model-2 没有策略表：档位名展不开，只剩「什么都不带」
    const { modelConfig } = await build({
      agentModelId: "model-1",
      agentParams: { reasoning_effort: "high" },
      conversationModelId: "model-2",
      thinkingLevel: "high",
    });
    expect(modelConfig).not.toHaveProperty("reasoning_effort");
  });
});

// ---------------------------------------------------------------------------
// 素材：落库形态（__asset_id）
// ---------------------------------------------------------------------------

/** 落库用的内容：素材段只有本地扩展字段（真实现是 `AssetService.prepareAttachments`） */
const STORED_CONTENT: LocalMessageContentSection[] = [
  { type: "text", text: "看看这张" },
  { type: "image_url", image_url: { url: "" }, __asset_id: "a1" },
];

describe("素材：落库只存 __asset_id", () => {
  it("用户消息落库用的是 storedContent，发给 agent 的是转换后的内容", async () => {
    const agent = new FakeAgent([{ deltas: [{ content: "好" }] }]);
    const custom = createHarness({
      agent,
      prepareAttachments: async () => ({
        // 发出去的那一份带厂商产物
        content: [
          { type: "text", text: "看看这张" },
          { type: "file", file_id: "file-abc" },
        ],
        attachments: [],
        storedContent: STORED_CONTENT,
      }),
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看这张" },
    });
    await turn.done;

    // 发给模型的是厂商能吃的段（模型第一次请求里那条用户消息）
    const sent = agent.requests[0]!.filter((message) => message.id === turn.userMessageId);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain("file-abc");
    // 库里只有我们的引用
    expect(custom.store.peek(turn.userMessageId)?.content).toEqual(STORED_CONTENT);
    expect(JSON.stringify(custom.store.writes)).not.toContain("file-abc");
  });

  it("用户消息落库那一刻登记素材关系行（同一 message+asset 只一行）", async () => {
    const linked: Array<{ conversationId: string; messageId: string; content: unknown }> = [];
    const custom = createHarness({
      rounds: plainRounds(),
      prepareAttachments: async () => ({
        content: [{ type: "text", text: "看看这张" }],
        attachments: [],
        storedContent: STORED_CONTENT,
      }),
      linkMessageAssets: async (context) => {
        linked.push(context);
        return 1;
      },
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看这张" },
    });
    await turn.done;

    // 扫的是落库的那一份内容（带 `__asset_id`），拿的是刚落库的那条用户消息 id
    expect(linked).toHaveLength(1);
    expect(linked[0]?.conversationId).toBe(CONVERSATION_ID);
    expect(linked[0]?.messageId).toBe(turn.userMessageId);
    expect(JSON.stringify(linked[0]?.content)).toContain("__asset_id");
  });

  it("历史里的 __asset_id 每轮发送前交给 prepareHistory 还原", async () => {
    const resolvedCalls: AgentNS.Message[][] = [];
    const custom = createHarness({
      rounds: plainRounds(),
      history: [
        {
          id: "old-1",
          conversationId: CONVERSATION_ID,
          role: "user",
          status: "completed",
          omit: false,
          content: [
            { type: "image_url", image_url: { url: "" }, __asset_id: "a1" },
          ] as never,
          data: null,
          createdAt: 1,
        },
      ],
      prepareHistory: async ({ messages }) => {
        resolvedCalls.push(messages);
        return messages.map((message) => ({
          ...message,
          content: [{ type: "text", text: "重放过的图" }],
        }));
      },
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "接着聊" },
    });
    await turn.done;

    // 装载出来的历史（带 __asset_id）交给还原方
    expect(JSON.stringify(resolvedCalls[0])).toContain("__asset_id");
    // agent 拿到的是还原后的历史
    expect(JSON.stringify(custom.builds[0]?.history)).toContain("重放过的图");
    expect(JSON.stringify(custom.builds[0]?.history)).not.toContain("__asset_id");
  });
});

// ---------------------------------------------------------------------------
// 子 Agent 的输出要过线（F-I7）：没有这几条，客户端整轮都看不到一个字
// ---------------------------------------------------------------------------

describe("ChatRunner：子 Agent 说的话也推给客户端", () => {
  it("每片正文都推一条 message.delta，带 toolCallId 与同一条消息的 id", async () => {
    const custom = createHarness({
      rounds: [
        {
          deltas: [
            {
              tool_calls: [
                { index: 0, id: "call-7", type: "function", function: { name: "delegate", arguments: "{}" } },
              ],
            },
          ],
          toolCalls: [{ id: "call-7", name: "delegate" }],
          subAgent: {
            name: "helper",
            messages: [
              {
                id: "inner-a",
                role: AgentNSValue.Role.Assistant,
                status: AgentNSValue.MessageStatus.Writing,
                content: "",
              },
            ],
            stream: ["查到", "了。"],
          },
        },
      ],
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "交给助手" },
    });
    await turn.done;

    const sub = custom.pushed("message.delta").filter((payload) => payload.toolCallId === "call-7");
    expect(sub.map((payload) => payload.delta.content)).toEqual(["查到", "了。"]);
    // 同一条消息：两片落在同一个 id 上（客户端据此把字拼成一条，而不是两条）
    expect(sub[0]!.messageId).toBe(sub[1]!.messageId);
    expect(sub.map((payload) => payload.seq)).toEqual([0, 1]);
    // 主线的增量不带 toolCallId（那是主转录的）
    const main = custom.pushed("message.delta").filter((payload) => payload.toolCallId === undefined);
    expect(main.length).toBeGreaterThan(0);
  });

  it("落库用的是同一个 id：流式看到的与重开对话读回来的不会变成两条", async () => {
    const custom = createHarness({
      rounds: [
        {
          deltas: [
            {
              tool_calls: [
                { index: 0, id: "call-8", type: "function", function: { name: "delegate", arguments: "{}" } },
              ],
            },
          ],
          toolCalls: [{ id: "call-8", name: "delegate" }],
          subAgent: {
            name: "helper",
            messages: [
              {
                id: "inner-a",
                role: AgentNSValue.Role.Assistant,
                status: AgentNSValue.MessageStatus.Writing,
                content: "",
              },
            ],
            stream: ["查到了。"],
          },
        },
      ],
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "交给助手" },
    });
    await turn.done;

    const streamed = custom.pushed("message.delta").find((payload) => payload.toolCallId === "call-8");
    expect(streamed).toBeDefined();
    // 流式推出去的那个 id 就是库里那一行（收尾之后再读，读到的就是终版）
    const row = custom.store.peek(streamed!.messageId);
    expect(row).toBeDefined();
    // 挂在这次委派上，且带上子 Agent 说的正文
    expect(row!.parentToolCallId).toBe("call-8");
    expect(String(row!.content)).toContain("查到了。");
  });
});

// ---------------------------------------------------------------------------
// 跑中发送：进 inbox，不打断（D14 / D5）
// ---------------------------------------------------------------------------

/**
 * 一条会卡住的写：用例借此把「`send()` 已返回、库还没写完」那一段定住。
 *
 * 那一段在 `RunRegistry` 眼里仍然是「在跑」，但 core 已经不会再取走任何 inbox 条目 ——
 * 它正是「回了 queued: true 却把条目弄丢」最容易发生的那一瞬，必须有用例钉住。
 */
class GatedMessageStore extends RecordingMessageStore {
  readonly reached: Promise<void>;
  private markReached!: () => void;
  private calls = 0;

  constructor(
    private readonly gateAfterCall: number,
    private readonly gate: Deferred<void>,
  ) {
    super();
    this.reached = new Promise<void>((resolve) => {
      this.markReached = resolve;
    });
  }

  override async upsertMany(inputs: MessageUpsertInput[]): Promise<void> {
    this.calls += 1;
    await super.upsertMany(inputs);
    if (this.calls < this.gateAfterCall) return;
    this.markReached();
    await this.gate.promise;
  }
}

describe("ChatRunner：跑中发送进 inbox（D14：不打断、也不回 busy）", () => {
  it("入队把这一句推进**这一轮**的 inbox，回执带上它的 id 与附件结局", async () => {
    const gate = deferred<void>();
    const agent = new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢慢说" }] }]);
    const custom = createHarness({ agent });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await flushMicrotasks();

    const queued = await custom.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "顺便问一句" },
    });

    expect(queued).not.toBeNull();
    // D5：id 是入队这一刻定下的，不是落地时另生成的
    expect(queued!.userMessageId.length).toBeGreaterThan(0);
    expect(queued!.conversationId).toBe(CONVERSATION_ID);
    expect(queued!.attachments).toEqual([]);
    expect(Date.parse(queued!.acceptedAt)).toBe(custom.clock.now());

    // 条目真的进了这一轮 agent 的队列（core 只给个数）
    expect(agent.inboxSize).toBe(1);

    // 客户端看得见「这一条排上了」：`RunState.inbox` 是**现读** `agent.inboxPending` 拼的
    // （core 取走条目时不发事件，所以不能靠事件自建一份镜像）
    const inbox = custom.lastRunState().inbox;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.messageId).toBe(queued!.userMessageId);
    expect(inbox[0]!.source).toEqual({ kind: "user" });
    expect(inbox[0]!.preview).toBe("顺便问一句");

    gate.resolve();
    await turn.done;
  });

  it("丢一条 `inboxAdded` 通知：排队区照样正确（现读 `inboxPending`，不靠通知维护镜像）", async () => {
    // 这条用例钉的是本次改动的全部意义：core 在**取走**条目时不发任何事件（钥匙连消息都不落），
    // 所以「靠 `inboxAdded` / `messageAdded` 维护一份镜像」必然与真队列分叉，而分叉之后无法
    // 重读自愈。现在排队区是现读的：通知丢了也好、漏猜一次取走也好，看到的都是真队列。
    const toolGate = deferred<void>();
    const agent = new FakeAgent([
      {
        deltas: [{ content: "我查一下。" }],
        toolCalls: [{ id: "call-1", name: "read", arguments: "{}" }],
        toolGate: toolGate.promise,
      },
      { deltas: [{ content: "查到了。" }] },
    ]);
    // 把这条通知整个吞掉（模拟“宿主没收到 / 丢了一条”）
    const emit = agent.emit.bind(agent);
    agent.emit = ((type: string, payload: unknown) => {
      if (type === "inboxAdded") return;
      (emit as (this: void, t: string, p: unknown) => void)(type, payload);
    }) as typeof agent.emit;

    const custom = createHarness({ agent });
    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看文件" },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (agent.messages.some((message) => message.role === AgentNSValue.Role.Tool)) break;
      await flushMicrotasks();
    }

    const queued = await custom.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "丢通知也要看得见" },
    });
    expect(queued).not.toBeNull();
    // 通知被吞了，队列里那一条依然看得见（内容、来源、入队时刻都对）
    expect(agent.inboxPending).toHaveLength(1);
    const inbox = custom.lastRunState().inbox;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.messageId).toBe(queued!.userMessageId);
    expect(inbox[0]!.source).toEqual({ kind: "user" });
    expect(inbox[0]!.preview).toBe("丢通知也要看得见");

    // 反过来也不靠通知：那一条被 core 取走（落成消息）之后，排队区自己就空了
    toolGate.resolve();
    const settlement = await turn.done;
    expect(agent.inboxPending).toHaveLength(0);
    expect(settlement.run.inbox).toEqual([]);
  });

  it("这一轮收工之后不再入队：回 null，让调用方回老路径", async () => {
    const custom = createHarness({ rounds: plainRounds() });
    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "说一句" },
    });
    await turn.done;

    expect(
      await custom.runner.enqueue({ conversationId: CONVERSATION_ID, input: { content: "再来" } }),
    ).toBeNull();
  });

  it("agent 还没装上就来的那一句：当场受理，装上那一刻进它的 inbox", async () => {
    // 改前：`enqueue` 在装配窗口里挂在一个 promise + 定时器上等（`waitEnqueueable`，上界 10s）；
    // 改后：这几句先收进 `pending`，`attach()` 里一次冲进 inbox —— 不等、不回 busy。
    const build = deferred<ChatAgent>();
    const sendGate = deferred<void>();
    const agent = new FakeAgent([
      { gate: sendGate.promise, deltas: [{ content: "先答" }] },
      { deltas: [{ content: "再答" }] },
    ]);
    const custom = createHarness({ buildAgent: async () => await build.promise });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await flushMicrotasks();

    // 轮次已登记、agent 还在装配：当场就回回执（同步，不隔任何等待）
    const queued = await custom.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "装配期间发的" },
    });
    expect(queued).not.toBeNull();
    expect(agent.inboxSize).toBe(0);
    // 客户端看得见「这一条排上了」：缓冲着的也算
    expect(custom.lastRunState().inbox.map((item) => item.messageId)).toEqual([
      queued!.userMessageId,
    ]);

    // 装好那一刻：条目被 `push` 进它的 inbox（id 还是入队时那个）。
    // 它可能当场就被这一批取走（两次 push 之间 core 的循环还没转起来，于是同一批取干），
    // 所以「进去了没有」看的是「在队列里 或者 已经落成消息」。
    build.resolve(agent);
    await flushMicrotasks();
    expect(
      agent.inboxSize > 0 || agent.messages.some((message) => message.id === queued!.userMessageId),
    ).toBe(true);

    // 这一轮按原来的脚本跑完，排进来的那一句在轮末落地
    sendGate.resolve();
    await turn.done;
    expect(agent.messages.some((message) => message.id === queued!.userMessageId)).toBe(true);
  });

  it("已经跑完、还在写库的那一段：回 null（不回一句「排队了」然后把条目丢掉）", async () => {
    const gate = deferred<void>();
    // 第 1 次是受理时那两条占位，第 2 次就是结算时的最终版
    const store = new GatedMessageStore(2, gate);
    const custom = createHarness({ rounds: plainRounds(), store });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "说一句" },
    });
    // 等它进到「写最终版」：`send()` 已经返回，`run.state` 里 status 还是 running
    await store.reached;
    expect(custom.runs.isRunning(CONVERSATION_ID)).toBe(true);
    expect(custom.lastRunState().status).toBe("running");

    expect(
      await custom.runner.enqueue({ conversationId: CONVERSATION_ID, input: { content: "晚了一步" } }),
    ).toBeNull();

    gate.resolve();
    await turn.done;
  });

  it("条目在轮末落地：id 是入队时那个，下一次请求里带着它，库里也只有这一条", async () => {
    const toolGate = deferred<void>();
    const agent = new FakeAgent([
      // ①模型要一个工具 → （等工具期间用户发了第二句）→ ②工具跑完后高优先条目落地 → ③模型看到它再答
      {
        deltas: [{ content: "我查一下。" }],
        toolCalls: [{ id: "call-1", name: "read", arguments: "{}" }],
        toolGate: toolGate.promise,
      },
      { deltas: [{ content: "查到了，顺手也看了你说的那件事。" }] },
    ]);
    const custom = createHarness({ agent });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看文件" },
    });
    // 等这一轮进到「等工具」
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (agent.messages.some((message) => message.role === AgentNSValue.Role.Tool)) break;
      await flushMicrotasks();
    }

    const queued = await custom.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "顺便看下这个" },
    });
    expect(queued).not.toBeNull();
    expect(custom.lastRunState().inbox).toHaveLength(1);

    toolGate.resolve();
    const settlement = await turn.done;

    // 落地：id 就是入队时那个（D5），正文原样（用户来源不加来源注释）
    const landed = settlement.messages.find((message) => message.id === queued!.userMessageId);
    expect(landed).toBeDefined();
    expect(landed!.role).toBe(AgentNSValue.Role.User);
    expect(landed!.content).toBe("顺便看下这个");
    // 轮末消费掉：inbox 空了（core 只给个数）
    expect(agent.inboxSize).toBe(0);

    // 下一次请求里带着它，且排在工具结果之后（模型下一轮天然看得见）
    const second = agent.requests[1];
    expect(second).toBeDefined();
    expect(second!.at(-1)!.id).toBe(queued!.userMessageId);
    const toolIndex = second!.findIndex((message) => message.role === AgentNSValue.Role.Tool);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(second!.length - 1).toBeGreaterThan(toolIndex);

    // 落库一条，且是同一个 id（客户端不会把同一条画两遍）
    const rows = custom.store.writes.filter((write) => write.id === queued!.userMessageId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)!.content).toBe("顺便看下这个");
    expect(rows.at(-1)!.role).toBe(AgentNSValue.Role.User);
    // 结算快照里也是空：收工之后没有「还在排」这一档
    expect(settlement.run.inbox).toEqual([]);
  });

  it("排队那条在落地那一刻就写库：写入顺序与最终 seq 都排在它引出的回答之前", async () => {
    const toolGate = deferred<void>();
    const agent = new FakeAgent([
      // ①模型要一个工具 →（等工具期间用户插一句）→ ②工具跑完后它落地 → ③模型回它
      {
        deltas: [{ content: "我查一下。" }],
        toolCalls: [{ id: "call-1", name: "read", arguments: "{}" }],
        toolGate: toolGate.promise,
      },
      { deltas: [{ content: "查到了，回你插的那句。" }] },
    ]);
    const custom = createHarness({ agent });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看文件" },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (agent.messages.some((message) => message.role === AgentNSValue.Role.Tool)) break;
      await flushMicrotasks();
    }

    const queued = await custom.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "跑着的时候插一句" },
    });
    expect(queued).not.toBeNull();
    // 还在 inbox 里排着 = 还不是一条消息：库里此刻没有它（写库发生在落地那一刻）
    expect(custom.store.peek(queued!.userMessageId)).toBeUndefined();

    // 推进时钟：受理时刻与落地时刻要能分辨，`createdAt` 那条断言靠它
    const acceptedAtMs = custom.clock.now();
    custom.clock.advance(5_000);

    toolGate.resolve();
    const settlement = await turn.done;

    // 它引出的那条回答 = 第二轮（工具轮之后）那条助手消息
    const assistants = settlement.produced.filter(
      (message) => message.role === AgentNSValue.Role.Assistant,
    );
    expect(assistants).toHaveLength(2);
    const reply = assistants[1]!;

    // ① 写入顺序：排队那条的**第一笔**写在回答的第一笔之前（`writes` 就是 upsert 的先后）
    const firstWriteAt = (id: string): number =>
      custom.store.writes.findIndex((row) => row.id === id);
    expect(firstWriteAt(queued!.userMessageId)).toBeGreaterThanOrEqual(0);
    expect(firstWriteAt(reply.id)).toBeGreaterThan(firstWriteAt(queued!.userMessageId));

    // ② 最终 seq：`RecordingMessageStore` 取「这条消息第一次写入的先后」当 seq，与真仓储的
    //    `MAX(seq)+1` 按插入顺序给同一个口径 —— 读回来的这段就是库里的顺序
    const page = await custom.store.listByConversation(CONVERSATION_ID);
    const seqOf = (id: string): number | undefined => page.find((row) => row.id === id)?.seq;
    expect(seqOf(queued!.userMessageId)).toBeDefined();
    expect(seqOf(reply.id)).toBeDefined();
    expect(seqOf(queued!.userMessageId)!).toBeLessThan(seqOf(reply.id)!);
    // 读者看到的是「用户插一句 → 助手回它」，中间不夹别的
    const ids = page.map((row) => row.id);
    expect(ids.indexOf(queued!.userMessageId) + 1).toBe(ids.indexOf(reply.id));

    // ③ 幂等：落地写一笔、收尾再覆盖一笔，同一个 id 不会变成两行
    expect(custom.store.historyOf(queued!.userMessageId)).toHaveLength(2);
    expect(page.filter((row) => row.id === queued!.userMessageId)).toHaveLength(1);

    // ④ createdAt 取落地那一刻（不是受理那一刻，也不是收尾那一刻）
    expect(custom.store.peek(queued!.userMessageId)?.createdAt).toBe(acceptedAtMs + 5_000);
  });

  it("abort 不丢排队条目：它留在 core 的队列里，只是不在这一段落地（等下一次被叫起来）", async () => {
    // 口径已变（core 侧的语义变更，有意）：`abort()` 不再 `clearInbox()`。
    // 一条来自别的会话的投递不该被「用户按停」这个无关动作抹掉，所以这一轮被中止之后，
    // 队列里的那一句**还在**（`agent.inboxSize` 仍是 1）；它只是不在这一段落地。
    const gate = deferred<void>();
    const agent = new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢慢说" }] }]);
    const custom = createHarness({ agent });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await flushMicrotasks();

    const queued = await custom.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "还没发出去的那句" },
    });
    expect(queued).not.toBeNull();
    expect(turn.runState().inbox).toHaveLength(1);

    turn.abort("用户按了停");
    // 数据是数据：队列不动（core 的 `abort` 不清空 inbox）—— 现读一下就能作证
    expect(agent.inboxSize).toBe(1);
    expect(agent.inboxPending.map((entry) => entry.content)).toEqual(["还没发出去的那句"]);
    // 而这一段到此就结束了（core 报 `paused` → 结算），所以它不再报「我这轮还排着什么」
    expect(turn.runState().status).toBe("settled");

    gate.resolve();
    const settlement = await turn.done;

    expect(settlement.outcome).toBe("aborted");
    // 已结算的那一轮报空：`inbox` 说的是「**这一轮**还排着什么」，而这一轮已经不再取件了。
    // （它不是说「队列空了」：那一句真的还在 core 的队列里，等下一次被叫起来的那一段带走。）
    expect(settlement.run.inbox).toEqual([]);
    expect(agent.inboxPending).toHaveLength(1);
    // 那一句既没进内存消息，也没进库（它留在那条队列里，等下一次外部驱动）
    expect(settlement.messages.some((message) => message.id === queued!.userMessageId)).toBe(false);
    expect(custom.store.peek(queued!.userMessageId)).toBeUndefined();
  });

  it("排队那一句的附件照旧过线：发给模型的是转换后的内容，落库的是 __asset_id 那一份", async () => {
    const gate = deferred<void>();
    const agent = new FakeAgent([{ gate: gate.promise, deltas: [{ content: "看到了" }] }]);
    const prepared: AgentNS.MessageContent[] = [];
    const custom = createHarness({
      agent,
      prepareAttachments: async ({ input }) => {
        prepared.push(input.content);
        return {
          // 发出去的那一份带厂商产物（file_id）；库里存的是 `__asset_id`
          content: [
            { type: "text", text: "看图" },
            { type: "file", file_id: "file-abc" },
          ],
          storedContent: [
            { type: "text", text: "看图" },
            { type: "image_url", image_url: { url: "" }, __asset_id: "a1" },
          ] as unknown as AgentNS.MessageContent,
          attachments: [{ assetId: "a1", deliveredAs: "inline", section: null, problem: null }],
        };
      },
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await flushMicrotasks();

    const queued = await custom.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "看图", assetIds: ["a1"] },
    });

    // 排队不等于「附件被静默丢掉」：结局照常回
    expect(queued!.attachments).toHaveLength(1);
    expect(queued!.attachments[0]!.assetId).toBe("a1");
    // 进 core 队列的是**转换之后**的内容：core 落地时直接拿它当消息内容
    // （排队区的摘要就取在这一份上 —— 那条消息的正文不搬进 run.state）
    expect(prepared).toHaveLength(2);
    expect(agent.inboxSize).toBe(1);
    expect(custom.lastRunState().inbox[0]!.preview).toBe("看图 [文件]");

    gate.resolve();
    await turn.done;

    // 落地的那条在库里是 `__asset_id` 形态（与老路径同一个口径，F-H7）
    const row = custom.store.peek(queued!.userMessageId)!;
    expect(JSON.stringify(row.content)).toContain("__asset_id");
    expect(JSON.stringify(row.content)).not.toContain("file-abc");
  });
});

// ---------------------------------------------------------------------------
// agent 常驻：一段对话一个，跨轮复用（只在显式 / 配置变更时销毁）
//
// 改前：`attemptOnce` 里 `agents.create`、`settle` 里无条件 `dispose` —— 一轮一个、跑完即丢。
// 改后：`attemptOnce` 里 `agents.acquire`（在就复用 / 不合用就重建）、`settle` 只做这一段的结算。
// 于是两条必须同时守住：历史只能有一份（内存是真相）、订在 agent 上的监听随这一轮摘掉。
// ---------------------------------------------------------------------------

describe("ChatRunner：agent 常驻（跨轮复用）", () => {
  it("同一段对话连跑两轮：`agents.get` 前后是同一个实例，第二段不再装配", async () => {
    const custom = createHarness({ agentFactory: () => new FakeAgent(plainRounds()) });

    const first = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await first.done;
    const before = custom.agents.get(CONVERSATION_ID);
    expect(before).toBeDefined();

    const second = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第二句" },
    });
    await second.done;
    const after = custom.agents.get(CONVERSATION_ID);

    // 引用相等就是「常驻」本身
    expect(after).toBe(before);
    // 只装配过一次：第二段直接交还同一个对象
    expect(custom.builds).toHaveLength(1);
    // 同一段对话仍然同时只跑一轮（RunRegistry 的职责没变）
    expect(custom.runs.isRunning(CONVERSATION_ID)).toBe(false);
  });

  it("两轮之间历史不重复：agent.messages 与库里条数一致，落库的 seq 连续", async () => {
    const custom = createHarness({ agentFactory: () => new FakeAgent(plainRounds()) });

    const first = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await first.done;
    const second = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第二句" },
    });
    const secondSettlement = await second.done;

    const agent = custom.agents.get(CONVERSATION_ID)!;
    const page = await custom.store.listByConversation(CONVERSATION_ID, undefined, {
      includeHidden: true,
    });

    // ① 条数与库里一致：上一段的历史没有被重新 push 一遍（有的话这里会多出一倍）
    expect(agent.messages).toHaveLength(page.length);
    // ② 逐条对上（顺序也一致）：内存就是库里那些行的同一条时间线
    expect(agent.messages.map((message) => message.id)).toEqual(page.map((row) => row.id));
    // ③ 没有重复 id（双份历史最直接的形状）
    expect(new Set(agent.messages.map((message) => message.id)).size).toBe(
      agent.messages.length,
    );
    // ④ 两轮各一条 user、一条 assistant
    expect(page.filter((row) => row.role === AgentNSValue.Role.User)).toHaveLength(2);
    expect(page.filter((row) => row.role === AgentNSValue.Role.Assistant)).toHaveLength(2);
    // ⑤ 落库的 seq 连续（没有空档、也没有同号）
    expect(page.map((row) => row.seq)).toEqual(page.map((_row, index) => index + 1));
    // ⑥ 第二段的用量只算第二段（累计 = 历史 + 本轮，不是两份历史）
    expect(secondSettlement.usage.turn.total_tokens).toBe(12);
    expect(secondSettlement.usage.total.total_tokens).toBe(24);
  });

  it("首次装配仍然从库里读历史：agent 被回收之后，下一段按库里的历史重新装配", async () => {
    const custom = createHarness({ agentFactory: () => new FakeAgent(plainRounds()) });

    const first = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await first.done;
    const firstAgent = custom.agents.get(CONVERSATION_ID)!;
    const pageAfterFirst = await custom.store.listByConversation(CONVERSATION_ID, undefined, {
      includeHidden: true,
    });
    expect(pageAfterFirst.length).toBeGreaterThan(0);

    // 模拟「这个 agent 已经不在了」（进程重启 / 被显式 kill / 被退役）：登记没了，下一段只能重新装配
    custom.agents.kill(CONVERSATION_ID);

    const second = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第二句" },
    });
    await second.done;
    const rebuilt = custom.agents.get(CONVERSATION_ID)!;

    expect(rebuilt).not.toBe(firstAgent);
    // 装配时交给工厂的历史 = 库里的全部历史（reconcile + resolveHistory 那两步照旧跑了）
    expect(custom.builds).toHaveLength(2);
    expect(custom.builds[1]!.history.map((message) => message.id)).toEqual(
      pageAfterFirst.map((row) => row.id),
    );
    // 新 agent 的 messages 开头就是这份历史（push 进去了，一条不少）
    expect(rebuilt.messages.slice(0, pageAfterFirst.length).map((message) => message.id)).toEqual(
      pageAfterFirst.map((row) => row.id),
    );
  });

  it("对话被删（`forget`）：那个 agent 被硬着陆，不是只摘登记；排着的条目随之作废", async () => {
    // 用户删了这段对话 → 它不该再烧 token、再往库里写。所以选 `kill` 而不是 `stop`：
    // `stop` 是「存量走完」，而这里的存量是要发给一个已经不存在的对话的。
    const gate = deferred<void>();
    const agent = new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢慢说" }] }]);
    const custom = createHarness({ agent });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await flushMicrotasks();
    const queued = await custom.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "还没发出去的那句" },
    });
    expect(queued).not.toBeNull();
    expect(agent.inboxPending).toHaveLength(1);

    custom.runner.forget(CONVERSATION_ID);

    // ① 登记没了（紧接着的 `scopes.dispose` 才拆得动）
    expect(custom.agents.get(CONVERSATION_ID)).toBeUndefined();
    // ② 那个实例真的死了：kill 清了队列，且再 push 抱 `AgentError("closed")`
    expect(agent.inboxPending).toHaveLength(0);
    expect(() =>
      agent.push({ content: "删完之后又有人投", priority: "high", source: { kind: "user" } }),
    ).toThrow();

    gate.resolve();
    const settlement = await turn.done;
    // 这一轮按「用户删了」收场，不是 completed
    expect(settlement.outcome).toBe("aborted");
  });

  it("结算之后推一条进这个（常驻的）agent：它自己起来跑一段，宿主接住并落库", async () => {    const custom = createHarness({ agentFactory: () => new FakeAgent(plainRounds()) });

    const first = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await first.done;

    const agent = custom.agents.get(CONVERSATION_ID) as FakeAgent;
    expect(agent.inboxSize).toBe(0);
    const callsBefore = agent.sendCalls;
    const statesBefore = custom.pushed("run.state").length;

    // 结算之后有人往这个（常驻的）agent 里推了一句：core 的 `push` 会顺手把 agent 叫起来跑
    // **一段由别人叫起来的工作**（`CORE.md` §1：常驻会话只 push，不看返回值）。
    agent.push({ source: { kind: "user" }, priority: "high", content: "跨段带来的这一句" });

    // 宿主从 `state → busy` 接住这一段（建现场 → 落库 → 结算），完全不靠「谁在等」
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (custom.store.writes.some((row) => row.content === "跨段带来的这一句")) break;
      await flushMicrotasks();
    }

    // ① 它落成了一条 user 消息，并且进了库（与这一轮自己发的那句同一个口径）
    const page = await custom.store.listByConversation(CONVERSATION_ID);
    const carried = page.filter((row) => row.content === "跨段带来的这一句");
    expect(carried).toHaveLength(1);
    expect(carried[0]!.role).toBe(AgentNSValue.Role.User);
    // ② 队列取空了，模型又被问了一次
    expect(agent.inboxSize).toBe(0);
    expect(agent.sendCalls).toBeGreaterThan(callsBefore);
    // ③ 这一段也是「一段」：宿主推过 run.state（并把它结算成了 settled）
    expect(custom.pushed("run.state").length).toBeGreaterThan(statesBefore);
    expect(custom.lastRunState().status).toBe("settled");
    // ④ agent 还是同一个实例（常驻）
    expect(custom.agents.get(CONVERSATION_ID)).toBe(agent);
    expect(custom.builds).toHaveLength(1);
  });

  it("abort 之后 agent 留在内存、三格是 paused，下一次用户发话仍能跑", async () => {
    const gate = deferred<void>();
    const agent = new FakeAgent([{ gate: gate.promise, deltas: [{ content: "被打断" }] }]);
    const custom = createHarness({ agent });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await flushMicrotasks();
    turn.abort("用户按了停");
    gate.resolve();
    const settlement = await turn.done;

    expect(settlement.outcome).toBe("aborted");
    // 不 dispose：实例还在登记里；三格是 `paused`（core 的暂停是模式，不是「死了」）
    expect(custom.agents.get(CONVERSATION_ID)).toBe(agent);
    expect(agent.state).toBe("paused");
    // 中止的语义没变：库里的在途消息照旧落成 Aborted
    expect(custom.store.peek(turn.assistantMessageId)?.status).toBe(
      AgentNSValue.MessageStatus.Aborted,
    );

    // 下一次用户发话仍然能跑（同一个实例从 paused 被 `resume` 回来），不是「一次性」的
    const second = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "再来一句" },
    });
    const secondSettlement = await second.done;

    expect(secondSettlement.outcome).toBe("completed");
    expect(custom.agents.get(CONVERSATION_ID)).toBe(agent);
    expect(agent.sendCalls).toBe(2);
    expect(agent.state).toBe("idle");
  });

  it("结算之后 agent 上的事件不再叫到已经收工的那一段（监听随这一轮摘掉）", async () => {
    const agent = new FakeAgent(plainRounds());
    const custom = createHarness({ agent });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await turn.done;
    const writes = custom.store.writes.length;
    const states = custom.pushed("run.state").length;

    // 直接朝这个（常驻的）agent 上广播：没有监听，就不该有任何反应（不认领 id、不推状态、不写库）
    agent.append(Message.Assistant());

    expect(custom.store.writes).toHaveLength(writes);
    expect(custom.pushed("run.state")).toHaveLength(states);
  });

  it("一个已经结算的句柄再按一次停，按不到那个（现在给下一段用的）agent 上", async () => {
    const agent = new FakeAgent(plainRounds());
    const custom = createHarness({ agent });

    const first = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await first.done;
    const abortsBefore = agent.abortCalls;

    first.abort("这一轮早跑完了");

    expect(agent.abortCalls).toBe(abortsBefore);
    expect(agent.state).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// 配置生效：受影响的 agent 要换掉（`Scope.refresh()` 刷不动已经建好的模型客户端）
// ---------------------------------------------------------------------------

describe("ChatRunner：配置生效时换掉 agent", () => {
  it("空闲的当场销毁：下一段按新配置重新装配出一个新实例", async () => {
    const custom = createHarness({ agentFactory: () => new FakeAgent(plainRounds()) });

    const first = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await first.done;
    const firstAgent = custom.agents.get(CONVERSATION_ID)!;

    // 配置改完：`refreshScopesFor` 会调这一下。这一段对话没在跑 → 没什么要等的，立即退役
    const marked = custom.agents.invalidate(WORKSPACE_ID);
    expect(marked).toEqual([]);
    expect(custom.agents.get(CONVERSATION_ID)).toBeUndefined();

    const second = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第二句" },
    });
    await second.done;

    expect(custom.agents.get(CONVERSATION_ID)).not.toBe(firstAgent);
    expect(custom.builds).toHaveLength(2);
  });

  it("正在跑的那一段：只打标记，结算之后才销毁（那一段用旧配置跑完，不被打断）", async () => {
    const gate = deferred<void>();
    const custom = createHarness({
      agentFactory: () => new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢慢来" }] }]),
    });

    const turn = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await flushMicrotasks();
    const running = custom.agents.get(CONVERSATION_ID)!;

    const marked = custom.agents.invalidate(WORKSPACE_ID);
    expect(marked).toEqual([CONVERSATION_ID]);
    // 还在跑：登记没被摘（这一轮还得用它跑完），只是带上了标记
    expect(custom.agents.get(CONVERSATION_ID)).toBe(running);
    expect(turn.runState().status).toBe("running");

    gate.resolve();
    const settlement = await turn.done;

    // 这一轮照常跑完、照常结算（没有变成 aborted / error）
    expect(settlement.outcome).toBe("completed");
    // 结算那一刻兑现标记：登记没了（陈旧才退役，下一段 acquire 重新装配）
    expect(custom.agents.get(CONVERSATION_ID)).toBeUndefined();

    // 下一段重新装配（= 复活）
    const second = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第二句" },
    });
    await second.done;

    expect(custom.agents.get(CONVERSATION_ID)).not.toBe(running);
    expect(custom.builds).toHaveLength(2);
  });

  it("没打标记的 agent 结算之后留着（只有陈旧才换，别把它当成了每轮都换）", async () => {
    const custom = createHarness({ agentFactory: () => new FakeAgent(plainRounds()) });

    const first = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await first.done;
    const agent = custom.agents.get(CONVERSATION_ID);

    // 换掉的是「配置改过的那个 workspace 下的」：别的 workspace 打标记不影响它
    expect(custom.agents.invalidate("ws-none")).toEqual([]);
    expect(custom.agents.get(CONVERSATION_ID)).toBe(agent);
    expect(custom.builds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 装配事实变了就得换 agent（常驻不能把「改了下一段生效」这条吞掉）
//
// 改前：一轮一装配，会话行上的模型 / 思考档位每轮都重读一遍，改了下一段自然生效。
// 改后：agent 常驻，`acquire` 内部判合用；不匹配就丢掉重建（并回库里重读历史，
// 按新模型重新还原素材）。
// ---------------------------------------------------------------------------

describe("ChatRunner：会话的模型 / 档位改了，下一段按新事实重新装配", () => {
  it("换了模型：手里那个被换掉，新 agent 拿到的是新模型，历史仍完整", async () => {
    const conversation = makeConversation();
    const custom = createHarness({
      conversation,
      agentFactory: () => new FakeAgent(plainRounds()),
    });

    const first = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await first.done;
    const before = custom.agents.get(CONVERSATION_ID)!;
    const pageAfterFirst = await custom.store.listByConversation(CONVERSATION_ID);
    expect(custom.builds[0]!.modelId).toBe("model-1");

    // `conversation.setModel` 改的是会话行：这一段对话现在用 model-2
    conversation.modelId = "model-2";

    const second = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第二句" },
    });
    await second.done;

    const after = custom.agents.get(CONVERSATION_ID)!;
    expect(after).not.toBe(before);
    // 新装配那一刻读到的是新模型
    expect(custom.builds).toHaveLength(2);
    expect(custom.builds[1]!.modelId).toBe("model-2");
    // 历史没有丢：走的是「从库里读」那条路（顺带按新模型重新还原素材）
    expect(custom.builds[1]!.history.map((message) => message.id)).toEqual(
      pageAfterFirst.map((row) => row.id),
    );
    expect(after.messages.slice(0, pageAfterFirst.length).map((message) => message.id)).toEqual(
      pageAfterFirst.map((row) => row.id),
    );
  });

  it("事实没变就不换：白跑的装配一次也不多做", async () => {
    const custom = createHarness({ agentFactory: () => new FakeAgent(plainRounds()) });

    const first = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await first.done;
    const agent = custom.agents.get(CONVERSATION_ID);

    const second = await custom.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第二句" },
    });
    await second.done;

    expect(custom.agents.get(CONVERSATION_ID)).toBe(agent);
    expect(custom.builds).toHaveLength(1);
  });
});
