/**
 * 平级会话服务的验收：**建完即回**、状态**现读**、投递**不看关系**、记录里没有状态。
 *
 * 这里用窄替身（假 creator / 假执行者 / 假会话表）：本文件要钉的是**服务自己的判断** ——
 * 哪一段该拒、状态怎么读、来源名从哪来、名字与摘要有多少字 —— 而不是 `ChatRunner` 的时序。
 * 与真执行者拼起来看的那几条在 `PeerSessionService.flow.test.ts`。
 */

import { describe, expect, it } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import type { Agent } from "@ai-zen/agents-core";

import type { DeliveryInput } from "../runtime/ChatRunner.js";
import { FakeAgent } from "../runtime/TestSupport.js";
import type { Conversation, StoredMessage } from "../storage/types.js";
import type {
  ConversationCreateParams,
  ConversationCreateResult,
  ConversationStatus,
  ConversationView,
} from "../wire/index.js";
import { HostError } from "../wire/errors.js";
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
    // v4 的四列：用例摆出来的都是「用户建的那一侧」（阈值跟模型走、开关关、没血缘）
    handoffThreshold: null,
    guardThreshold: null,
    autoHandoff: false,
    lineage: null,
    nameIsAuto: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** 一段会话里的一行消息（只填本服务读到的那几格） */
function row(conversationId: string, role: string, text: string, seq = 1): StoredMessage {
  return {
    id: `${conversationId}-m${seq}`,
    conversationId,
    parentToolCallId: null,
    source: null,
    seq,
    role,
    status: AgentNS.MessageStatus.Completed as string,
    omit: false,
    content: text,
    data: {},
    createdAt: seq,
    updatedAt: seq,
  };
}

/** 子会话的诞生：与 `conversation.create` 一样把新会话登记进「库里」 */
class FakeCreator implements PeerSessionConversationCreator {
  readonly created: ConversationCreateParams[] = [];
  readonly persisted: string[] = [];
  readonly rows = new Map<string, Conversation>();
  /** 让 `create` 抛这个错（试「模型解析不出来」那条） */
  failWith?: unknown;
  private seq = 0;

  constructor() {
    this.rows.set(PARENT_ID, conversation(PARENT_ID, { name: "父对话" }));
  }

  async create(params: ConversationCreateParams & { lineage: string; autoHandoff: boolean }): Promise<ConversationCreateResult> {
    this.created.push(params);
    if (this.failWith !== undefined) throw this.failWith;
    this.seq += 1;
    const id = `c-child-${this.seq}`;
    // 血缘与开关在创建那一刻就落到「库里那一行」（v4：它们不再只活在进程内）
    this.rows.set(
      id,
      conversation(id, {
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        lineage: params.lineage,
        autoHandoff: params.autoHandoff,
      }),
    );
    return { conversation: { id } as unknown as ConversationView };
  }

  async ensurePersisted(conversationId: string): Promise<Conversation> {
    this.persisted.push(conversationId);
    const found = this.rows.get(conversationId);
    if (!found) throw new Error(`conversation ${conversationId} not registered`);
    return found;
  }
}

/** 执行者：只记「谁收到了什么」，状态表由用例摆 */
class FakeRunner implements PeerSessionRunner {
  readonly deliveries: Array<{ conversationId: string; input: DeliveryInput }> = [];
  readonly statuses = new Map<string, ConversationStatus>();
  /** 让 `deliver` 抛这个错（试「目标不存在」那条） */
  failWith?: unknown;

  async deliver(
    conversationId: string,
    input: DeliveryInput,
  ): Promise<{ userMessageId: string }> {
    if (this.failWith !== undefined) throw this.failWith;
    this.deliveries.push({ conversationId, input });
    return { userMessageId: `m-${this.deliveries.length}` };
  }

  state(conversationId: string): { status: ConversationStatus } {
    return { status: this.statuses.get(conversationId) ?? "dead" };
  }
}

