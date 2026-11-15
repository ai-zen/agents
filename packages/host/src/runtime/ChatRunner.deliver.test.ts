/**
 * 会话间投递的**唯一入口**：`ChatRunner.deliver(conversationId, { content, source })`。
 *
 * ## 它要自己解决的三件事（本文件逐条取证）
 *
 * 1. **agent 不在就复活**：显式 `agents.discard` 之后投递，还是能按库里的历史重新装配出来再跑，
 *    `seq` 连续、历史完整；
 * 2. **跑着 / 正在结算都投得进去**：跑着就交给那一段（不新起一段），正在结算（落后窗口：core 已
 *    `idle`、`turns` 里还有现场）就攒着，等这一段结算完一起投；
 * 3. **攒够了一起投**：连续投 3 条（中间不让出事件循环）→ 同一次内循环边界落成 3 条 user 消息、
 *    只起一段、只有一次模型请求。
 *
 * ## 为什么用真 core `Agent`
 *
 * 这几条的难点全在 core 的时序里：`status(running)` 先于 inbox 落地、`flushInbox` 在段体之前、
 * 取件点在内循环末。假 agent 演不出来（它的顺序是我们自己写的，红不了也绿不了）。于是与
 * `ChatRunner.selfStart.test.ts` 同一套做法：`AgentFactory` 返回真 `Agent`，其余（仓储、运行表、
 * Scope、事件推送、`AgentRegistry`）全是宿主的真件，假件只用在模型那一侧。
 *
 * 不 sleep、不连网：卡点都是手动 resolve 的 `Deferred`。
 */

import { describe, expect, it } from "vitest";
import { Agent, AgentNS as AgentNSValue } from "@ai-zen/agents-core";

import type { Conversation } from "../storage/types.js";
import type { RunState } from "../wire/states.js";
import type { AgentBuildContext, ChatAgent, TurnSettledFacts } from "./ChatRunner.js";
import { ChatRunner } from "./ChatRunner.js";
import { AgentRegistry } from "./AgentRegistry.js";
import { RunRegistry } from "./RunRegistry.js";
import { ScopeRegistry } from "./ScopeRegistry.js";
import {
  createFakeScope,
  deferred,
  flushMicrotasks,
  ManualClock,
  RecordingMessageStore,
  type Deferred,
} from "./TestSupport.js";

const CONVERSATION_ID = "c-deliver";
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
    pinned: false,
    nameIsAuto: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

// ---------------------------------------------------------------------------
// 脚本化的假流（形状与 `ChatRunner.selfStart.test.ts` 那一份一致）
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

type AgentClient = ConstructorParameters<typeof Agent>[0]["client"];

/**
 * 按脚本吐流的假 client；`bodies` 是每一次请求体（`formatHistory` 之后的那一份）。
 *
 * `gate` 给了就每次请求都先停在它上面：那是「这一段正跑着」的可精确到达的一刻。
 */
function createScriptedClient(rounds: AnyChunk[][], gate?: Deferred<void>): {
  client: AgentClient;
  bodies: Array<{ messages: Array<{ role: string; content: unknown }> }>;
} {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const create = async (body: { messages: Array<{ role: string; content: unknown }> }) => {
    bodies.push(body);
    if (gate) await gate.promise;
    return makeStream(rounds[bodies.length - 1] ?? textRound("（脚本用完了）"));
  };
  return { client: { chat: { completions: { create } } } as unknown as AgentClient, bodies };
}

// ---------------------------------------------------------------------------
// 宿主侧脚手架（全部用宿主的真件，只有 `createAgent` 与模型流由用例接管）
// ---------------------------------------------------------------------------

interface Harness {
  runner: ChatRunner;
  registry: AgentRegistry;
  store: RecordingMessageStore;
  runs: RunRegistry;
  /** 每一次 `prepareHistory`（`resolveHistory`）被调时的消息条数 */
  historyResolutions: number[];
  runStates(): RunState[];
  settledFacts: TurnSettledFacts[];
  /** 把后台的投递 / 结算推进到「没有立即的后续」为止 */
  idle(): Promise<void>;
  waitFor(check: () => boolean): Promise<void>;
}

