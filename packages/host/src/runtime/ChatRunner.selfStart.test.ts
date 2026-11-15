/**
 * 取证：「自起的段」—— agent 被 `deliver()` 叫醒跑起来的那一段，宿主必须接住它。
 *
 * ## 这一段为什么需要取证
 *
 * agent 是常驻的、inbox 在 agent 里，所以 `agent.deliver(entry)` 在静止态会**把 agent 叫醒跑一段**
 * （core 的 `deliver()` → `flushInbox()` → `run()`）。但那一段没有 `conversation.send` 的受理：
 * 没有受理就没有 `TurnSession`，于是它既不落库、也不推 `run.state`、`conversation.abort` 还找不到
 * 它 —— 用户在界面上看到的是「agent 自己跑了一趟，一个字都没留下」。
 *
 * 本文件钉的就是「宿主把这个上下文接住了」这件事，五条语义各一个用例（见每个 `it` 的标题）。
 *
 * ## 为什么用真 core `Agent`
 *
 * 这一条的**全部难点都在时序上**：core 先广播 `status`（这一段开始了）、紧接着才把 inbox 落地成
 * User 消息（`message` 事件），宿主必须在第一拍就把现场建好并订上 `message`，第二拍才接得住那条
 * 消息。用假 agent 就测不到这件事 —— 假件的顺序是我们自己写的，红不了也绿不了。
 * 于是这里与 `ChatRunner.inbox.test.ts` 同一套做法：`AgentFactory` 返回真 `Agent`，其余（仓储、
 * 运行表、Scope、事件推送）全是宿主的真件，假件只用在模型那一侧。
 *
 * ## 确定性
 *
 * 模型流是脚本化的假流；两个卡点都是手动 resolve 的 `Deferred`：
 *   1. 工具的 `exec` —— 「工具正跑着的那一刻」因此是可精确到达的（中止用例靠它）；
 *   2. 没有第二处等待：结算走 `turn.done`，不 sleep、不赌定时器。
 */

import { describe, expect, it } from "vitest";
import type { AgentNS } from "@ai-zen/agents-core";
import { Agent, AgentNS as AgentNSValue, CallbackTool } from "@ai-zen/agents-core";

import type { Conversation } from "../storage/types.js";
import type { EventMap, EventName } from "../wire/events.js";
import type { RunState } from "../wire/states.js";
import type { AgentBuildContext, ChatAgent, TurnSettlement } from "./ChatRunner.js";
import { ChatRunner } from "./ChatRunner.js";
import { AgentRegistry } from "./AgentRegistry.js";
import { RunRegistry } from "./RunRegistry.js";
import { ScopeRegistry } from "./ScopeRegistry.js";
import {
  createFakeScope,
  deferred,
  ManualClock,
  RecordingMessageStore,
  type Deferred,
} from "./TestSupport.js";

const CONVERSATION_ID = "c-self-start";
const WORKSPACE_ID = "ws-1";

function makeConversation(): Conversation {
  return {
    id: CONVERSATION_ID,
    workspaceId: WORKSPACE_ID,
    name: "对话",
    agentId: "default",
    modelId: "model-1",
    thinkingLevel: null,
    pinned: false,
    nameIsAuto: true,
    createdAt: 0,
    updatedAt: 0,
  };
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

/** 只输出一段正文就停（不调工具） */
function textRound(text: string): AnyChunk[] {
  return [chunk({ content: text }), chunk({}, "stop")];
}

/** 一个会吐出一轮 `tool_calls` 的 chunk 序列 */
function toolCallRound(name: string, id = "call-1"): AnyChunk[] {
  return [
    chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "{}" } }] }),
    chunk({}, "tool_calls"),
  ];
}

/** core 的 `Agent` 要的那个 client 形状（只用到 `chat.completions.create`） */
type AgentClient = ConstructorParameters<typeof Agent>[0]["client"];