interface Harness {
  service: PeerSessionService;
  creator: FakeCreator;
  runner: FakeRunner;
  /** 调用方（父对话那段会话里装配出来的 agent） */
  caller: Agent;
  /** 摆一段会话的「库里那一行」与它的消息 */
  seed(conversationId: string, messages?: StoredMessage[]): void;
}

function makeHarness(): Harness {
  const creator = new FakeCreator();
  const runner = new FakeRunner();
  const stored = new Map<string, StoredMessage[]>();
  const caller = new FakeAgent();

  const service = new PeerSessionService({
    conversations: {
      get: async (id) => creator.rows.get(id),
      listByLineage: async (lineage) =>
        [...creator.rows.values()]
          .filter((row) => row.lineage === lineage)
          .map((row) => ({ id: row.id })),
    },
    conversationCreator: creator,
    messages: {
      listByConversation: async (conversationId) => stored.get(conversationId) ?? [],
    },
    chatRunner: runner,
  });
  service.bind(caller, PARENT_ID);

  return {
    service,
    creator,
    runner,
    caller,
    seed: (conversationId, messages = []) => {
      if (!creator.rows.has(conversationId)) {
        creator.rows.set(conversationId, conversation(conversationId));
      }
      stored.set(conversationId, messages);
    },
  };
}

// ---------------------------------------------------------------------------
// 建：受理即回
// ---------------------------------------------------------------------------