function createHarness(options: {
  createAgent: (context: AgentBuildContext) => Promise<ChatAgent>;
  /**
   * 一轮结算时的一刻（`settle` 里、`runs.finish` 之后、现场摘掉之前）。
   *
   * 「落后窗口」就住在这里：core 已经 `idle`、宿主 `turns` 里还有现场。用的例在这一刻投递。
   */
  onTurnSettled?: (facts: TurnSettledFacts, runner: ChatRunner) => void;
}): Harness {
  const clock = new ManualClock();
  const store = new RecordingMessageStore();
  const conversation = makeConversation();
  const { scope } = createFakeScope("/tmp/ai-zen-deliver");
  const scopes = new ScopeRegistry({ createScope: async () => scope });
  const runs = new RunRegistry({ clock });
  const historyResolutions: number[] = [];
  const settledFacts: TurnSettledFacts[] = [];
  const states: RunState[] = [];
  let idCursor = 0;

  // `chatRunner` 比 `agentRegistry` 后造（`app.ts` 也是这么接的）
  let runner: ChatRunner | undefined;
  const registry = new AgentRegistry({
    scopes,
    runs,
    createAgent: async (context) => await options.createAgent(context),
    onStatus: (event) => runner?.onAgentStatus(event),
    // 与 `app.ts` 同一条接线：入队那一刻的来源就是自起段结算时报的那一个
    onInbox: (event) => runner?.noteInbox(event.conversationId, event.entry.source),
  });

  runner = new ChatRunner({
    messages: store,
    conversations: { get: async (id: string) => (id === conversation.id ? conversation : undefined) },
    scopes,
    runs,
    agents: registry,
    emit: (name, payload) => {
      if (name === "run.state") states.push((payload as { run: RunState }).run);
    },
    clock,
    newId: () => `srv-${(idCursor += 1)}`,
    streamWriteIntervalMs: 0,
    // 历史还原跑没跑过，是「复活」那条用例要看的（生产里它把 `__asset_id` 换成当前模型能吃的段）
    prepareHistory: async ({ messages }) => {
      historyResolutions.push(messages.length);
      return messages;
    },
    onTurnSettled: (facts) => {
      settledFacts.push(facts);
      options.onTurnSettled?.(facts, runner!);
    },
  });

  const harness: Harness = {
    runner,
    registry,
    store,
    runs,
    historyResolutions,
    settledFacts,
    runStates: () => states,
    idle: async () => {
      for (let i = 0; i < 12; i += 1) await flushMicrotasks();
    },
    async waitFor(check) {
      for (let i = 0; i < 80; i += 1) {
        if (check()) return;
        await flushMicrotasks();
      }
      throw new Error("condition not reached");
    },
  };
  return harness;
}

/** 把 agent 装配起来并停在那儿（不经过 `conversation.send`）—— 与「上一段早已跑完」同一个状态 */
async function parkAgent(harness: Harness): Promise<ChatAgent> {
  // 会话行上的三项事实既是装配入参，也是 `acquire` 判「合不合用」的据
  const conversation = makeConversation();
  return await harness.registry.acquire(
    {
      conversationId: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      agentId: conversation.agentId,
      modelId: conversation.modelId,
      thinkingLevel: conversation.thinkingLevel,
      history: [],
    },
    conversation,
  );
}

/** 库里这段对话的主线行（`seq` 由存储层按插入顺序给） */
async function rowsOf(harness: Harness): Promise<
  Array<{ id: string; seq: number; role: string; content: unknown }>
> {
  const rows = await harness.store.listByConversation(CONVERSATION_ID);
  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    role: row.role,
    content: row.content,
  }));
}

// ---------------------------------------------------------------------------
// ① 父对话空闲：一次 `deliver` → 起一段、落库、run.state running/settled
// ---------------------------------------------------------------------------

