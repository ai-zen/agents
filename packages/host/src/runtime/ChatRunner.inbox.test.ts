/**
 * 取证：**真 core `Agent` 跑在真 `ChatRunner` 里**，用户在跑中发消息（PRD D3）。
 *
 * ## 为什么单独一个文件
 *
 * 上游两处各有自己的用例，但都绕过了这条组合：
 *   - `packages/core/src/Agent.inbox.test.ts` 用的是真 Agent + 脚本化假流，**完全不经过宿主**；
 *   - `ChatRunner.test.ts` / `conversationHandlers.test.ts` 的 inbox 用例用的是
 *     `TestSupport.FakeAgent` —— 它按 core 的语义**自己实现了一遍**轮末插入。
 *
 * 两边都绿说明不了「真 core 的插入点 + 宿主认定领的 id / 落库 / `inboxPending` 串在一起」通。
 * 本文件只钉这一条：`AgentFactory` 返回真 `Agent`，其余（仓储、运行表、Scope、事件推送）
 * 全是宿主的真件，假件只用在模型那一侧。
 *
 * ## 为什么收尾边界也在这里
 *
 * 「回了 `queued` 就一定要落地」那段窗口（工单 J）跨越 core 的最后一个取件点与 `send()`
 * 返回之间的整段，宿主那侧的可入队区间正好压在它上面 —— 只有真 core + 真宿主这个组合才
 * 看得见。两条边界的用例在文件末尾（`onInnerLoopsEnd` / `onAfterSend`）。
 *
 * ## 确定性
 *
 * 模型流是脚本化的假流（形状照抄 `packages/core/src/Agent.test.ts` / `Agent.inbox.test.ts`
 * 的 `createRecordingClient`），两个卡点都是手动 resolve 的 `Deferred`：
 *   1. 工具的 `exec` —— 于是「工具正跑着的那一刻」是可精确到达的，不赌时间；
 *   2. `onInnerLoopsEnd` 钩子（用例自己在真 Agent 上装一个插件）—— 于是「收尾边界」也是。
 *
 * 不 sleep、不连网、不读环境变量。
 */

import { describe, expect, it } from "vitest";
import type { AgentNS } from "@ai-zen/agents-core";
import { Agent, AgentNS as AgentNSValue, CallbackTool } from "@ai-zen/agents-core";

import type { Conversation } from "../storage/types.js";
import type { EventMap, EventName } from "../wire/events.js";
import type { RunState } from "../wire/states.js";
import type {
  AgentBuildContext,
  ChatAgent,
  ChatRunnerOptions,
  QueuedTurn,
  TurnSettlement,
} from "./ChatRunner.js";
import { ChatRunner } from "./ChatRunner.js";
import { RunRegistry } from "./RunRegistry.js";
import { ScopeRegistry } from "./ScopeRegistry.js";
import {
  createFakeScope,
  deferred,
  ManualClock,
  RecordingMessageStore,
  type Deferred,
} from "./TestSupport.js";

const CONVERSATION_ID = "c-inbox";
const WORKSPACE_ID = "ws-1";

function makeConversation(): Conversation {
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
  };
}

// ---------------------------------------------------------------------------
// 事件时间线：core 广播的 `message` 与每一次模型请求，按发生顺序排成一条
// ---------------------------------------------------------------------------

/**
 * 时间线的一条。
 *
 * `message` 是 core 的 `message` 事件（快照当时的 `id` / `role` / `status`：宿主会就地改
 * 消息对象，事后读同一个对象看到的不是当时那一刻的样子）；`request` 是一次模型请求已经
 * 组好请求体（`formatHistory` 之后）—— 「第二轮开始了」以它为准。
 */
type TimelineEntry =
  | { kind: "message"; id: string; role: AgentNS.Role; status: AgentNS.MessageStatus | undefined }
  | { kind: "request" };

function watch(agent: Agent, timeline: TimelineEntry[]): void {
  agent.events.on("message", (message: AgentNS.Message) => {
    timeline.push({ kind: "message", id: message.id, role: message.role, status: message.status });
  });
}