/** 按脚本吐流的假 client；`bodies` 是每一次请求体（`formatHistory` 之后的那一份） */
function createScriptedClient(rounds: AnyChunk[][]): {
  client: AgentClient;
  bodies: unknown[];
} {
  const bodies: unknown[] = [];
  const create = async (body: unknown) => {
    bodies.push(body);
    return makeStream(rounds[bodies.length - 1] ?? textRound("（脚本用完了）"));
  };
  return { client: { chat: { completions: { create } } } as unknown as AgentClient, bodies };
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
// 宿主侧脚手架（全部用宿主的真件，只有 `createAgent` 与模型流由用例接管）
// ---------------------------------------------------------------------------

interface Harness {
  runner: ChatRunner;
  registry: AgentRegistry;
  store: RecordingMessageStore;
  runs: RunRegistry;
  /** 宿主推出去的全部事件，按顺序 */
  events: Array<{ name: EventName; payload: EventMap[EventName] }>;
  /** `onError` 收到的东西（内部错误的去处） */
  errors: Array<{ error: unknown; context: string }>;
  /** core 广播的段边界（`status`），按发生顺序 */
  statuses: Array<{ from: AgentNS.RunStatus; to: AgentNS.RunStatus }>;
  pushed: <E extends EventName>(name: E) => Array<EventMap[E]>;
  runStates: () => RunState[];
}

function createHarness(options: {
  /** 造一个**真** core `Agent`：宿主管它叫 `ChatAgent`，其余一切照旧 */
  createAgent: (context: AgentBuildContext) => Promise<ChatAgent>;
}): Harness {
  const clock = new ManualClock();
  const store = new RecordingMessageStore();
  const conversation = makeConversation();
  const { scope } = createFakeScope("/tmp/ai-zen-self-start");
  const scopes = new ScopeRegistry({ createScope: async () => scope });
  const runs = new RunRegistry({ clock });
  const events: Harness["events"] = [];
  const errors: Harness["errors"] = [];
  const statuses: Harness["statuses"] = [];
  let idCursor = 0;

  // `chatRunner` 比 `agentRegistry` 后造：接线层（`app.ts`）也是这么接的 —— 闭包住一个可变引用，
  // 调用那一刻才去取
  let runner: ChatRunner | undefined;
  const registry = new AgentRegistry({
    scopes,
    runs,
    createAgent: async (context) => {
      const agent = await options.createAgent(context);
      // 与生产同一个口径：段边界从 core 的 `status` 事件来
      agent.events.on("status", (ctx: { from: AgentNS.RunStatus; to: AgentNS.RunStatus }) => {
        statuses.push({ from: ctx.from, to: ctx.to });
      });
      return agent;
    },
    onStatus: (event) => runner?.onAgentStatus(event),
  });

  runner = new ChatRunner({
    messages: store,
    conversations: {
      get: async (id: string) => (id === conversation.id ? conversation : undefined),
    },
    scopes,
    runs,
    agents: registry,
    emit: (name, payload) => {
      events.push({ name, payload });
    },
    clock,
    newId: () => `srv-${++idCursor}`,
    streamWriteIntervalMs: 0,
    onError: (error, context) => {
      errors.push({ error, context });
    },
  });

  const pushed = <E extends EventName>(name: E): Array<EventMap[E]> =>
    events.filter((event) => event.name === name).map((event) => event.payload as EventMap[E]);

  return {
    runner,
    registry,
    store,
    runs,
    events,
    errors,
    statuses,
    pushed,
    runStates: () => pushed("run.state").map((payload) => payload.run),
  };
}

/** 把 agent 装配起来并停在那儿（不经过 `conversation.send`）—— 与「上一段早已跑完」同一个状态 */
async function parkAgent(harness: Harness): Promise<ChatAgent> {
  return await harness.registry.ensure({
    conversationId: CONVERSATION_ID,
    workspaceId: WORKSPACE_ID,
    agentId: "default",
    modelId: "model-1",
    thinkingLevel: null,
    history: [],
  });
}

// ---------------------------------------------------------------------------
// ① 自起段落库：那条 user 消息的 id 就是投递时定死的那个
// ---------------------------------------------------------------------------

describe("自起的段：agent 被 `deliver()` 叫醒的那一段由宿主接住", () => {
  it("自起段落库：user 消息 id 就是投递时那个（带来源注释），assistant 正常完成，seq 连续", async () => {
    const { client } = createScriptedClient([textRound("第一句的回答"), textRound("收到，我来跟进。")]);
    const harness = createHarness({ createAgent: async () => new Agent({ client, model: "gpt-4" }) });

    // 先跑一段普通轮次：agent 因此装配好，跑完之后停在 idle（常驻）
    const first = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await first.done;
    const agent = harness.registry.get(CONVERSATION_ID);
    expect(agent).toBeDefined();

    // ---- 投递：agent 在静止态，core 把它叫醒跑一段（宿主从此没有受理过任何东西）----
    const receipt = agent!.deliver({
      content: "父会话那边有新进展",
      source: "会话「另一个」",
      priority: "high",
    });
    expect(receipt.woke).toBe(true);

    // 现场是**同步**建好的：`deliver` 返回时这一段已经在 `turns` 里（它紧接着就要广播那条消息）
    const live = harness.runner.turn(CONVERSATION_ID);
    expect(live).toBeDefined();
    const settlement: TurnSettlement = await live!.done;

    // ---- ① user 消息：id 就是投递时定的那个，内容是 core 落地的那份（带来源注释）----
    const userRow = harness.store.peek(receipt.messageId);
    expect(userRow).toBeDefined();
    expect(userRow!.role).toBe(AgentNSValue.Role.User);
    expect(userRow!.status).toBe(AgentNSValue.MessageStatus.Completed);
    const content = userRow!.content as string;
    expect(content).toContain("// 这条消息来自 会话「另一个」 自动推送");
    expect(content).toContain("父会话那边有新进展");

    // ---- ② assistant 消息：正常完成态，id 是宿主在首次见到占位时分配的那个 ----
    const assistantId = settlement.assistantMessageId;
    expect(typeof assistantId).toBe("string");
    const assistantRow = harness.store.peek(assistantId!);
    expect(assistantRow).toBeDefined();
    expect(assistantRow!.role).toBe(AgentNSValue.Role.Assistant);
    expect(assistantRow!.status).toBe(AgentNSValue.MessageStatus.Completed);
    expect(assistantRow!.content).toBe("收到，我来跟进。");
    // 宿主分配的 id（`newId` 是 `srv-N`），不是 core 自己生成的那个
    expect(assistantId).toMatch(/^srv-\d+$/);

    // ---- ③ seq 与既有消息连续，且顺序是「用户先、回答后」----
    const rows = await harness.store.listByConversation(CONVERSATION_ID);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    const order = rows.map((row) => row.id);
    expect(order.indexOf(receipt.messageId)).toBe(2);
    expect(order.indexOf(assistantId!)).toBe(3);
    // 那条 user 消息先写、回答后写：`seq` 按插入顺序给，反过来就成了「回答在提问之前」
    expect(order.indexOf(receipt.messageId)).toBeLessThan(order.indexOf(assistantId!));

    // ---- ④ 一段正常收尾 ----
    expect(settlement.outcome).toBe("completed");
    expect(settlement.problem).toBeNull();
    expect(harness.runs.isRunning(CONVERSATION_ID)).toBe(false);
  });

  it("自起段的事件次序：`status → running` 先于那条 user 消息的 `message` 广播", async () => {
    const { client } = createScriptedClient([textRound("收到。")]);
    const harness = createHarness({ createAgent: async () => new Agent({ client, model: "gpt-4" }) });
    const agent = await parkAgent(harness);

    const userEvents: string[] = [];
    const statusesBefore: string[] = [];
    agent.events.on("message", (message: AgentNS.Message) => {
      if (message.role === AgentNSValue.Role.User) userEvents.push(`message:${message.id}`);
    });
    agent.events.on("status", (ctx: { to: AgentNS.RunStatus }) => {
      statusesBefore.push(`status:${ctx.to}`);
    });

    const receipt = agent.deliver({ content: "投递一句", source: "会话「X」", priority: "high" });
    const live = harness.runner.turn(CONVERSATION_ID)!;
    await live.done;

    // 宿主能接住那条消息，全靠「宣告这一段开始了」排在「队列落地」之前：
    // 反过来的话，user 消息广播时还没有现场，它就永久没人认领（不落库、不进产出）
    expect(statusesBefore[0]).toBe("status:running");
    expect(userEvents).toEqual([`message:${receipt.messageId}`]);
  });

  // -------------------------------------------------------------------------
  // ② 自起段推 `run.state`
  // -------------------------------------------------------------------------
  it("自起段推 run.state：先 `running`（还没有助手 id），结算后 `settled`", async () => {
    const { client } = createScriptedClient([textRound("收到。")]);
    const harness = createHarness({ createAgent: async () => new Agent({ client, model: "gpt-4" }) });
    const agent = await parkAgent(harness);

    const before = harness.runStates().length;
    agent.deliver({ content: "投递一句", source: "会话「X」", priority: "high" });
    const live = harness.runner.turn(CONVERSATION_ID)!;
    const settlement = await live.done;

    const states = harness.runStates().slice(before);
    expect(states.length).toBeGreaterThan(1);
    // 起段那一刻：还没有预分配的助手 id（自起段没有占位行，id 是跑着才定的）
    expect(states[0]!.status).toBe("running");
    expect(states[0]!.assistantMessageId).toBeNull();
    // 结算：与普通轮次同形的一份快照
    const last = states[states.length - 1]!;
    expect(last.status).toBe("settled");
    expect(last.outcome).toBe("completed");
    expect(last.assistantMessageId).toBe(settlement.assistantMessageId);
    expect(last.settledAt).not.toBeNull();
    expect(last.inbox).toEqual([]);
  });

  it("自起段一条 assistant 都没出（开局就失败）：结算照常跑完，不卡住、不凭空补占位行", async () => {
    const { client } = createScriptedClient([textRound("不会被请求到")]);
    let coreAgent: Agent | undefined;
    const harness = createHarness({
      createAgent: async () => {
        const agent = new Agent({ client, model: "gpt-4" });
        // 段体一共就抛在第一条内循环之前：一条 assistant 占位也不会 append
        agent.use({ onInnerLoopsStart: () => "这一段不许跑" } as never);
        coreAgent = agent;
        return agent;
      },
    });
    const agent = await parkAgent(harness);

    const receipt = agent.deliver({ content: "投递一句", source: "会话「X」", priority: "high" });
    const live = harness.runner.turn(CONVERSATION_ID)!;
    // 关键：它 resolve（不卡住）—— 结算不靠「总得有一条 assistant」才走得完
    const settlement = await live.done;

    // 一段里没出过 assistant：就没有助手 id，也不该凭空补一条空回答
    expect(settlement.assistantMessageId).toBeNull();
    expect(settlement.produced.map((message) => message.id)).toEqual([receipt.messageId]);

    // 落库照常：只有投递那条 user 消息，没有凭空多出的 assistant 行
    const rows = await harness.store.listByConversation(CONVERSATION_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(receipt.messageId);
    expect(rows[0]!.role).toBe(AgentNSValue.Role.User);
    // 运行表、现场、段状态都收干净了（agent 仍常驻，只是回 idle）
    expect(harness.runs.isRunning(CONVERSATION_ID)).toBe(false);
    expect(harness.runner.turn(CONVERSATION_ID)).toBeUndefined();
    expect(coreAgent!.runStatus).toBe("idle");
    // 结算态照样推出去（“一段结束”这个事实不因“没出 assistant”而丢）——
    // 这里不断言 `outcome`：段体抛出去的那个错误走的是 core 的 `error` 事件，它比段尾
    // `status` 晚一拍，结算那一刻收到与否是一个时序细节（本单没改那一处，见回报）。
    const last = harness.runStates().at(-1)!;
    expect(last.status).toBe("settled");
    expect(last.assistantMessageId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // ③ 自起段可 abort
  // -------------------------------------------------------------------------

  it("自起段可 abort：`conversation.abort` 能找到这一段、把 agent 掐停，结算 outcome=aborted", async () => {
    const started = deferred<void>();
    const result = deferred<string>();
    const { client } = createScriptedClient([toolCallRound("read_file")]);
    // 段状态（`runStatus`）不在宿主的 `ChatAgent` 表面里（宿主不看它）：用例留住真 core `Agent`
    let coreAgent: Agent | undefined;
    const harness = createHarness({
      createAgent: async () => {
        const agent = new Agent({
          client,
          model: "gpt-4",
          tools: [gatedTool({ name: "read_file", started, result })],
        });
        coreAgent = agent;
        return agent;
      },
    });
    const agent = await parkAgent(harness);

    const receipt = agent.deliver({ content: "投递一句", source: "会话「X」", priority: "high" });
    const live = harness.runner.turn(CONVERSATION_ID)!;
    expect(live).toBeDefined();

    // 等它真的走到「工具正在跑」那一刻
    await started.promise;
    expect(live.runState().status).toBe("running");
    expect(live.runState().generation?.phase).toBe("awaiting_tools");

    // 用户按停：`conversation.abort` 走 `RunRegistry`，必须能找到这一段
    expect(harness.runner.abort(CONVERSATION_ID)).toBe(true);
    // core 那侧进「收尾中」：中止真的送到 agent 上了（不是只在宿主这侧记了一笔）
    expect(coreAgent!.runStatus).toBe("stopping");

    // 放行工具，让这一段自己收完尾（abort 不会替工具 reject）
    result.resolve("文件内容：hello");
    const settlement = await live.done;

    expect(settlement.outcome).toBe("aborted");
    expect(settlement.run.outcome).toBe("aborted");
    // 投递那条 user 消息照常在库里（它已经被说出来了），id 仍是投递时那个
    expect(harness.store.peek(receipt.messageId)).toBeDefined();
    // 在途的工具结果以中止态落库（D15）
    const rows = await harness.store.listByConversation(CONVERSATION_ID);
    const aborted = rows.filter((row) => row.status === AgentNSValue.MessageStatus.Aborted);
    expect(aborted.length).toBeGreaterThan(0);
    // 运行表收干净了
    expect(harness.runs.isRunning(CONVERSATION_ID)).toBe(false);
    expect(coreAgent!.runStatus).toBe("terminated");
  });

  // -------------------------------------------------------------------------
  // ④ 不重复建上下文（本单最重要的回归护栏）
  // -------------------------------------------------------------------------

  it("普通 `conversation.send` 那一段：`status → running` 不会再建第二个 TurnSession", async () => {
    const started = deferred<void>();
    const result = deferred<string>();
    const { client } = createScriptedClient([toolCallRound("read_file"), textRound("看完了。")]);
    const harness = createHarness({
      createAgent: async () =>
        new Agent({
          client,
          model: "gpt-4",
          tools: [gatedTool({ name: "read_file", started, result })],
        }),
    });

    const turn = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "看看这个文件" },
    });

    // 这一段在跑（`status → running` 早就过去了）：现场还是受理时那一个对象
    await started.promise;
    expect(harness.runner.turn(CONVERSATION_ID)).toBe(turn);
    // 也没有任何「自起段」的动静（`runs.start` 撞 busy / 补装配事实失败都会落到这里）
    expect(harness.errors.filter((error) => error.context.startsWith("self-run"))).toEqual([]);

    result.resolve("文件内容：hello");
    await turn.done;

    // 整轮推出去的每一份 run.state 都带着受理时那一对 id ——
    // 多出来的那个现场会推一份自己的（助手 id 为空），这条断言就会红
    const states = harness.runStates();
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state.assistantMessageId).toBe(turn.assistantMessageId);
    }
    // 这一轮结束之后现场照常摘掉（剩下的只有「没有现场」）
    expect(harness.runner.turn(CONVERSATION_ID)).toBeUndefined();
    expect(harness.runs.isRunning(CONVERSATION_ID)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // ⑤ 自起段结束后 agent 仍常驻，下一段还能继续
  // -------------------------------------------------------------------------

  it("自起段结束后 agent 仍常驻，下一段（普通发送）还能接着跑", async () => {
    const { client } = createScriptedClient([textRound("自起段的回答"), textRound("下一段的回答")]);
    const harness = createHarness({ createAgent: async () => new Agent({ client, model: "gpt-4" }) });
    const agent = await parkAgent(harness);

    agent.deliver({ content: "投递一句", source: "会话「X」", priority: "high" });
    const live = harness.runner.turn(CONVERSATION_ID)!;
    const firstSettlement = await live.done;
    expect(firstSettlement.outcome).toBe("completed");

    // agent 没有被 dispose：还是同一个对象、还在登记表里（配置没改过，没有换掉的理由）
    expect(harness.registry.get(CONVERSATION_ID)).toBe(agent);
    expect(harness.registry.conversationIds(WORKSPACE_ID)).toEqual([CONVERSATION_ID]);

    // 下一段照常受理：历史接着用同一个 agent 的内存真相（自起段那两条也在里面）
    const next = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "再来一句" },
    });
    const nextSettlement = await next.done;

    expect(nextSettlement.outcome).toBe("completed");
    expect(harness.registry.get(CONVERSATION_ID)).toBe(agent);
    // 四条消息按顺序排好：自起段的 user + assistant，这一段的 user + assistant
    const rows = await harness.store.listByConversation(CONVERSATION_ID);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(rows.map((row) => row.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
    ]);
    expect(rows[1]!.content).toBe("自起段的回答");
    expect(rows[3]!.content).toBe("下一段的回答");
  });
});
