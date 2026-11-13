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
import type { HandoffService, SendContext } from "@ai-zen/agents-sdk";

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
  TurnSettledFacts,
} from "./ChatRunner.js";
import { ChatRunner, createSdkAgentFactory, DEFAULT_STREAM_WRITE_INTERVAL_MS } from "./ChatRunner.js";
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
  /** 素材相关的注入点（`ChatRunner` 只在有它们时才做对应的事） */
  prepareAttachments?: ChatRunnerOptions["prepareAttachments"];
  prepareHistory?: ChatRunnerOptions["prepareHistory"];
  linkMessageAssets?: ChatRunnerOptions["linkMessageAssets"];
  conversation?: Conversation;
  streamWriteIntervalMs?: number;
  history?: MessageUpsertInput[];
  /** 一轮结算之后的回调（R59） */
  onTurnSettled?: (facts: TurnSettledFacts) => void;
  language?: Language;
}): Harness {
  const clock = new ManualClock();
  const store = new RecordingMessageStore();
  for (const row of options.history ?? []) store.seed(row);

  const conversation = options.conversation ?? makeConversation();
  const { scope, plugin } = createFakeScope("/tmp/ai-zen-project");
  const scopes = new ScopeRegistry({ createScope: async () => scope, clock });
  const runs = new RunRegistry({ clock });

  const events: Array<{ name: EventName; payload: EventMap[EventName] }> = [];
  const builds: AgentBuildContext[] = [];
  let idCursor = 0;
  const agent = options.agent ?? new FakeAgent(options.rounds ?? []);

  const runner = new ChatRunner({
    messages: store,
    conversations: {
      get: async (id: string) => (id === conversation.id ? conversation : undefined),
    },
    scopes,
    runs,
    createAgent: async (context) => {
      builds.push(context);
      return options.agentFactory ? options.agentFactory() : agent;
    },
    emit: (name, payload) => {
      events.push({ name, payload });
    },
    clock,
    newId: () => `srv-${++idCursor}`,
    streamWriteIntervalMs: options.streamWriteIntervalMs ?? 0,
    onTurnSettled: options.onTurnSettled,
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
    expect(harness.scopes.size()).toBe(0);
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
      "connected",
      "awaiting_first_token",
      "thinking",
      "generating",
      "assembling_tool_calls",
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
  it("跑完 agent 即丢、Scope 依赖归零，结算态与用量一起推出去（PRD D28 / F-I5）", async () => {
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

    // agent 已经被丢掉：结算之后再叫停不会碰到它
    turn.abort("已经跑完了");
    expect(agent.abortCalls).toBe(0);

    // Scope 的依赖已归还：空闲满 10 分钟才回收（MCP 关闭回调在回收时才被调）
    expect(custom.plugin.disposeCalls).toBe(0);
    custom.clock.advance(TEN_MINUTES);
    await flushMicrotasks();
    expect(custom.plugin.disposeCalls).toBe(1);
    expect(custom.scopes.size()).toBe(0);
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
      createAgent: async () => {
        throw new Error("模型没配端点");
      },
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
    const custom = createHarness({
      rounds: [
        {
          deltas: [{ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "delegate", arguments: "{}" } }] }],
          toolCalls: [{ id: "t1", name: "delegate" }],
          toolSubAgentUsage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          subAgent: {
            name: "helper",
            messages: [
              {
                id: "sub-1",
                role: AgentNSValue.Role.Assistant,
                status: AgentNSValue.MessageStatus.Completed,
                usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
              },
            ],
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
    expect(snapshot.messageCount).toBe(1);
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
            messages: [
              {
                id: "inner-u",
                role: AgentNSValue.Role.User,
                status: AgentNSValue.MessageStatus.Completed,
                content: "把方案说一下",
              },
              {
                id: "inner-a",
                role: AgentNSValue.Role.Assistant,
                status: AgentNSValue.MessageStatus.Completed,
                content: "方案是这样",
              },
            ],
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
    const subRows = custom.store.writes.filter((row) => row.parentToolCallId === "call-9");
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
      createAgent: () => new Promise<ChatAgent>((resolve) => (releaseBuild = resolve)),
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
          deltas: [{ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "delegate", arguments: "{}" } }] }],
          usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
          toolCalls: [{ id: "t1", name: "delegate" }],
          toolSubAgentUsage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 },
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

describe("真装配：交接线插件不替用户决定迁移（R59 / PRD §5）", () => {
  it("越过交接线也不自动迁移：装配时传的 resolveMode 一律回 null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-zen-sdk-factory-"));
    try {
      const agentsDir = join(dir, "agents");
      await mkdir(agentsDir, { recursive: true });
      await writeFile(
        join(agentsDir, "a1.json"),
        JSON.stringify({ id: "a1", name: "助手", modelId: "model-1", messages: [], custom: true }),
        "utf-8",
      );

      // 真 Scope：配置里那个模型配了交接线 100
      const scope = new Scope({
        cwd: dir,
        agentsDir,
        config: {
          endpoints: [{ id: "e1", name: "端点", baseUrl: "https://example.test/v1", apiKey: "k" }],
          models: [
            {
              id: "model-1",
              name: "模型",
              endpointId: "e1",
              tokenThresholds: { handoff: 100, guard: 200 },
            },
          ],
        },
      });

      const migrations: unknown[] = [];
      const handoff = {
        busy: false,
        migrate: async (input: unknown) => {
          migrations.push(input);
        },
      } as unknown as HandoffService;

      const factory = createSdkAgentFactory({ handoff: () => handoff });
      const agent = await factory({
        conversationId: CONVERSATION_ID,
        workspaceId: WORKSPACE_ID,
        agentId: "a1",
        modelId: "model-1",
        thinkingLevel: null,
        scope,
        history: [],
      });

      const plugins = (agent as unknown as { _plugins: unknown[] })._plugins;
      const autoMigrate = plugins.find((plugin) => plugin instanceof AutoMigratePlugin) as
        | AutoMigratePlugin
        | undefined;
      expect(autoMigrate).toBeDefined();

      // 用量已经远超交接线：插件仍然不问、也不迁移（问用户的是 QuestionService）
      await autoMigrate?.onAfterSend({
        agent: { lastUsage: { prompt_tokens: 9999, completion_tokens: 1, total_tokens: 10000 } },
      } as unknown as SendContext);
      expect(migrations).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
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
      const scopes = new ScopeRegistry({ createScope: async () => scope, clock });
      const runs = new RunRegistry({ clock });
      let idCursor = 0;
      const runner = new ChatRunner({
        messages,
        conversations,
        scopes,
        runs,
        createAgent: async () => new FakeAgent(plainRounds()),
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
      config: {
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
      },
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

/** 一个可脚本化的 agent：按脚本逐片吐出正文 */
class ScriptedAgent implements ChatAgent {
  messages: AgentNS.Message[] = [];
  readonly events = new RecordingEventBus();
  sendCalls = 0;

  constructor(private readonly script: Array<{ deltas?: string[] }>) {}

  append(message: AgentNS.Message): AgentNS.Message {
    this.messages.push(message);
    this.events.emit("message", message);
    return message;
  }

  abort(): void {
    for (const message of this.messages) {
      if (
        message.status === AgentNSValue.MessageStatus.Pending ||
        message.status === AgentNSValue.MessageStatus.Writing
      ) {
        message.status = AgentNSValue.MessageStatus.Aborted;
      }
    }
  }

  async send(content: AgentNS.MessageContent): Promise<AgentNS.Message[]> {
    const step = this.script[this.sendCalls] ?? this.script[this.script.length - 1];
    this.sendCalls += 1;
    this.append(Message.User(content));

    const receiver = this.append(Message.Assistant());
    receiver.status = AgentNSValue.MessageStatus.Writing;
    for (const text of step?.deltas ?? []) {
      const chunk = {
        choices: [{ delta: { content: text } }],
      } as unknown as Parameters<typeof applyChunk>[1];
      applyChunk(receiver, chunk);
      this.events.emit("chunk-parsed", receiver, chunk);
    }
    receiver.status = AgentNSValue.MessageStatus.Completed;
    return this.messages;
  }
}

/** 落库用的内容：素材段只有本地扩展字段（真实现是 `AssetService.prepareAttachments`） */
const STORED_CONTENT: LocalMessageContentSection[] = [
  { type: "text", text: "看看这张" },
  { type: "image_url", image_url: { url: "" }, __asset_id: "a1" },
];

describe("素材：落库只存 __asset_id", () => {
  it("用户消息落库用的是 storedContent，发给 agent 的是转换后的内容", async () => {
    const sent: AgentNS.MessageContent[] = [];
    const custom = createHarness({
      rounds: [],
      agentFactory: () => {
        const agent = new ScriptedAgent([{ deltas: ["好"] }]);
        const send = agent.send.bind(agent);
        agent.send = async (content: AgentNS.MessageContent) => {
          sent.push(content);
          return await send(content);
        };
        return agent;
      },
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

    // 发给模型的是厂商能吃的段
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