/** 时间线里第一条满足条件的下标（没有就 -1） */
function indexOf(
  timeline: readonly TimelineEntry[],
  predicate: (entry: TimelineEntry) => boolean,
  from = 0,
): number {
  return timeline.findIndex((entry, index) => index >= from && predicate(entry));
}

/** 角色是 assistant 的那些 message 事件的下标（按发生顺序） */
function assistantEventIndexes(timeline: readonly TimelineEntry[]): number[] {
  const found: number[] = [];
  timeline.forEach((entry, index) => {
    if (entry.kind === "message" && entry.role === AgentNSValue.Role.Assistant) {
      found.push(index);
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// 脚本化的假流（形状与 core 用例里的那一份一致）
// ---------------------------------------------------------------------------

type AnyChunk = Record<string, unknown>;

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): AnyChunk {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function makeStream(chunks: AnyChunk[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of chunks) yield item;
    },
  };
}

/** 一个会吐出一轮 `tool_calls` 的 chunk 序列 */
function toolCallRound(name: string, id = "call-1"): AnyChunk[] {
  return [
    chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "{}" } }] }),
    chunk({}, "tool_calls"),
  ];
}

/** 只输出一段正文就停（不调工具） */
function textRound(text: string): AnyChunk[] {
  return [chunk({ content: text }), chunk({}, "stop")];
}

/** core 的 `Agent` 要的那个 client 形状（只用到 `chat.completions.create`） */
type AgentClient = ConstructorParameters<typeof Agent>[0]["client"];

interface ScriptedClient {
  client: AgentClient;
  /** 每一次请求体（`formatHistory` 之后的那一份，模型真正收到的就是它） */
  bodies: any[];
}

/**
 * 按脚本吐流的假 client，并把每次请求的时刻记进时间线。
 *
 * `Agent.inbox.test.ts` 的 `createRecordingClient` 就是这一份（只多了 `onRequest` 这一跳，
 * 用来把「第几轮请求」排进同一条时间线）。
 */
function createScriptedClient(
  rounds: AnyChunk[][],
  timeline: TimelineEntry[],
): ScriptedClient {
  const bodies: any[] = [];
  const create = async (body: unknown) => {
    bodies.push(body);
    timeline.push({ kind: "request" });
    return makeStream(rounds[bodies.length - 1] ?? textRound("（脚本用完了）"));
  };
  return {
    client: { chat: { completions: { create } } } as unknown as AgentClient,
    bodies,
  };
}

/** 一个由用例手动 resolve 的工具：`exec` 返回它，于是「工具正跑着」是可到达的一刻 */
function gatedTool(spec: {
  name: string;
  started: Deferred<void>;
  result: Deferred<string>;
}): CallbackTool {
  return new CallbackTool({
    function: {
      name: spec.name,
      description: "读一个文件（本用例里只挂起，由用例放行）",
      parameters: { type: "object", properties: {} },
    },
    callback: async () => {
      spec.started.resolve();
      return await spec.result.promise;
    },
  });
}

// ---------------------------------------------------------------------------
// 宿主侧脚手架（全部用宿主的真件，只有 `createAgent` 这一处由用例接管）
// ---------------------------------------------------------------------------

interface Harness {
  runner: ChatRunner;
  store: RecordingMessageStore;
  runs: RunRegistry;
  clock: ManualClock;
  timeline: TimelineEntry[];
  /** 宿主推出去的全部事件，按顺序 */
  events: Array<{ name: EventName; payload: EventMap[EventName] }>;
  /** `onError` 收到的东西（内部错误的去处） */
  errors: Array<{ error: unknown; context: string }>;
  pushed: <E extends EventName>(name: E) => Array<EventMap[E]>;
  runStates: () => RunState[];
}