describe("ChatRunner.deliver：会话间投递的唯一入口", () => {
  it("父对话空闲 → 起一段真 turn：落库、`run.state` 从 running 到 settled、正文带来源注释", async () => {
    const { client } = createScriptedClient([textRound("收到，我接着干。")]);
    const harness = createHarness({ createAgent: async () => new Agent({ client, model: "gpt-4" }) });
    const agent = await parkAgent(harness);

    const before = harness.runStates().length;
    await harness.runner.deliver(CONVERSATION_ID, {
      content: "登录页的测试补齐了",
      source: "补测试",
    });

    // 现场在投递那一拍就建好了（自起段：`status(running)` → `startSelfRun`）
    const live = harness.runner.turn(CONVERSATION_ID);
    expect(live).toBeDefined();
    const settlement = await live!.done;

    // ---- 落库：一条 user（正文最前面是 core 拼的来源注释）+ 一条 assistant ----
    const rows = await rowsOf(harness);
    expect(rows.map((row) => row.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    const content = rows[0]!.content as string;
    expect(content.split("\n\n")[0]).toMatch(/^\/\/ 这条消息来自 补测试 自动推送（.+）$/);
    expect(content.split("\n\n")[1]).toBe("登录页的测试补齐了");
    expect(rows[1]!.content).toBe("收到，我接着干。");
    expect(settlement.outcome).toBe("completed");

    // ---- run.state：先 running（自起段还没有助手 id），结算后 settled ----
    const states = harness.runStates().slice(before);
    expect(states.length).toBeGreaterThan(1);
    expect(states[0]!.status).toBe("running");
    expect(states[0]!.assistantMessageId).toBeNull();
    const last = states[states.length - 1]!;
    expect(last.status).toBe("settled");
    expect(last.assistantMessageId).toBe(settlement.assistantMessageId);

    // 这一段不是用户本人叫起来的：结算报的 `source` 就是叫醒它的那条条目的来源
    // （`"补测试"`）—— 不是笼统的 `"inbox"`，交接线那条判断也就看得见「谁叫的」
    expect(harness.settledFacts.map((facts) => facts.source)).toEqual(["补测试"]);
    // agent 常驻：投递叫起来的那一段跑完，它还在登记表里
    expect(harness.registry.get(CONVERSATION_ID)).toBe(agent);
  });

  // -------------------------------------------------------------------------
  // ② 父对话正在跑：不新起一段，条目在那一段的取件点落地
  // -------------------------------------------------------------------------
  it("父对话正在跑 → 不新起一段：条目排进它这一轮（`run.inbox`），在那一段的取件点落地", async () => {
    const gate = deferred<void>();
    const { client } = createScriptedClient([textRound("我在忙，等会儿看。")], gate);
    const harness = createHarness({ createAgent: async () => new Agent({ client, model: "gpt-4" }) });

    // 父对话正在跑一轮（卡在等首字）
    const parentTurn = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "忙起来" },
    });
    await harness.waitFor(() => parentTurn.runState().status === "running");

    await harness.runner.deliver(CONVERSATION_ID, { content: "子会话说完了", source: "会话 1" });

    // 还是那一段：没有第二个现场，条目在它的 inbox 里（等取件点带走）
    expect(harness.runner.turn(CONVERSATION_ID)).toBe(parentTurn);
    const inbox = parentTurn.runState().inbox;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.source).toBe("会话 1");
    expect(inbox[0]!.preview).toBe("子会话说完了");

    gate.resolve();
    await parentTurn.done;

    // 取件点把它落成了 user 消息（正文带来源注释），而且没有起第二段
    const rows = await rowsOf(harness);
    const delivered = rows.filter(
      (row) => row.role === AgentNSValue.Role.User && String(row.content).startsWith("// 这条消息来自"),
    );
    expect(delivered).toHaveLength(1);
    expect(String(delivered[0]!.content)).toContain("子会话说完了");
    // 一段只有一个 assistant（多起一段就会多一条回答）
    expect(rows.filter((row) => row.role === AgentNSValue.Role.Assistant)).toHaveLength(1);
    expect(harness.registry.conversationIds(WORKSPACE_ID)).toEqual([CONVERSATION_ID]);
  });

  // -------------------------------------------------------------------------
  // ③ 落后窗口：core 已 idle、turns 里还有现场 → 攒着，结算完才起新段
  // -------------------------------------------------------------------------
  it("父对话正在结算（落后窗口）→ 攒到这一段结算完才起新段，库里不留「没有上下文的段」", async () => {
    const { client } = createScriptedClient([
      textRound("第一段跑完了。"),
      textRound("第二段的回答。"),
    ]);
    /** 投递那一刻看到的事实（在 `onTurnSettled` 里取） */
    const atDelivery: { liveTurn: boolean; coreIdle: boolean } = {
      liveTurn: false,
      coreIdle: false,
    };
    let delivering: Promise<void> | undefined;
    let coreAgent: Agent | undefined;

    const harness = createHarness({
      createAgent: async () => {
        const agent = new Agent({ client, model: "gpt-4" });
        coreAgent = agent;
        return agent;
      },
      onTurnSettled: (facts, runner) => {
        if (facts.conversationId !== CONVERSATION_ID) return;
        // 只在第一段结算时投一次
        if (delivering) return;
        atDelivery.liveTurn = runner.turn(CONVERSATION_ID) !== undefined;
        atDelivery.coreIdle = coreAgent!.runStatus === "idle";
        delivering = runner.deliver(CONVERSATION_ID, {
          content: "结算窗口里到达的结果",
          source: "补测试",
        });
        // 攒着：这一刻既没有新段，也还没落成任何消息
        expect(runner.turn(CONVERSATION_ID)?.runState().status).toBe("settled");
      },
    });
    await parkAgent(harness);

    const first = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await first.done;

    // 投递发生在「core 已 idle、宿主现场还在」的那一小段里（这就是落后窗口）
    expect(atDelivery.liveTurn).toBe(true);
    expect(atDelivery.coreIdle).toBe(true);
    await delivering!;

    // 这一段结算完之后，攒下的那一批才投出去（= 起**新**一段，有完整现场）
    await harness.waitFor(() => harness.store.writes.filter((row) => row.conversationId === CONVERSATION_ID).length >= 4);
    await harness.idle();
    const rows = await rowsOf(harness);
    expect(rows.map((row) => row.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(String(rows[2]!.content)).toContain("结算窗口里到达的结果");
    expect(String(rows[2]!.content)).toContain("// 这条消息来自 补测试 自动推送");
    expect(rows[3]!.content).toBe("第二段的回答。");

    // 「没有产生一段没有上下文的段」：库里每一条 assistant 行都对应过一次 `run.state`
    // （没有现场的那一段不会推 `run.state`，它的消息也就不会落库）
    const known = new Set(
      harness
        .runStates()
        .map((state) => state.assistantMessageId)
        .filter((id): id is string => id !== null),
    );
    for (const row of rows) {
      if (row.role !== AgentNSValue.Role.Assistant) continue;
      expect(known.has(row.id)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // ④ 整批插入：连续投 3 条 → 同一次边界落成 3 条 user 消息、只起一段
  // -------------------------------------------------------------------------
  it("整批：连续投 3 条（中间不让出事件循环）→ 同一次边界落成 3 条 user、只起一段、只一次请求", async () => {
    const { client, bodies } = createScriptedClient([textRound("三条一起收到了。")]);
    const harness = createHarness({ createAgent: async () => new Agent({ client, model: "gpt-4" }) });
    await parkAgent(harness);

    // 三句之间**没有** await：它们必须被攒成一批
    const first = harness.runner.deliver(CONVERSATION_ID, { content: "甲", source: "会话 1" });
    const second = harness.runner.deliver(CONVERSATION_ID, { content: "乙", source: "会话 2" });
    const third = harness.runner.deliver(CONVERSATION_ID, { content: "丙", source: "会话 3" });
    await Promise.all([first, second, third]);

    const live = harness.runner.turn(CONVERSATION_ID);
    expect(live).toBeDefined();
    // 投递那一刻三条**已经全部**落地（一次 `flushInbox`），队列空了
    expect(live!.runState().inbox).toEqual([]);
    const settlement = await live!.done;

    const rows = await rowsOf(harness);
    // 断言一：3 条 user 连续，之后才是一条 assistant（不是「一条落地起段、其余下个边界」）
    expect(rows.map((row) => row.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.User,
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    // 断言二：assistant 只有一条 = 只起了一段
    expect(rows.filter((row) => row.role === AgentNSValue.Role.Assistant)).toHaveLength(1);
    expect(rows[3]!.content).toBe("三条一起收到了。");
    // 断言三：一次模型请求，而那一圈的请求体里三条都在（same boundary）
    expect(bodies).toHaveLength(1);
    const usersInFirstRequest = bodies[0]!.messages.filter(
      (message) => message.role === AgentNSValue.Role.User,
    );
    expect(usersInFirstRequest.map((message) => String(message.content).split("\n\n")[1] ?? message.content)).toEqual([
      "甲",
      "乙",
      "丙",
    ]);
    // 落地的那三条就是这一段自己产出的（结算快照里也是三条 user + 一条 assistant）
    expect(settlement.produced.map((message) => message.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.User,
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
    ]);
  });

  // -------------------------------------------------------------------------
  // ⑤ 复活：`agents.discard` 之后投递 → 按历史装配新 agent 再跑
  // -------------------------------------------------------------------------
  it("复活：显式 `agents.discard` 之后投递 → 自动装配（reconcile + resolveHistory），历史完整、seq 连续", async () => {
    const { client, bodies } = createScriptedClient([
      textRound("第一段的回答。"),
      textRound("复活之后的回答。"),
    ]);
    const harness = createHarness({ createAgent: async () => new Agent({ client, model: "gpt-4" }) });

    const first = await harness.runner.run({
      conversationId: CONVERSATION_ID,
      input: { content: "第一句" },
    });
    await first.done;
    const original = harness.registry.get(CONVERSATION_ID);
    expect(original).toBeDefined();
    // 第一次装配跑过一次历史还原（那时库里还没有消息）；之后 `run()` 从 agent 内存里取历史
    expect(harness.historyResolutions).toEqual([0]);

    // 显式丢掉登记（对话被删那条路）= 下一个投递必须自己把 agent 装回来
    harness.registry.discard(CONVERSATION_ID);
    expect(harness.registry.get(CONVERSATION_ID)).toBeUndefined();

    await harness.runner.deliver(CONVERSATION_ID, {
      content: "复活之后再投一句",
      source: "会话 1",
    });

    const live = harness.runner.turn(CONVERSATION_ID);
    expect(live).toBeDefined();
    const settlement = await live!.done;

    // 真的重新装配了（新对象、仍在登记表里），而且装配走了 `reconcile` + `resolveHistory`
    const revived = harness.registry.get(CONVERSATION_ID);
    expect(revived).toBeDefined();
    expect(revived).not.toBe(original);
    expect(harness.historyResolutions).toEqual([0, 2]); // 库里正有的那两行被读出来还原过

    // 历史完整：新 agent 手里有第一段的两条，也有这一次投递的与它的回答
    expect(revived!.messages.map((message) => message.content)).toEqual([
      "第一句",
      "第一段的回答。",
      expect.stringContaining("复活之后再投一句"),
      "复活之后的回答。",
    ]);
    // 第二次请求的请求体里带着第一段的历史（模型接得上话）
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.messages.map((message) => message.content)).toEqual([
      "第一句",
      "第一段的回答。",
      expect.stringContaining("复活之后再投一句"),
    ]);

    const rows = await rowsOf(harness);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(rows.map((row) => row.role)).toEqual([
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
      AgentNSValue.Role.User,
      AgentNSValue.Role.Assistant,
    ]);
    expect(settlement.outcome).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // 兜底：那段对话已经不在了 —— 唯一会拒绝投递的情形
  // -------------------------------------------------------------------------
  it("会话不存在 → 拒绝（`not_found`），不起段、不落库", async () => {
    const { client } = createScriptedClient([textRound("不该被请求到")]);
    const harness = createHarness({ createAgent: async () => new Agent({ client, model: "gpt-4" }) });

    await expect(
      harness.runner.deliver("c-missing", { content: "没有人收了", source: "会话 1" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(harness.runner.turn("c-missing")).toBeUndefined();
    expect(harness.runs.isRunning("c-missing")).toBe(false);
  });
});
