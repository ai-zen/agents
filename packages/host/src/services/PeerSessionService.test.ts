/**
 * 平级会话服务（阶段 1）的验收：**建完即回**、深度只有一层、模型解析不出来是结构化拒绝、
 * 跑完把结果投回父对话（在跑就入队、空闲就唤醒）、送不到只记 `dropped` 并出声一次。
 *
 * 这里用窄替身（假 creator / 假 runner / 记账式消息仓储）：本文件要钉的是**服务自己的判断**
 * （先 enqueue 还是先 run、截多少字、状态怎么落），而不是 `ChatRunner` 的时序。
 * 「条目真的落进父对话那一轮」与「唤醒那一轮 `source` 不是 user」在
 * `PeerSessionService.flow.test.ts` 里用真 `ChatRunner` 钉。
 */

import { describe, expect, it } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import type { Agent } from "@ai-zen/agents-core";

import type { ChatRunParams, ChatTurn, DeliveryOutcome, QueuedTurn, TurnSettlement } from "../runtime/ChatRunner.js";
import type { Conversation, StoredMessage } from "../storage/types.js";
import type { ConversationView, ConversationCreateParams, ConversationCreateResult } from "../wire/index.js";
import { HostError } from "../wire/errors.js";
import { zeroUsage } from "../wire/states.js";
import { PeerSessionService } from "./PeerSessionService.js";
import type { PeerSessionConversationCreator, PeerSessionRunner } from "./PeerSessionService.js";

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