function createHarness(options: {
  /** 造一个**真** core `Agent`：宿主管它叫 `ChatAgent`，其余一切照旧 */
  createAgent: (context: AgentBuildContext) => Promise<ChatAgent>;
  timeline: TimelineEntry[];
}): Harness {
  const clock = new ManualClock();
  const store = new RecordingMessageStore();
  const conversation = makeConversation();
  const { scope } = createFakeScope("/tmp/ai-zen-inbox");
  const scopes = new ScopeRegistry({ createScope: async () => scope, clock });
  const runs = new RunRegistry({ clock });
  const events: Harness["events"] = [];
  const errors: Harness["errors"] = [];
  let idCursor = 0;

  const onError: NonNullable<ChatRunnerOptions["onError"]> = (error, context) => {
    errors.push({ error, context });
  };

  const runner = new ChatRunner({
    messages: store,
    conversations: {
      get: async (id: string) => (id === conversation.id ? conversation : undefined),
    },
    scopes,
    runs,
    createAgent: options.createAgent,
    emit: (name, payload) => {
      events.push({ name, payload });
    },
    clock,
    newId: () => `srv-${++idCursor}`,
    streamWriteIntervalMs: 0,
    onError,
  });

  const pushed = <E extends EventName>(name: E): Array<EventMap[E]> =>
    events.filter((event) => event.name === name).map((event) => event.payload as EventMap[E]);

  return {
    runner,
    store,
    runs,
    clock,
    timeline: options.timeline,
    events,
    errors,
    pushed,
    runStates: () => pushed("run.state").map((payload) => payload.run),
  };
}

// ---------------------------------------------------------------------------
// 主链路：跑中入队 → 工具轮收尾时落地 → 第二轮请求里带着它
// ---------------------------------------------------------------------------

