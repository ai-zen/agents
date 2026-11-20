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
import type { Session, StoredMessage } from "../storage/types.js";
import type {
  SessionCreateParams,
  SessionCreateResult,
  SessionPresence,
  SessionView,
} from "../wire/index.js";
import { HostError } from "../wire/errors.js";
import { PeerSessionService } from "./PeerSessionService.js";
import type { PeerSessionSessionCreator, PeerSessionRunner } from "./PeerSessionService.js";

const PARENT_ID = "c-parent";

function session(id: string, overrides: Partial<Session> = {}): Session {
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
    // 待交接：刚建出来 / 没答过交接题，没有待交接
    pendingHandoff: null,
    nameIsAuto: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** 一段会话里的一行消息（只填本服务读到的那几格） */
function row(sessionId: string, role: string, text: string, seq = 1): StoredMessage {
  return {
    id: `${sessionId}-m${seq}`,
    sessionId,
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

/**
 * 内存里的一条消息（`agent.messages` 的那一格）：本服务只读 `role` 与 `content`。
 *
 * 为什么直接造 core 的 `Message` 而不是落一行：摘要从**内存**里取（不查库）—— 那正是「现读」的意思。
 */
let saidSeq = 0;
function said(role: AgentNS.Role, content: AgentNS.MessageContent): AgentNS.Message {
  saidSeq += 1;
  return { id: `said-${saidSeq}`, role, content };
}

/** 平级会话的诞生：与 `session.create` 一样把新会话登记进「库里」 */
class FakeCreator implements PeerSessionSessionCreator {
  readonly created: SessionCreateParams[] = [];
  readonly persisted: string[] = [];
  readonly rows = new Map<string, Session>();
  /** 让 `create` 抛这个错（试「模型解析不出来」那条） */
  failWith?: unknown;
  private seq = 0;

  constructor() {
    this.rows.set(PARENT_ID, session(PARENT_ID, { name: "父会话" }));
  }

  async create(
    params: SessionCreateParams & { lineage: string; autoHandoff: boolean },
  ): Promise<SessionCreateResult> {
    this.created.push(params);
    if (this.failWith !== undefined) throw this.failWith;
    this.seq += 1;
    const id = `c-child-${this.seq}`;
    // 血缘与开关在创建那一刻就落到「库里那一行」
    this.rows.set(
      id,
      session(id, {
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        lineage: params.lineage,
        autoHandoff: params.autoHandoff,
      }),
    );
    return { session: { id } as unknown as SessionView };
  }

  async ensurePersisted(sessionId: string): Promise<Session> {
    this.persisted.push(sessionId);
    const found = this.rows.get(sessionId);
    if (!found) throw new Error(`session ${sessionId} not registered`);
    return found;
  }
}

/** 没有 agent 的那一份读数（没摆过的会话就是这个） */
const NO_AGENT: SessionPresence = {
  status: "idle",
  inputPaused: false,
  outputPaused: false,
  alive: false,
};

/** 执行者：只记「谁收到了什么」，四件事与内存消息表由用例摆 */
class FakeRunner implements PeerSessionRunner {
  readonly deliveries: Array<{ sessionId: string; input: DeliveryInput }> = [];
  /** 复活被叫过的那些会话（按发生顺序）：验「创建者先把它装起来」用 */
  readonly starts: string[] = [];
  /** 每段会话此刻的四件事（没摆过就是「没有 agent」那一份） */
  readonly presences = new Map<string, SessionPresence>();
  /** 每段会话此刻在内存里的消息（`agent.messages`）；没摆过就是 `null`（= 没有 agent 对象） */
  readonly memory = new Map<string, AgentNS.Message[]>();
  /** 让 `deliver` 抛这个错（试「目标不存在」那条） */
  failWith?: unknown;

  async start(sessionId: string): Promise<boolean> {
    this.starts.push(sessionId);
    return true;
  }

  async deliver(sessionId: string, input: DeliveryInput): Promise<{ userMessageId: string }> {
    if (this.failWith !== undefined) throw this.failWith;
    this.deliveries.push({ sessionId, input });
    return { userMessageId: `m-${this.deliveries.length}` };
  }

  state(sessionId: string): SessionPresence {
    return this.presences.get(sessionId) ?? NO_AGENT;
  }

  /** 摆一段会话此刻的四件事（只写要改的那几格：其余按「有 agent、两道闸都开着」） */
  setPresence(sessionId: string, presence: Partial<SessionPresence> = {}): SessionPresence {
    const next: SessionPresence = {
      status: "idle",
      inputPaused: false,
      outputPaused: false,
      alive: true,
      ...presence,
    };
    this.presences.set(sessionId, next);
    return next;
  }

  messagesOf(sessionId: string): AgentNS.Message[] | null {
    return this.memory.get(sessionId) ?? null;
  }
}

interface Harness {
  service: PeerSessionService;
  creator: FakeCreator;
  runner: FakeRunner;
  /** 调用方（父会话那段会话里装配出来的 agent） */
  caller: Agent;
  /** 摆一段会话的「库里那一行」与它的消息 */
  seed(sessionId: string, messages?: StoredMessage[]): void;
  /** 摆「那一段此刻在内存里说了什么」（`agent.messages`：状态与摘要都从这里现读） */
  say(sessionId: string, ...messages: AgentNS.Message[]): void;
}

function makeHarness(): Harness {
  const creator = new FakeCreator();
  const runner = new FakeRunner();
  const stored = new Map<string, StoredMessage[]>();
  const caller = new FakeAgent();

  const service = new PeerSessionService({
    sessions: {
      get: async (id) => creator.rows.get(id),
      listByLineage: async (lineage) =>
        [...creator.rows.values()]
          .filter((row) => row.lineage === lineage)
          .map((row) => ({ id: row.id })),
    },
    sessionCreator: creator,
    messages: {
      listBySession: async (sessionId) => stored.get(sessionId) ?? [],
    },
    chatRunner: runner,
  });
  service.bind(caller, PARENT_ID);

  return {
    service,
    creator,
    runner,
    caller,
    seed: (sessionId, messages = []) => {
      if (!creator.rows.has(sessionId)) {
        creator.rows.set(sessionId, session(sessionId));
      }
      stored.set(sessionId, messages);
    },
    say: (sessionId, ...messages) => {
      if (!creator.rows.has(sessionId)) {
        creator.rows.set(sessionId, session(sessionId));
      }
      runner.memory.set(sessionId, messages);
    },
  };
}

// ---------------------------------------------------------------------------
// 建：受理即回
// ---------------------------------------------------------------------------

describe("create：建会话 → 落真行 → 把第一句交出去 → 立刻回", () => {
  it("回执只有 sessionId 与 label，第一句以「父会话」为来源投进去", async () => {
    const harness = makeHarness();

    const created = await harness.service.create({
      caller: harness.caller,
      prompt: "查一下登录页",
    });

    expect(created).toEqual({ ok: true, sessionId: "c-child-1", label: "会话 1" });
    // 会话按 `session.create` 那条路开：同项目、同助手（模型交给三级解析），
    // 外加两项身份：谁开的（血缘）与自动交接开关的初值
    expect(harness.creator.created).toEqual([
      {
        workspaceId: "ws-1",
        agentId: "default",
        lineage: PARENT_ID,
        autoHandoff: true,
      },
    ]);
    // 先落真行再叫醒、再投（消息行要挂在这段会话上；投递不叫醒任何人，所以叫醒是单独那一手）
    expect(harness.creator.persisted).toEqual(["c-child-1"]);
    expect(harness.runner.starts).toEqual(["c-child-1"]);
    const delivery = harness.runner.deliveries[0]!;
    expect(delivery.sessionId).toBe("c-child-1");
    expect(delivery.input).toEqual({
      content: "查一下登录页",
      source: { kind: "agent", label: "父会话" },
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
    // 平级会话里的 agent 也登记一次：它现在是一个「平级会话」的调用方
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
      harness.runner.setPresence(`c-child-${index}`, { status: "working" });
    }

    const refused = await harness.service.create({ caller: harness.caller, prompt: "第五个" });

    expect(refused).toMatchObject({ ok: false, reason: "too_many_peers" });
    expect(harness.creator.created).toHaveLength(4);
  });

  it("闲着的平级会话不占名额（判据是现读的那一格，不是「开过几个」）", async () => {
    const harness = makeHarness();
    for (let index = 1; index <= 2; index += 1) {
      await harness.service.create({ caller: harness.caller, prompt: `活 ${index}` });
      harness.runner.setPresence(`c-child-${index}`, { status: "working" });
    }
    // 另外两段开过、但现在手上没活（一段闲着、一段输出闸关着）
    await harness.service.create({ caller: harness.caller, prompt: "闲的" });
    await harness.service.create({ caller: harness.caller, prompt: "停的" });
    harness.runner.setPresence("c-child-3");
    harness.runner.setPresence("c-child-4", { outputPaused: true });

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

  it("父会话已经不在了 → 真错误（不是一条拒绝）", async () => {
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

describe("status：四件事现读、投影成 SDK 那一格，名字用进程内那条（没有就退回会话行）", () => {
  it("会话行里没有它 → `found: false` + `status: null`（重启后 / 没见过的 id 都走这条）", async () => {
    const harness = makeHarness();
    await expect(
      harness.service.status({ caller: harness.caller, sessionId: "c-unknown" }),
    ).resolves.toEqual({ found: false, status: null });
  });

  it("会话行没了（用户删了这段会话）→ 找不到那一段，不是第五格", async () => {
    const harness = makeHarness();
    const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
    if (!created.ok) throw new Error("没建成");
    harness.creator.rows.delete(created.sessionId);

    await expect(
      harness.service.status({ caller: harness.caller, sessionId: created.sessionId }),
    ).resolves.toEqual({ found: false, status: null });
  });

  // 宿主这一侧报四件事，SDK 那个工具报两件（忙不忙 + 死活）：这里逐一验这两个字段怎么出。
  // **没有投影了** —— 四件事不再压回一格四词：输出闸关着也照旧报 `idle`（闸不对平级会话报）。
  // 「找不到这一段」不是第三种情形（它是判别式的另一支：`found: false` + `status: null`）。
  const mappings = [
    {
      label: "手上有活 → working",
      presence: { status: "working" as const },
      want: { status: "working" as const, alive: true },
    },
    {
      label: "活着且手上没活 → idle",
      presence: {},
      want: { status: "idle" as const, alive: true },
    },
    {
      label: "输出闸关着 → 还是 idle（闸不给平级会话看）",
      presence: { outputPaused: true },
      want: { status: "idle" as const, alive: true },
    },
    {
      label: "没有 agent 了 → idle + alive: false",
      presence: { alive: false },
      want: { status: "idle" as const, alive: false },
    },
  ];
  for (const mapping of mappings) {
    it(`${mapping.label}`, async () => {
      const harness = makeHarness();
      const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
      if (!created.ok) throw new Error("没建成");
      harness.runner.setPresence(created.sessionId, mapping.presence);

      const result = await harness.service.status({
        caller: harness.caller,
        sessionId: created.sessionId,
      });

      expect(result).toEqual({
        found: true,
        ...mapping.want,
        label: created.label,
        lastMessage: null,
      });
    });
  }

  it("最近一条助手消息 → `lastMessage` 是它的正文摘要", async () => {
    const harness = makeHarness();
    const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
    if (!created.ok) throw new Error("没建成");
    harness.say(
      created.sessionId,
      said(AgentNS.Role.User, "查一下登录页"),
      said(AgentNS.Role.Assistant, "查过了：表单校验没做，先补上再谈样式。"),
    );

    const result = await harness.service.status({
      caller: harness.caller,
      sessionId: created.sessionId,
    });

    // 摘要就是「它最近一句说了什么」（用户说的那句不算：那是我让它干的活）
    expect(result).toMatchObject({
      found: true,
      label: created.label,
      lastMessage: "查过了：表单校验没做，先补上再谈样式。",
    });
  });

  it("正文超 300 字 → 截到 300 字再加一个省略号（绝不给全量）", async () => {
    const harness = makeHarness();
    const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
    if (!created.ok) throw new Error("没建成");
    const long = "一".repeat(400);
    harness.say(
      created.sessionId,
      said(AgentNS.Role.User, "说个长点的"),
      said(AgentNS.Role.Assistant, long),
    );

    const result = await harness.service.status({
      caller: harness.caller,
      sessionId: created.sessionId,
    });
    if (!result.found) throw new Error("这一段该找得到");

    // 300 字正文 + 一个省略号 = 301 个字；第 301 个字以后的一个都没漏进来
    expect(result.lastMessage).toBe(`${"一".repeat(300)}…`);
    expect(result.lastMessage).toHaveLength(301);
    expect(result.lastMessage?.endsWith("…")).toBe(true);
    expect(result.lastMessage).not.toContain("一".repeat(301));
  });

  it("正文正好 300 字不动它（不让模型以为「后面还有」）", async () => {
    const harness = makeHarness();
    const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
    if (!created.ok) throw new Error("没建成");
    harness.say(created.sessionId, said(AgentNS.Role.Assistant, "二".repeat(300)));

    const result = await harness.service.status({
      caller: harness.caller,
      sessionId: created.sessionId,
    });
    if (!result.found) throw new Error("这一段该找得到");

    expect(result.lastMessage).toBe("二".repeat(300));
    expect(result.lastMessage).toHaveLength(300);
  });

  it("没有消息 / 只有用户消息 / 正文是空白 → `lastMessage: null`（它还没说过话）", async () => {
    const harness = makeHarness();
    // ① 一条消息都没有（刚建出来、话还排在队里）
    const fresh = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
    if (!fresh.ok) throw new Error("没建成");
    harness.say(fresh.sessionId);

    // ② 只有用户消息（最后一条是「我」说的，不是它说的）
    const asked = await harness.service.create({ caller: harness.caller, prompt: "再干点活" });
    if (!asked.ok) throw new Error("没建成");
    harness.say(asked.sessionId, said(AgentNS.Role.User, "干点活"));

    // ③ 有助手消息，但正文是空白（只有工具调用那一轮）
    const blank = await harness.service.create({ caller: harness.caller, prompt: "接着干" });
    if (!blank.ok) throw new Error("没建成");
    harness.say(
      blank.sessionId,
      said(AgentNS.Role.User, "接着干"),
      said(AgentNS.Role.Assistant, "   \n  "),
      said(AgentNS.Role.Assistant, [{ type: "text", text: "" }]),
    );

    for (const sessionId of [fresh.sessionId, asked.sessionId, blank.sessionId]) {
      const result = await harness.service.status({ caller: harness.caller, sessionId });
      expect(result).toMatchObject({ found: true, lastMessage: null });
    }
  });

  it("返回里只有那几格：没有 `startedAt`、没有消息数组 / 条数 / 历史", async () => {
    const harness = makeHarness();
    const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
    if (!created.ok) throw new Error("没建成");
    harness.say(
      created.sessionId,
      said(AgentNS.Role.User, "干点活"),
      said(AgentNS.Role.Assistant, "好了"),
    );

    const result = await harness.service.status({
      caller: harness.caller,
      sessionId: created.sessionId,
    });

    // 只给「忙不忙 + 死活 + 最近一句摘要」（加上那个名字）：多一格就是把对方的上下文搬过来了
    expect(Object.keys(result).sort()).toEqual([
      "alive",
      "found",
      "label",
      "lastMessage",
      "status",
    ]);
    expect("startedAt" in result).toBe(false);
    expect("messages" in result).toBe(false);
    expect("messageCount" in result).toBe(false);
    expect("history" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 接着说话：投递不看关系
// ---------------------------------------------------------------------------

describe("send：直接把这一句交出去，不看关系", () => {
  it("投给一段没有血缘的会话也照收（只投，不判「它跟我什么关系」）", async () => {
    const harness = makeHarness();
    harness.seed("c-stranger");
    harness.runner.setPresence("c-stranger");

    const result = await harness.service.send({
      caller: harness.caller,
      sessionId: "c-stranger",
      content: "帮我看看这个",
    });

    // 回执只有「收下了」：那边闲着这件事不在回执里
    expect(result).toEqual({ ok: true });
    expect(harness.runner.deliveries[0]).toEqual({
      sessionId: "c-stranger",
      input: { content: "帮我看看这个", source: { kind: "agent", label: "会话「父会话」" } },
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

    // 第 0 条是 `create` 投进去的那第一句（来源「父会话」），这一条是 `send` 投的
    expect(harness.runner.deliveries[1]!.input.source).toEqual({
      kind: "agent",
      label: `会话「${child.label}」`,
    });
  });

  // 回执不看那边忙不忙：投递那一刻能定下的只有「收下了」，状态是对未来的断言
  const presences = [
    { label: "手上有活", presence: { status: "working" as const } },
    { label: "手上没活", presence: {} },
    { label: "输出闸关着", presence: { outputPaused: true } },
  ];
  for (const variant of presences) {
    it(`回执只有「收下了」：那边${variant.label}也不带状态`, async () => {
      const harness = makeHarness();
      harness.seed("c-stranger");
      harness.runner.setPresence("c-stranger", variant.presence);

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
    harness.runner.failWith = new HostError("session_dead");

    await expect(
      harness.service.send({ caller: harness.caller, sessionId: "c-missing", content: "说一句" }),
    ).rejects.toMatchObject({ code: "session_dead" });
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