/** 一段会话里的一行消息（只填本服务读到的那几格） */
function row(conversationId: string, role: string, text: string, seq = 1): StoredMessage {
  return {
    id: `${conversationId}-m${seq}`,
    conversationId,
    parentToolCallId: null,
    seq,
    role,
    status: AgentNS.MessageStatus.Completed as string,
    omit: false,
    content: text,
    data: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 子会话的诞生：记账 + 现场登记一行（与真 `conversation.create` 的可观察行为一致） */
class FakeCreator implements PeerSessionConversationCreator {
  readonly created: ConversationCreateParams[] = [];
  readonly persisted: string[] = [];
  readonly rows = new Map<string, Conversation>();
  failWith: unknown;
  private seq = 0;

  async create(params: ConversationCreateParams): Promise<ConversationCreateResult> {
    this.created.push(params);
    if (this.failWith !== undefined) throw this.failWith;
    this.seq += 1;
    const id = `c-child-${this.seq}`;
    this.rows.set(
      id,
      conversation(id, {
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        modelId: params.modelId ?? "model-1",
      }),
    );
    return { conversation: { id } as unknown as ConversationView };
  }

  async ensurePersisted(conversationId: string): Promise<Conversation> {
    this.persisted.push(conversationId);
    const stored = this.rows.get(conversationId);
    if (!stored) throw new HostError("not_found", { params: { entity: "conversation" } });
    return stored;
  }
}

/** 一轮的替身：`done` 由用例在想要的时刻结算 */
class FakeTurn {
  readonly conversationId: string;
  private resolveDone!: (settlement: TurnSettlement) => void;
  readonly done: Promise<TurnSettlement>;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
    this.done = new Promise<TurnSettlement>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** 结算这一轮（`outcome` 决定记录状态与投递正文） */
  settle(outcome: TurnSettlement["outcome"], problem: TurnSettlement["problem"] = null): void {
    this.resolveDone({
      conversationId: this.conversationId,
      assistantMessageId: `${this.conversationId}-a`,
      outcome,
      problem,
      messages: [],
      produced: [],
      usage: zeroUsage(new Date(0).toISOString()),
      run: {} as TurnSettlement["run"],
    });
  }
}

/** 记账式执行者：投递收了没有（`deliverError`）、`run` 抛不抛错都由用例说了算 */
class FakeRunner implements PeerSessionRunner {
  readonly runCalls: ChatRunParams[] = [];
  /** 每一次投递（**唯一**的投递入口：服务不再自己判断父对话在不在跑） */
  readonly deliverCalls: Array<{ conversationId: string; content: AgentNS.MessageContent; source: string }> = [];
  /** 设了就让 `run` 抛错（子会话开跑失败 / 父对话被删） */
  runError: unknown;
  /** 设了就让 `deliver` 抛错（父对话不存在：**唯一**会拒绝投递的情形） */
  deliverError: unknown;
  /** 下一次投递的回执 `state`（缺省 `idle`：假件不演那三支现场） */
  deliverState: DeliveryOutcome["state"] = "idle";
  private readonly turns: FakeTurn[] = [];

  async run(params: ChatRunParams): Promise<ChatTurn> {
    this.runCalls.push(params);
    if (this.runError !== undefined) throw this.runError;
    const turn = new FakeTurn(params.conversationId);
    this.turns.push(turn);
    return turn as unknown as ChatTurn;
  }

  async deliver(
    conversationId: string,
    input: { content: AgentNS.MessageContent; source: string },
  ): Promise<DeliveryOutcome> {
    this.deliverCalls.push({ conversationId, content: input.content, source: input.source });
    if (this.deliverError !== undefined) throw this.deliverError;
    return { accepted: true, state: this.deliverState };
  }

  /** 某段会话最近一次开起来的一轮 */
  turnOf(conversationId: string): FakeTurn {
    const found = this.turns.filter((turn) => turn.conversationId === conversationId).at(-1);
    if (!found) throw new Error(`no turn for ${conversationId}`);
    return found;
  }
}

interface Harness {
  service: PeerSessionService;
  creator: FakeCreator;
  runner: FakeRunner;
  /** 会话行（「库里」那一份）：用例可以直接塞一段别的会话进来 */
  conversations: Map<string, Conversation>;
  /** 父对话那个 agent（工具回调里 `ctx.agent` 就是它） */
  parentAgent: Agent;
  /** 记账式消息仓储：按 conversationId 存行 */
  messages: Map<string, StoredMessage[]>;
  errors: Array<{ error: unknown; context: string }>;
  /** 给某段会话补一条消息（模拟子会话说完了话） */
  say(conversationId: string, text: string, role?: string): void;
  /** 让服务认下「这个 agent 是这段会话的」 */
  bind(agent: Agent, conversationId: string): void;
}

function createHarness(): Harness {
  const conversations = new Map<string, Conversation>([
    [PARENT_ID, conversation(PARENT_ID)],
  ]);
  const creator = new FakeCreator();
  const runner = new FakeRunner();
  const messages = new Map<string, StoredMessage[]>();
  const errors: Array<{ error: unknown; context: string }> = [];

  const service = new PeerSessionService({
    conversations: {
      get: async (id: string) => conversations.get(id) ?? creator.rows.get(id),
    },
    conversationCreator: creator,
    messages: {
      listByConversation: async (conversationId: string) => messages.get(conversationId) ?? [],
    },
    chatRunner: runner,
    now: () => Date.UTC(2026, 0, 1, 0, 0, 0),
    onError: (error, context) => {
      errors.push({ error, context });
    },
  });

  const parentAgent = { name: "parent" } as unknown as Agent;
  service.bind(parentAgent, PARENT_ID);

  let seq = 0;
  return {
    service,
    creator,
    runner,
    conversations,
    parentAgent,
    messages,
    errors,
    say(conversationId, text, role = AgentNS.Role.Assistant) {
      seq += 1;
      const rows = messages.get(conversationId) ?? [];
      rows.push(row(conversationId, role, text, seq));
      messages.set(conversationId, rows);
    },
    bind(agent, conversationId) {
      service.bind(agent, conversationId);
    },
  };
}

/** 等到后台的投递跑完（`void turn.done.then(...)` 里那一串 await） */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("create：建完即回", () => {
  it("返回 { sessionId, label }，子会话还在跑（不 await 它的结果）", async () => {
    const h = createHarness();
    const created = await h.service.create({ caller: h.parentAgent, prompt: "把登录页的测试补齐" });

    expect(created).toEqual({ ok: true, sessionId: "c-child-1", label: "会话 1" });
    // 子会话真的开跑了（`run` 受理即回），而且草稿已经落成库里的行
    expect(h.runner.runCalls).toHaveLength(1);
    expect(h.runner.runCalls[0]).toMatchObject({
      conversationId: "c-child-1",
      input: { content: "把登录页的测试补齐" },
      source: "父对话",
    });
    expect(h.creator.persisted).toEqual(["c-child-1"]);

    // 这一刻它还跑着：状态 running，而 `lastMessage` 是已有内容（新会话里什么都没有）
    const status = await h.service.status({ caller: h.parentAgent, sessionId: "c-child-1" });
    expect(status.state).toBe("running");
    expect(status.label).toBe("会话 1");
    expect(status.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(status.lastMessage).toBeUndefined();
  });

  it("agentId / modelId 缺省继承父对话那一行，点名了就照点名的建", async () => {
    const h = createHarness();

    await h.service.create({ caller: h.parentAgent, prompt: "A" });
    expect(h.creator.created[0]).toEqual({ workspaceId: "ws-1", agentId: "default" });

    await h.service.create({
      caller: h.parentAgent,
      prompt: "B",
      agentId: "reviewer",
      modelId: "model-2",
      label: "复查",
    });
    expect(h.creator.created[1]).toEqual({
      workspaceId: "ws-1",
      agentId: "reviewer",
      modelId: "model-2",
    });
    // 第二次给了 label 就用它，序号不再顶替
    const status = await h.service.status({ caller: h.parentAgent, sessionId: "c-child-2" });
    expect(status.label).toBe("复查");
  });

  it("深度只有一层：平级会话自己再建 → depth_exceeded，且不建任何新会话", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "A" });
    const childAgent = { name: "child" } as unknown as Agent;
    h.bind(childAgent, "c-child-1");

    const second = await h.service.create({ caller: childAgent, prompt: "再开一层" });

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.reason).toBe("depth_exceeded");
    expect(second.hint).toBeTruthy();
    // 一条新会话都没建、也没开跑（第二次 run 不存在）
    expect(h.creator.created).toHaveLength(1);
    expect(h.runner.runCalls).toHaveLength(1);
  });

  it("三级解析拿不到模型 → model_unresolved（返回结果，不抛错）", async () => {
    const h = createHarness();
    h.creator.failWith = new HostError("config_invalid", { messageKey: "error.modelUnresolved" });

    const created = await h.service.create({ caller: h.parentAgent, prompt: "A" });

    expect(created.ok).toBe(false);
    if (created.ok) throw new Error("unreachable");
    expect(created.reason).toBe("model_unresolved");
    expect(h.runner.runCalls).toEqual([]);
  });

  it("别的建会话失败照抛（那是接线出了问题，编一个「拒绝」反而误导模型）", async () => {
    const h = createHarness();
    h.creator.failWith = new HostError("not_found", { params: { entity: "agent" } });

    await expect(h.service.create({ caller: h.parentAgent, prompt: "A" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("没绑会话的 agent 调进来 → 直接报错（不编一个假父对话）", async () => {
    const h = createHarness();
    const stranger = { name: "stranger" } as unknown as Agent;
    await expect(h.service.create({ caller: stranger, prompt: "A" })).rejects.toThrow(/not bound/);
  });
});

describe("投递：跑完把结果送回父对话", () => {
  it("父对话空闲 → 一次 `chatRunner.deliver`（服务不判断在不在跑），正文是子会话最后一条助手消息", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "把登录页的测试补齐", label: "补测试" });
    h.say("c-child-1", "默认用户说的话", AgentNS.Role.User);
    h.say("c-child-1", "补了 3 个用例，全绿。", AgentNS.Role.Assistant);

    h.runner.turnOf("c-child-1").settle("completed");
    await settle();

    // 投递只有一处：不需要「先 enqueue 再 run」那两级猜测，也没有第二个 run
    expect(h.runner.deliverCalls).toHaveLength(1);
    expect(h.runner.runCalls).toHaveLength(1);
    const delivered = h.runner.deliverCalls[0]!;
    expect(delivered.conversationId).toBe(PARENT_ID);
    // 正文只说子会话最后一句，不带那一整段对话
    expect(delivered.content).toBe("补了 3 个用例，全绿。");
    // source 就是正文开头那行注释里的来源，label 原样（拼注释归 core）
    expect(delivered.source).toBe("补测试");

    const status = await h.service.status({ caller: h.parentAgent, sessionId: "c-child-1" });
    expect(status.state).toBe("idle");
    expect(h.service.record("c-child-1")?.resultDelivered).toBe("delivered");
  });

  it("受理即 delivered：执行者怎么投（入队 / 攒批 / 唤醒 / 复活）与本文件无关", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "A" });
    h.say("c-child-1", "做完了");

    h.runner.turnOf("c-child-1").settle("completed");
    await settle();

    // 服务只把内容交给执行者，然后立刻记账 —— 剩下的（入队 / 攒批 / 唤醒 / 复活）都在那一处
    expect(h.runner.deliverCalls).toHaveLength(1);
    expect(h.runner.deliverCalls[0]).toMatchObject({
      conversationId: PARENT_ID,
      content: "做完了",
      source: "会话 1",
    });
    expect(h.service.record("c-child-1")?.resultDelivered).toBe("delivered");
    expect(h.errors).toEqual([]);
  });

  it("失败时正文写明原因（句子，不是错误栈），标题与摘要之间空一行", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "A" });
    h.say("c-child-1", "我改到一半");

    h.runner.turnOf("c-child-1").settle("error", {
      code: "internal",
      messageKey: "error.internal",
      params: {},
      message: "内部错误",
      detail: { reason: "socket hang up" },
    });
    await settle();

    const body = h.runner.deliverCalls[0]!.content as string;
    expect(body.split("\n\n")[0]).toBe("子会话失败了：内部错误（socket hang up）");
    expect(body.endsWith("我改到一半")).toBe(true);

    const status = await h.service.status({ caller: h.parentAgent, sessionId: "c-child-1" });
    expect(status.state).toBe("failed");
  });

  it("中止也是句子（说的是「被中止」，不是「失败」）", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "A" });
    h.runner.turnOf("c-child-1").settle("aborted");
    await settle();

    const body = h.runner.deliverCalls[0]!.content as string;
    expect(body.startsWith("子会话被中止了")).toBe(true);
    expect(body).toContain("没有留下任何正文");

    const status = await h.service.status({ caller: h.parentAgent, sessionId: "c-child-1" });
    expect(status.state).toBe("aborted");
  });

  it("父对话不存在（投递被拒）→ 记 dropped 并出声一次，不重试不补投", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "A" });
    h.say("c-child-1", "做完了");
    // 唯一会拒绝投递的情形：那段对话已经不存在（执行者的 `not_found`）
    h.runner.deliverError = new HostError("not_found", { params: { entity: "conversation" } });

    h.runner.turnOf("c-child-1").settle("completed");
    await settle();

    const record = h.service.record("c-child-1");
    expect(record?.resultDelivered).toBe("dropped");
    // 只投过一次：不重试、不补投
    expect(h.runner.deliverCalls).toHaveLength(1);
    // 出声一次（不许静默丢）
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.context).toContain("没能投递");
    // 状态照落：这一轮确实跑完了
    const status = await h.service.status({ caller: h.parentAgent, sessionId: "c-child-1" });
    expect(status.state).toBe("idle");
  });
});