describe("真 core Agent 跑在真 ChatRunner 里：跑中发送进 inbox（D3）", () => {
  it("工具正跑着时 enqueue → 工具轮后落地 → 第二轮请求里带着它，且第一轮没被 abort", async () => {
    const timeline: TimelineEntry[] = [];
    let coreAgent: Agent | undefined;
    const started = deferred<void>();
    const result = deferred<string>();
    const { client, bodies } = createScriptedClient(
      [toolCallRound("read_file"), textRound("看完了，顺手也看了你说的那件事。")],
      timeline,
    );

    const harness = createHarness({
      timeline,
      createAgent: async () => {
        const agent = new Agent({
          client,
          model: "gpt-4",
          tools: [gatedTool({ name: "read_file", started, result })],
        });
        watch(agent, timeline);
        coreAgent = agent;
        return agent;
      },
    });

    const turn = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看这个文件" },
    });

    // 等这一轮真的走到「工具正在跑」那一刻（exec 已经进来了，还没返回）
    await started.promise;
    expect(turn.runState().generation?.phase).toBe("awaiting_tools");
    const firstRoundAssistant = turn.runState().assistantMessageId;

    // ---- 用户在这一刻发第二句：入的是**这一轮**的 inbox ----
    const queued = await harness.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "顺便看下这个" },
    });

    // 回包是排队语义（不是 busy、不是新的一轮）：只有 userMessageId，没有 assistantMessageId
    expect(queued).not.toBeNull();
    expect(queued!.conversationId).toBe(CONVERSATION_ID);
    expect(queued!.userMessageId.length).toBeGreaterThan(0);
    expect(queued!.attachments).toEqual([]);
    expect(Object.keys(queued!).sort()).toEqual([
      "acceptedAt",
      "attachments",
      "conversationId",
      "userMessageId",
    ]);

    // 条目进的是真 core Agent 的 inbox：高优先（工具轮收尾的边界）、来源是用户本人、id 就是回包那个
    expect(turn.runState().inboxPending).toBe(1);
    expect(coreAgent!.inbox).toHaveLength(1);
    expect(coreAgent!.inbox[0]!.messageId).toBe(queued!.userMessageId);
    expect(coreAgent!.inbox[0]!.priority).toBe("high");
    expect(coreAgent!.inbox[0]!.source).toBe("user");
    expect(coreAgent!.inbox[0]!.content).toBe("顺便看下这个");

    // 放行工具，让这一轮自己跑完
    result.resolve("文件内容：hello");
    const settlement = await turn.done;

    // ---- ① id 口径一致：入队时那个 id = 落地消息 = message 事件 = 库里那行 ----
    const landed = settlement.messages.find((message) => message.id === queued!.userMessageId);
    expect(landed).toBeDefined();
    expect(landed!.role).toBe(AgentNSValue.Role.User);
    expect(landed!.content).toBe("顺便看下这个");

    const landedEvents = timeline.filter(
      (entry) => entry.kind === "message" && entry.id === queued!.userMessageId,
    );
    expect(landedEvents).toHaveLength(1);
    expect((landedEvents[0] as { role: AgentNS.Role }).role).toBe(AgentNSValue.Role.User);

    const row = harness.store.peek(queued!.userMessageId);
    expect(row).toBeDefined();
    expect(row!.role).toBe(AgentNSValue.Role.User);
    expect(row!.content).toBe("顺便看下这个");

    // ---- ② 第二轮请求里带着它，且排在工具结果之后 ----
    expect(bodies).toHaveLength(2);
    const first = bodies[0].messages as Array<{ role: string; content: unknown }>;
    expect(first.some((message) => message.content === "顺便看下这个")).toBe(false);

    const second = bodies[1].messages as Array<{ role: string; content: unknown }>;
    const toolIndex = second.findIndex((message) => message.role === AgentNSValue.Role.Tool);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    const queuedIndex = second.findIndex((message) => message.content === "顺便看下这个");
    expect(queuedIndex).toBeGreaterThan(toolIndex);
    expect(second[queuedIndex]!.role).toBe(AgentNSValue.Role.User);

    // ---- ③ inboxPending：入队后 1、落地后 0（看宿主推出来的 run.state，不只信快照）----
    const states = harness.runStates();
    const pendingAt = states.findIndex(
      (run) => run.status === "running" && run.inboxPending === 1,
    );
    expect(pendingAt).toBeGreaterThanOrEqual(0);
    const drainedAt = states.findIndex(
      (run, index) => index > pendingAt && run.status === "running" && run.inboxPending === 0,
    );
    expect(drainedAt).toBeGreaterThan(pendingAt);
    expect(settlement.run.inboxPending).toBe(0);

    // ---- ④ 第一轮没有被 abort：工具结果完成、两条助手消息都完成、整轮 completed ----
    expect(settlement.outcome).toBe("completed");
    expect(settlement.run.outcome).toBe("completed");
    expect(settlement.problem).toBeNull();

    const toolResults = settlement.messages.filter(
      (message) => message.role === AgentNSValue.Role.Tool,
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.status).toBe(AgentNSValue.MessageStatus.Completed);
    expect(toolResults[0]!.content).toBe("文件内容：hello");

    const assistants = settlement.messages.filter(
      (message) => message.role === AgentNSValue.Role.Assistant,
    );
    expect(assistants).toHaveLength(2);
    for (const message of assistants) {
      expect(message.status).toBe(AgentNSValue.MessageStatus.Completed);
    }
    // 第一轮那条（带 tool_calls 的）也在里面，且不是中止；宿主把 core 的占位认领成了
    // 它自己发给客户端的那个 id
    expect(assistants[0]!.id).toBe(firstRoundAssistant);
    const withToolCalls = assistants.filter((message) => message.tool_calls?.length);
    expect(withToolCalls).toHaveLength(1);
    expect(settlement.messages.some((m) => m.status === AgentNSValue.MessageStatus.Aborted)).toBe(
      false,
    );
    // 宿主没有把这一轮当成「被叫停」：运行表里它也收干净了
    expect(harness.runs.isRunning(CONVERSATION_ID)).toBe(false);

    // ---- ⑤ 事件顺序：工具结果（已定型）→ 那条用户消息 → 第二轮的 assistant ----
    const toolSettledAt = indexOf(
      timeline,
      (entry) =>
        entry.kind === "message" &&
        entry.role === AgentNSValue.Role.Tool &&
        entry.status === AgentNSValue.MessageStatus.Completed,
    );
    const queuedAt = indexOf(
      timeline,
      (entry) => entry.kind === "message" && entry.id === queued!.userMessageId,
    );
    // 两轮各一个 assistant 占位（时间线上的 id 是 core 自己生成的：宿主的认领发生在
    // 事件发出之后），所以「第二轮的 assistant」就是第二个
    const assistantAt = assistantEventIndexes(timeline);
    expect(assistantAt).toHaveLength(2);
    const secondAssistantAt = assistantAt[1]!;
    expect(toolSettledAt).toBeGreaterThanOrEqual(0);
    expect(queuedAt).toBeGreaterThan(toolSettledAt);
    expect(secondAssistantAt).toBeGreaterThan(queuedAt);
    // 第二轮的 assistant 占位之后才是第二轮的请求
    expect(indexOf(timeline, (entry) => entry.kind === "request", secondAssistantAt)).toBeGreaterThan(
      secondAssistantAt,
    );
  });

  // -------------------------------------------------------------------------
  // 落库时机：排队那条必须在**落地那一刻**就写，不能等到收尾
  //
  // 真机上量出来的顺序错位：`seq` 是 `MAX(seq)+1` 按插入顺序给的，助手消息边流边写先落，
  // 排队那句若等到 `persistFinal` 才第一次写，就排到了它引出的回答后面 —— 重开对话读到的
  // 转录成了「助手说完 → 助手又说 → 用户冒最后一句」。
  // -------------------------------------------------------------------------

  it("排队落地那一刻就写库：库里它的 seq 排在它引出的那条回答之前", async () => {
    const timeline: TimelineEntry[] = [];
    const started = deferred<void>();
    const result = deferred<string>();
    const { client } = createScriptedClient(
      [toolCallRound("read_file"), textRound("看到了，顺手回了你那句。")],
      timeline,
    );

    const harness = createHarness({
      timeline,
      createAgent: async () => {
        const agent = new Agent({
          client,
          model: "gpt-4",
          tools: [gatedTool({ name: "read_file", started, result })],
        });
        watch(agent, timeline);
        return agent;
      },
    });

    const turn = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看这个文件" },
    });
    await started.promise;

    const queued = await harness.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content: "跑着的时候插一句" },
    });
    expect(queued).not.toBeNull();
    // 还在 inbox 里排着 = 还不是一条消息：库里此刻当然不该有它
    expect(harness.store.peek(queued!.userMessageId)).toBeUndefined();

    // 推进时钟，让「受理时刻」与「落地时刻」是两个可分辨的值（createdAt 断言靠它）
    const acceptedAtMs = Date.parse(queued!.acceptedAt);
    harness.clock.advance(5_000);

    result.resolve("文件内容：hello");
    const settlement = await turn.done;

    // 它引出的那条回答 = 第二轮（工具轮之后）那条助手消息
    const assistants = settlement.produced.filter(
      (message) => message.role === AgentNSValue.Role.Assistant,
    );
    expect(assistants).toHaveLength(2);
    const reply = assistants[1]!;

    // ① 写入顺序：排队那条的**第一笔写入**在回答的第一笔之前（`writes` 就是 upsert 的先后）
    const firstWriteAt = (id: string): number =>
      harness.store.writes.findIndex((row) => row.id === id);
    expect(firstWriteAt(queued!.userMessageId)).toBeGreaterThanOrEqual(0);
    expect(firstWriteAt(reply.id)).toBeGreaterThan(firstWriteAt(queued!.userMessageId));

    // ② 最终 seq 顺序：`RecordingMessageStore` 的 seq 取「这条消息第一次写入的先后」，与真仓储
    //    的 `MAX(seq)+1` 按插入顺序给是同一个口径 —— 所以读回来的这段转录就是库里的顺序
    const page = await harness.store.listByConversation(CONVERSATION_ID);
    const seqOf = (id: string): number | undefined =>
      page.find((row) => row.id === id)?.seq;
    expect(seqOf(queued!.userMessageId)).toBeDefined();
    expect(seqOf(reply.id)).toBeDefined();
    expect(seqOf(queued!.userMessageId)!).toBeLessThan(seqOf(reply.id)!);
    // 读者看到的是「用户插一句 → 助手回它」，中间不夹别的（这句排在自己回答的紧前面）
    const ids = page.map((row) => row.id);
    expect(ids.indexOf(queued!.userMessageId) + 1).toBe(ids.indexOf(reply.id));

    // ③ 幂等：落地写一笔、收尾再覆盖一笔，库里仍然只有一行（没有第二条、seq 也没被改掉）
    expect(harness.store.historyOf(queued!.userMessageId)).toHaveLength(2);
    expect(page.filter((row) => row.id === queued!.userMessageId)).toHaveLength(1);
    expect(harness.store.peek(queued!.userMessageId)?.role).toBe(AgentNSValue.Role.User);

    // ④ createdAt 取落地那一刻（不是受理那一刻，也不是收尾那一刻）
    expect(harness.store.peek(queued!.userMessageId)?.createdAt).toBe(acceptedAtMs + 5_000);
    expect(harness.store.peek(queued!.userMessageId)?.createdAt).not.toBe(acceptedAtMs);
  });

  // -------------------------------------------------------------------------
  // 收尾边界：回「排队了」就必须落地（core 的最后一个取件点排在整组收尾钩子之后）
  //
  // 两处边界各一条用例：`onInnerLoopsEnd`（整组收尾钩子）与 `onAfterSend`（send 的收尾
  // 钩子）。现实里这两跳是**无界**的（SDK 的 `AutoMigratePlugin` 就在 `onInnerLoopsEnd`
  // 里问用户），所以「宿主回了 queued、这一轮却再也不取」这个窗口必须由 core 兜住。
  // -------------------------------------------------------------------------

  /**
   * 「回了排队，就一定落地」的口径 —— 两条收尾边界用例共用。
   *
   * 五件事，缺一条都算这句凭空消失：
   *   ① `message` 事件与 `settlement.messages` 里有它，id 与回包一致（客户端按 id 覆盖）；
   *   ② 库里有这一行（重开对话看到的就是它）；
   *   ③ 它进了**下一次**请求（不是躺在 `messages` 里没人看见）；
   *   ④ 排队数归零，且不再有 `inbox-leftover` 那条内部错误；
   *   ⑤ 这一轮本身照常收工（边界上的一条没有把它变成失败，也没有被当成 abort）。
   */
  function expectQueuedLanded(input: {
    harness: Harness;
    /** core 的 agent（收工后宿主会丢掉它，所以要传取值函数） */
    coreAgent: () => Agent | undefined;
    queued: QueuedTurn;
    settlement: TurnSettlement;
    /** 每一次模型请求的请求体 */
    bodies: any[];
    /** 那条排队内容的正文 */
    content: string;
  }): void {
    const { harness, queued, settlement, bodies, content } = input;

    // ① 落地成消息：事件一次、结算快照里有它、id 与回包一致
    const landedEvents = harness.timeline.filter(
      (entry) => entry.kind === "message" && entry.id === queued.userMessageId,
    );
    expect(landedEvents).toHaveLength(1);
    expect((landedEvents[0] as { role: AgentNS.Role }).role).toBe(AgentNSValue.Role.User);

    const landed = settlement.messages.find((message) => message.id === queued.userMessageId);
    expect(landed).toBeDefined();
    expect(landed!.role).toBe(AgentNSValue.Role.User);
    expect(landed!.content).toBe(content);

    // ② 库里也有这一行
    const row = harness.store.peek(queued.userMessageId);
    expect(row).toBeDefined();
    expect(row!.role).toBe(AgentNSValue.Role.User);
    expect(row!.content).toBe(content);

    // ③ 进了第二次请求：第一次请求里还没有它
    expect(bodies).toHaveLength(2);
    expect(
      (bodies[0].messages as Array<{ content: unknown }>).some(
        (message) => message.content === content,
      ),
    ).toBe(false);
    const second = bodies[1].messages as Array<{ role: string; content: unknown }>;
    const landedAt = second.findIndex((message) => message.content === content);
    expect(landedAt).toBeGreaterThanOrEqual(0);
    expect(second[landedAt]!.role).toBe(AgentNSValue.Role.User);

    // ④ 排队数：入队后 1、落地后 0（看宿主推出来的 run.state，不只信快照）
    const states = harness.runStates();
    const pendingAt = states.findIndex(
      (run) => run.status === "running" && run.inboxPending === 1,
    );
    expect(pendingAt).toBeGreaterThanOrEqual(0);
    const drainedAt = states.findIndex(
      (run, index) => index > pendingAt && run.status === "running" && run.inboxPending === 0,
    );
    expect(drainedAt).toBeGreaterThan(pendingAt);
    expect(settlement.run.inboxPending).toBe(0);
    // core 那一侧也真的取空了（不是「宿主当没看见」）
    expect(input.coreAgent()!.inbox).toHaveLength(0);
    // 兜底日志不该再响：它响说明还有条目落在最后一个取件点之后
    expect(harness.errors.filter((error) => error.context === "inbox-leftover")).toHaveLength(0);

    // ⑤ 这一轮照常收工
    expect(settlement.outcome).toBe("completed");
    expect(settlement.run.outcome).toBe("completed");
    expect(settlement.problem).toBeNull();
    expect(harness.runs.isRunning(CONVERSATION_ID)).toBe(false);
    const assistants = settlement.messages.filter(
      (message) => message.role === AgentNSValue.Role.Assistant,
    );
    expect(assistants).toHaveLength(2);
    for (const message of assistants) {
      expect(message.status).toBe(AgentNSValue.MessageStatus.Completed);
    }
  }

  it("收尾边界（onInnerLoopsEnd 里）入队：回了排队，那条就一定在这一轮里落地", async () => {
    const timeline: TimelineEntry[] = [];
    let coreAgent: Agent | undefined;
    const insideWindow = deferred<void>();
    const releaseWindow = deferred<void>();
    const content = "边界上来的这一句";
    const { client, bodies } = createScriptedClient(
      [textRound("就这一轮"), textRound("边界上来的那句也回了")],
      timeline,
    );

    const harness = createHarness({
      timeline,
      createAgent: async () => {
        const agent = new Agent({ client, model: "gpt-4" });
        watch(agent, timeline);
        coreAgent = agent;
        // 用例自己在真 Agent 上装一个插件：把「整组收尾」那一刻卡住（core 会
        // `await dispatchHook("onInnerLoopsEnd")`），于是边界是可到达、可停留的一刻 ——
        // 现实里这一段是**无界**的（`AutoMigratePlugin` 在这里问用户）。
        agent.use({
          onInnerLoopsEnd: async () => {
            insideWindow.resolve();
            await releaseWindow.promise;
          },
        });
        return agent;
      },
    });

    const turn = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });

    // 停在这一刻：内循环已停、reconcile* 已收尾，正卡在整组收尾钩子里
    await insideWindow.promise;

    const queued = await harness.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content },
    });

    // 宿主此刻还没关门（`closeEnqueue` 在 `send()` 返回之后），所以它回的是「排队了」——
    // 这句话既然说出去了，下面就必须兑现。
    expect(queued).not.toBeNull();
    expect(turn.runState().inboxPending).toBe(1);

    releaseWindow.resolve();
    const settlement = await turn.done;

    expectQueuedLanded({ harness, coreAgent: () => coreAgent, queued: queued!, settlement, bodies, content });
  });

  it("收尾边界（onAfterSend 里）入队：同样在这一轮里落地", async () => {
    const timeline: TimelineEntry[] = [];
    let coreAgent: Agent | undefined;
    const insideWindow = deferred<void>();
    const releaseWindow = deferred<void>();
    const content = "收尾钩子里上来的这一句";
    const { client, bodies } = createScriptedClient(
      [textRound("就这一轮"), textRound("收尾钩子里那句也回了")],
      timeline,
    );

    const harness = createHarness({
      timeline,
      createAgent: async () => {
        const agent = new Agent({ client, model: "gpt-4" });
        watch(agent, timeline);
        coreAgent = agent;
        // 另一处收尾边界：`send()` 的 `onAfterSend`（迁移 / 保存插件在这里做后处理，
        // 也可能顺手把用户的话排进来）。
        agent.use({
          onAfterSend: async () => {
            insideWindow.resolve();
            await releaseWindow.promise;
          },
        });
        return agent;
      },
    });

    const turn = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });

    // 停在这一刻：整组内循环已经跑完（`onInnerLoopsEnd` 也发过了），正卡在 `onAfterSend`
    await insideWindow.promise;

    const queued = await harness.runner.enqueue({
      conversationId: CONVERSATION_ID,
      input: { content },
    });
    expect(queued).not.toBeNull();
    expect(turn.runState().inboxPending).toBe(1);

    releaseWindow.resolve();
    const settlement = await turn.done;

    expectQueuedLanded({ harness, coreAgent: () => coreAgent, queued: queued!, settlement, bodies, content });
  });
});