describe("create：建会话 → 落真行 → 把第一句交出去 → 立刻回", () => {
  it("回执只有 sessionId 与 label，第一句以「父对话」为来源投进去", async () => {
    const harness = makeHarness();

    const created = await harness.service.create({ caller: harness.caller, prompt: "查一下登录页" });

    expect(created).toEqual({ ok: true, sessionId: "c-child-1", label: "会话 1" });
    // 会话按 `conversation.create` 那条路开：同项目、同助手（模型交给三级解析），
    // 外加两项身份：谁开的（血缘）与自动交接开关的初值
    expect(harness.creator.created).toEqual([
      {
        workspaceId: "ws-1",
        agentId: "default",
        lineage: PARENT_ID,
        autoHandoff: true,
      },
    ]);
    // 先落真行再投（消息行要挂在这段对话上）
    expect(harness.creator.persisted).toEqual(["c-child-1"]);
    const delivery = harness.runner.deliveries[0]!;
    expect(delivery.conversationId).toBe("c-child-1");
    expect(delivery.input).toEqual({
      content: "查一下登录页",
      source: { kind: "agent", label: "父对话" },
      // 这里就是创建者：刚建出来的对话由创建者装上驱动者
      mayStart: true,
    });
  });

  it("进程内只留一个可读名：血缘、开关、层数、开启时刻都不在记录里", async () => {
    const harness = makeHarness();
    const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
    if (!created.ok) throw new Error("没建成");

    // 记录里就那一个名字：没有 process 内的血缘 / 深度 / 开启时刻
    expect(harness.service.labelOf(created.sessionId)).toBe(created.label);
    // 血缘与开关是**会话行上的列**（创建那一刻写死）
    const child = harness.creator.rows.get(created.sessionId);
    expect(child).toMatchObject({ lineage: PARENT_ID, autoHandoff: true });
  });

  it("调用方自己就是平级会话 → `depth_exceeded`，一段会话都不建", async () => {
    const harness = makeHarness();
    const child = await harness.service.create({ caller: harness.caller, prompt: "第一层" });
    if (!child.ok) throw new Error("第一层没建成");
    // 子会话里的 agent 也登记一次：它现在是一个「平级会话」的调用方
    const nested = new FakeAgent();
    harness.service.bind(nested, child.sessionId);

    const refused = await harness.service.create({ caller: nested, prompt: "再开一个" });

    expect(refused).toMatchObject({ ok: false, reason: "depth_exceeded" });
    expect(harness.creator.created).toHaveLength(1);
  });

  it("手头忙着的平级会话满了 → `too_many_peers`，且不留下建了一半的会话", async () => {
    const harness = makeHarness();
    for (let index = 1; index <= 4; index += 1) {
      await harness.service.create({ caller: harness.caller, prompt: `活 ${index}` });
      harness.runner.statuses.set(`c-child-${index}`, "busy");
    }

    const refused = await harness.service.create({ caller: harness.caller, prompt: "第五个" });

    expect(refused).toMatchObject({ ok: false, reason: "too_many_peers" });
    expect(harness.creator.created).toHaveLength(4);
  });

  it("闲着的平级会话不占名额（判据是现读的那一格，不是「开过几个」）", async () => {
    const harness = makeHarness();
    for (let index = 1; index <= 2; index += 1) {
      await harness.service.create({ caller: harness.caller, prompt: `活 ${index}` });
      harness.runner.statuses.set(`c-child-${index}`, "busy");
    }
    // 另外两段开过、但现在闲着 / 暂停着
    await harness.service.create({ caller: harness.caller, prompt: "闲的" });
    await harness.service.create({ caller: harness.caller, prompt: "停的" });
    harness.runner.statuses.set("c-child-3", "idle");
    harness.runner.statuses.set("c-child-4", "paused");

    const created = await harness.service.create({ caller: harness.caller, prompt: "第三个忙的" });

    expect(created.ok).toBe(true);
  });

  it("三级解析拿不到模型 → `model_unresolved`（不抛错，让模型自己换招）", async () => {
    const harness = makeHarness();
    harness.creator.failWith = new HostError("config_invalid", {
      messageKey: "error.modelUnresolved",
      detail: { agentId: "default" },
    });

    const refused = await harness.service.create({ caller: harness.caller, prompt: "干点活" });

    expect(refused).toMatchObject({ ok: false, reason: "model_unresolved" });
    expect(harness.runner.deliveries).toEqual([]);
  });

  it("父对话已经不在了 → 真错误（不是一条拒绝）", async () => {
    const harness = makeHarness();
    harness.creator.rows.delete(PARENT_ID);

    await expect(
      harness.service.create({ caller: harness.caller, prompt: "干点活" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// 问状态：现读
// ---------------------------------------------------------------------------

describe("status：那一格现读，名字用进程内那条（没有就退回会话行）", () => {
  it("会话行里没有它 → `gone`（重启后 / 没见过的 id 都走这条）", async () => {
    const harness = makeHarness();
    await expect(
      harness.service.status({ caller: harness.caller, sessionId: "c-unknown" }),
    ).resolves.toEqual({ state: "gone" });
  });

  it("会话行没了（用户删了这段会话）→ `gone`：判据只有「这一段还在不在」", async () => {
    const harness = makeHarness();
    const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
    if (!created.ok) throw new Error("没建成");
    harness.creator.rows.delete(created.sessionId);

    await expect(
      harness.service.status({ caller: harness.caller, sessionId: created.sessionId }),
    ).resolves.toEqual({ state: "gone" });
  });

  // 四格逐格同名：宿主说 `busy` / `idle` / `paused` / `dead`，SDK 报的就是这四个。
  // `gone` 不是一格状态，是「会话行找不到了」（上面两条），所以不在这一张表里。
  for (const status of ["busy", "idle", "paused", "dead"] as const) {
    it(`现读是 ${status} → 报 ${status}（逐格同名，不翻译）`, async () => {
      const harness = makeHarness();
      const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
      if (!created.ok) throw new Error("没建成");
      harness.runner.statuses.set(created.sessionId, status);
      harness.seed(created.sessionId, [row(created.sessionId, AgentNS.Role.Assistant, "答案")]);

      const result = await harness.service.status({
        caller: harness.caller,
        sessionId: created.sessionId,
      });

      expect(result.state).toBe(status);
      expect(result.label).toBe(created.label);
      expect(result.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
    });
  }

  it("摘要只说最后一句助手的话，超 300 字截断；没有正文就不给这一格", async () => {
    const harness = makeHarness();
    const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
    if (!created.ok) throw new Error("没建成");

    const long = "很长的回答".repeat(100);
    harness.seed(created.sessionId, [
      row(created.sessionId, AgentNS.Role.User, "问题", 1),
      row(created.sessionId, AgentNS.Role.Assistant, long, 2),
    ]);
    const withText = await harness.service.status({
      caller: harness.caller,
      sessionId: created.sessionId,
    });
    expect(withText.lastMessage).toBe(`${long.slice(0, 300)}…`);

    // 只有工具消息（没有正文）时不给摘要这一格
    const harness2 = makeHarness();
    const second = await harness2.service.create({ caller: harness2.caller, prompt: "干点活" });
    if (!second.ok) throw new Error("没建成");
    harness2.seed(second.sessionId, [row(second.sessionId, AgentNS.Role.Tool, "")]);
    const noText = await harness2.service.status({
      caller: harness2.caller,
      sessionId: second.sessionId,
    });
    expect(noText.lastMessage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 接着说话：投递不看关系
// ---------------------------------------------------------------------------

describe("send：直接把这一句交出去，不看关系", () => {
  it("投给一段没有血缘的会话也照收（只投，不判「它跟我什么关系」）", async () => {
    const harness = makeHarness();
    harness.seed("c-stranger");
    harness.runner.statuses.set("c-stranger", "idle");

    const result = await harness.service.send({
      caller: harness.caller,
      sessionId: "c-stranger",
      content: "帮我看看这个",
    });

    // 回执只有「收下了」：那边闲着这件事不在回执里
    expect(result).toEqual({ ok: true });
    expect(harness.runner.deliveries[0]).toEqual({
      conversationId: "c-stranger",
      input: { content: "帮我看看这个", source: { kind: "agent", label: "会话「父对话」" } },
    });
  });

  it("来源名由宿主解析：调用方自己是平级会话时用它自己的 label", async () => {
    const harness = makeHarness();
    const child = await harness.service.create({ caller: harness.caller, prompt: "第一层" });
    if (!child.ok) throw new Error("没建成");
    const nested = new FakeAgent();
    harness.service.bind(nested, child.sessionId);
    harness.seed("c-stranger");

    await harness.service.send({
      caller: nested,
      sessionId: "c-stranger",
      content: "说一句",
    });

    // 第 0 条是 `create` 投进去的那第一句（来源「父对话」），这一条是 `send` 投的
    expect(harness.runner.deliveries[1]!.input.source).toEqual({
      kind: "agent",
      label: `会话「${child.label}」`,
    });
  });

  // 回执不看那边忙不忙：投递那一刻能定下的只有「收下了」，状态是对未来的断言
  for (const status of ["busy", "idle", "paused"] as const) {
    it(`回执只有「收下了」：那边是 ${status} 也不带状态`, async () => {
      const harness = makeHarness();
      harness.seed("c-stranger");
      harness.runner.statuses.set("c-stranger", status);

      const result = await harness.service.send({
        caller: harness.caller,
        sessionId: "c-stranger",
        content: "说一句",
      });

      expect(result).toEqual({ ok: true });
      expect("state" in result).toBe(false);
    });
  }

  it("目标不存在 → 执行者的错误原样上抛（这里不编一条「拒绝」出来）", async () => {
    const harness = makeHarness();
    harness.runner.failWith = new HostError("conversation_dead");

    await expect(
      harness.service.send({ caller: harness.caller, sessionId: "c-missing", content: "说一句" }),
    ).rejects.toMatchObject({ code: "conversation_dead" });
  });

  it("调用方那段会话行都没了 → `not_found`（这条消息没有可信的署名）", async () => {
    const harness = makeHarness();
    harness.creator.rows.delete(PARENT_ID);

    await expect(
      harness.service.send({ caller: harness.caller, sessionId: "c-stranger", content: "说一句" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(harness.runner.deliveries).toEqual([]);
  });
});