describe("send_to_session：血缘、来源名、回执", () => {
  it("父→子：投递到那个子会话，`state` 原样回给工具", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "A" });
    h.runner.deliverState = "running";

    const sent = await h.service.send({
      caller: h.parentAgent,
      sessionId: "c-child-1",
      content: "再把边界用例也补上",
    });

    expect(sent).toEqual({ ok: true, state: "running" });
    expect(h.runner.deliverCalls).toHaveLength(1);
    expect(h.runner.deliverCalls[0]).toMatchObject({
      conversationId: "c-child-1",
      content: "再把边界用例也补上",
    });
  });

  it("子→父：父对话不是 `records` 里的会话也能发（它是我的父，靠我自己那条记录答）", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "A" });
    const childAgent = { name: "child" } as unknown as Agent;
    h.bind(childAgent, "c-child-1");
    h.runner.deliverState = "idle";

    const sent = await h.service.send({
      caller: childAgent,
      sessionId: PARENT_ID,
      content: "需要更多信息",
    });

    expect(sent).toEqual({ ok: true, state: "idle" });
    expect(h.runner.deliverCalls[0]).toMatchObject({
      conversationId: PARENT_ID,
      content: "需要更多信息",
    });
  });

  it("平级之间不许互发 → not_allowed，一句也不投", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "A" }); // c-child-1
    await h.service.create({ caller: h.parentAgent, prompt: "B" }); // c-child-2
    const firstChild = { name: "child-1" } as unknown as Agent;
    h.bind(firstChild, "c-child-1");

    const sent = await h.service.send({
      caller: firstChild,
      sessionId: "c-child-2",
      content: "你那边进展如何",
    });

    expect(sent).toEqual({ ok: false, reason: "not_allowed" });
    expect(h.runner.deliverCalls).toEqual([]);
  });

  it("不存在的 id（重启之后 / 被删 / 压根不是会话）→ gone，一句也不投", async () => {
    const h = createHarness();

    const sent = await h.service.send({
      caller: h.parentAgent,
      sessionId: "c-nope",
      content: "在吗",
    });

    expect(sent).toEqual({ ok: false, reason: "gone" });
    expect(h.runner.deliverCalls).toEqual([]);
  });

  it("来源名由宿主解析：父发文时用会话行上的 `name`，peer 发父时用它自己的 `label`", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "A", label: "补测试" });

    // 父 → 子：调用者是普通会话，名字来自会话行（这个假仓储里 `name` 就是 id）
    await h.service.send({ caller: h.parentAgent, sessionId: "c-child-1", content: "接着做" });
    expect(h.runner.deliverCalls[0]!.source).toBe("会话「c-parent」");

    // 子 → 父：调用者自己是 peer，用它自己的 label（不是会话行上的名字）
    const childAgent = { name: "child" } as unknown as Agent;
    h.bind(childAgent, "c-child-1");
    await h.service.send({ caller: childAgent, sessionId: PARENT_ID, content: "做完了" });
    expect(h.runner.deliverCalls[1]!.source).toBe("会话「补测试」");
  });
});

describe("create_session 的并发限额：每个父对话最多 4 个在跑的", () => {
  it("4 个在跑时第 5 个被拒（too_many_peers），一个跑完之后又能建", async () => {
    const h = createHarness();
    for (let i = 0; i < 4; i += 1) {
      const created = await h.service.create({ caller: h.parentAgent, prompt: `任务 ${i}` });
      expect(created.ok).toBe(true);
    }
    expect(h.creator.created).toHaveLength(4);

    const fifth = await h.service.create({ caller: h.parentAgent, prompt: "第五个" });
    expect(fifth.ok).toBe(false);
    if (fifth.ok) throw new Error("unreachable");
    expect(fifth.reason).toBe("too_many_peers");
    expect(fifth.hint).toBeTruthy();
    // 拒绝不许留下副作用：没有建会话、也没有开跑
    expect(h.creator.created).toHaveLength(4);
    expect(h.runner.runCalls).toHaveLength(4);

    // 其中一个跑完（记录状态变 idle）→ 名额又有了
    h.runner.turnOf("c-child-1").settle("completed");
    await settle();
    expect(h.service.record("c-child-1")?.state).toBe("idle");

    const sixth = await h.service.create({ caller: h.parentAgent, prompt: "再开一个" });
    expect(sixth.ok).toBe(true);
    expect(h.creator.created).toHaveLength(5);
  });

  it("限额按**父对话**分别算：另一个父对话不受影响", async () => {
    const h = createHarness();
    for (let i = 0; i < 4; i += 1) await h.service.create({ caller: h.parentAgent, prompt: `A${i}` });

    const otherParent = { name: "other" } as unknown as Agent;
    h.bind(otherParent, "c-other-parent");
    h.conversations.set("c-other-parent", conversation("c-other-parent"));

    const created = await h.service.create({ caller: otherParent, prompt: "我这边的活" });
    expect(created.ok).toBe(true);
  });
});

describe("read_session_status", () => {
  it("查不到（重启之后 / 被删）→ gone，不抛错", async () => {
    const h = createHarness();
    const status = await h.service.status({ caller: h.parentAgent, sessionId: "c-nope" });
    expect(status).toEqual({ state: "gone" });
  });

  it("lastMessage 是截断摘要（约 300 字），不是全量消息", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "A" });
    h.say("c-child-1", "长".repeat(2000));

    const status = await h.service.status({ caller: h.parentAgent, sessionId: "c-child-1" });
    expect(status.lastMessage).toBeDefined();
    expect(status.lastMessage!.length).toBeLessThanOrEqual(301);
    expect(status.lastMessage!.endsWith("…")).toBe(true);
  });

  it("投递正文同样截断（~1000 字），不会把整段回复搬进父对话", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "A" });
    h.say("c-child-1", "长".repeat(5000));

    h.runner.turnOf("c-child-1").settle("completed");
    await settle();

    const body = h.runner.deliverCalls[0]!.content as string;
    expect(body.length).toBeLessThanOrEqual(1001);
  });

  it("只看助手消息：最后一条助手消息有正文就用它，工具消息 / 用户消息都不算", async () => {
    const h = createHarness();
    await h.service.create({ caller: h.parentAgent, prompt: "A" });
    h.say("c-child-1", "第一句答复");
    h.say("c-child-1", "", AgentNS.Role.Assistant);
    h.say("c-child-1", "用户又催了一句", AgentNS.Role.User);

    const status = await h.service.status({ caller: h.parentAgent, sessionId: "c-child-1" });
    expect(status.lastMessage).toBe("第一句答复");
  });
});
