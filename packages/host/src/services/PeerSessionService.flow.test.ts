/**
 * 平级会话与**真执行者**拼起来的验收：投一句真的进那一段、真的落库，而**父对话一个字都
 * 收不到**（没有「答完把结果投回去」这回事）；问状态读的是那一段此刻的那一格。
 *
 * 为什么单独一个文件：投递落地、来源注释、四格这些事只有「真 `ChatRunner` + 真 agent +
 * 真仓储」的组合才看得见。服务自己的判断（深度、限额、拒绝、截断、来源名）在
 * `PeerSessionService.test.ts` 里钉。
 *
 * 不 sleep、不连网：假模型流的卡点是手动 resolve 的 `Deferred`。
 */

import { describe, expect, it } from "vitest";
import { Agent, AgentNS } from "@ai-zen/agents-core";

import { AgentRegistry } from "../runtime/AgentRegistry.js";
import { ChatRunner } from "../runtime/ChatRunner.js";
import { ScopeRegistry } from "../runtime/ScopeRegistry.js";
import {
  createFakeScope,
  FakeAgent,
  flushMicrotasks,
  ManualClock,
  RecordingMessageStore,
  type FakeRound,
} from "../runtime/TestSupport.js";
import type { Conversation } from "../storage/types.js";
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
    // v4 的四列：用用例摆出来的都是「用户建的那一侧」（阈值跟模型走、开关关、没血缘）
    handoffThreshold: null,
    guardThreshold: null,
    autoHandoff: false,
    lineage: null,
    // 待交接：刚建出来 / 没答过交接题，没有待办
    pendingHandoff: null,
    nameIsAuto: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 血缘反查（执行者那边只有会话行，没有进程内记录） */
function childrenOf(rows: Map<string, Conversation>, lineage: string): { id: string }[] {
  return [...rows.values()].filter((row) => row.lineage === lineage).map((row) => ({ id: row.id }));
}

/**
 * 子会话的诞生：与 `conversation.create` 一样把新会话登记进「库里」（执行者只认那一行）。
 *
 * id 从 `c-child-1` 开始按序给：用例要靠它提前把那一段叫起来（见 {@link Harness.warmUp}）。
 */
class RegisteringCreator implements PeerSessionConversationCreator {
  readonly created: ConversationCreateParams[] = [];
  private seq = 0;
  constructor(private readonly rows: Map<string, Conversation>) {}

  async create(params: ConversationCreateParams & { lineage: string; autoHandoff: boolean }): Promise<ConversationCreateResult> {
    this.created.push(params);
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
    const row = this.rows.get(conversationId);
    if (!row) throw new Error(`conversation ${conversationId} not registered`);
    return row;
  }
}

interface Harness {
  service: PeerSessionService;
  runner: ChatRunner;
  store: RecordingMessageStore;
  /** 每一段会话装配出来的 agent（假模型那一侧的可观测件：发过几次请求、此刻哪一格） */
  agents: Map<string, FakeAgent>;
  caller: Agent;
  /**
   * 把 `c-child-1` 这一段先叫起来（落一行、装配出 agent、落一句「热身」并等它闲下来）。
   *
   * **留着它只为不动下面的行数断言**：`mayStart` 到位之后，`create` 自己就能把刚建出来的那段
   * 叫起来，这一步已经不是必需的。
   */
  warmUp(): Promise<void>;
  /** 把后台的写库推进到「没有立即的后续」为止 */
  flush(): Promise<void>;
  /** 把一段会话从「库里」删掉（用户删了它：会话行不再在了） */
  drop(conversationId: string): void;
  waitFor(check: () => boolean): Promise<void>;
  /** 某段对话主线的行 */
  rows(conversationId: string): Promise<Array<{ role: string; content: unknown }>>;
}

function makeHarness(rounds: FakeRound[]): Harness {
  const clock = new ManualClock();
  const store = new RecordingMessageStore();
  const rows = new Map<string, Conversation>();
  rows.set(PARENT_ID, conversation(PARENT_ID, { name: "父对话" }));
  const { scope } = createFakeScope("/tmp/ai-zen-peers");
  const scopes = new ScopeRegistry({ createScope: async () => scope });
  const agents = new Map<string, FakeAgent>();
  const caller = new FakeAgent();

  const registry = new AgentRegistry({
    scopes,
    createAgent: async (context) => {
      const agent = new FakeAgent(rounds);
      agents.set(context.conversationId, agent);
      return agent;
    },
  });

  const runner = new ChatRunner({
    messages: store,
    conversations: { get: async (id) => rows.get(id) },
    scopes,
    agents: registry,
    emit: () => undefined,
    clock,
    streamWriteIntervalMs: 0,
  });

  const service = new PeerSessionService({
    conversations: {
      get: async (id) => rows.get(id),
      listByLineage: async (lineage) => childrenOf(rows, lineage),
    },
    conversationCreator: new RegisteringCreator(rows),
    messages: { listByConversation: (conversationId) => store.listByConversation(conversationId) },
    chatRunner: runner,
  });
  service.bind(caller, PARENT_ID);

  const harness: Harness = {
    service,
    runner,
    store,
    agents,
    caller,
    flush: async () => {
      for (let index = 0; index < 20; index += 1) await flushMicrotasks();
    },
    drop: (conversationId) => {
      rows.delete(conversationId);
    },
    waitFor: async (check) => {
      for (let index = 0; index < 200; index += 1) {
        if (check()) return;
        await flushMicrotasks();
      }
      throw new Error("条件没有到达");
    },
    rows: async (conversationId) => {
      const stored = await store.listByConversation(conversationId);
      return stored.map((row) => ({ role: row.role, content: row.content }));
    },
    warmUp: async () => {
      rows.set("c-child-1", conversation("c-child-1"));
      await runner.deliver("c-child-1", {
        content: "热身",
        source: { kind: "user" },
        mayStart: true,
      });
      await harness.waitFor(() => {
        const now = runner.state("c-child-1");
        return now.status === "idle" && now.inbox.length === 0;
      });
      await harness.flush();
    },
  };
  return harness;
}

describe("建完之后第一句真的进那一段；父对话一个字都收不到", () => {
  it("子会话落了「来自 父对话」的一句与它自己的回答；父对话没有新消息", async () => {
    const harness = makeHarness([{ deltas: [{ content: "登录页查过了" }] }]);
    await harness.warmUp();

    const created = await harness.service.create({
      caller: harness.caller,
      prompt: "查一下登录页",
    });
    if (!created.ok) throw new Error("没建成");
    await harness.waitFor(() => {
      const now = harness.runner.state(created.sessionId);
      return now.status === "idle" && now.inbox.length === 0;
    });
    await harness.flush();

    const childRows = await harness.rows(created.sessionId);
    // 「热身」一句 + 它的回答，然后是这一次投进去的那一句 + 它的回答
    expect(childRows.map((row) => row.role)).toEqual([
      AgentNS.Role.User,
      AgentNS.Role.Assistant,
      AgentNS.Role.User,
      AgentNS.Role.Assistant,
    ]);
    // 正文最前面那行来源注释由 core 拼（来源是「父对话」）
    const prompt = String(childRows[2]!.content);
    expect(prompt.split("\n\n")[0]).toMatch(/^\/\/ 这条消息来自 父对话 自动推送（.+）$/);
    expect(prompt.split("\n\n")[1]).toBe("查一下登录页");
    expect(childRows[3]!.content).toBe("登录页查过了");

    // 没有「答完把结果投回去」这回事：父对话的库里什么也没有
    expect(await harness.rows(PARENT_ID)).toEqual([]);
  });
});

describe("问状态：那一格现读", () => {
  it("它就在那儿闲着 → 答 idle（没有存下来的状态，全是现读）", async () => {
    const harness = makeHarness([{ deltas: [{ content: "回答" }] }]);
    await harness.warmUp();
    const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
    if (!created.ok) throw new Error("没建成");
    await harness.waitFor(() => {
      const now = harness.runner.state(created.sessionId);
      return now.status === "idle" && now.inbox.length === 0;
    });
    await harness.flush();

    const status = await harness.service.status({
      caller: harness.caller,
      sessionId: created.sessionId,
    });
    // 忙不忙现读，最近一句从那一段**内存里的** `agent.messages` 取（不查库）：她刚说的就是「回答」
    expect(status).toEqual({
      found: true,
      status: "idle",
      label: created.label,
      lastMessage: "回答",
    });
  });

  it("那一段的 agent 不在了（有人杀了它）→ 答 dead：会话行还在，只是没人接着跑", async () => {
    const harness = makeHarness([{ deltas: [{ content: "回答" }] }]);
    await harness.warmUp();
    const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
    if (!created.ok) throw new Error("没建成");
    await harness.waitFor(() => harness.runner.state(created.sessionId).status === "idle");
    // 硬着陆：这一段现在连 agent 对象都没有了
    harness.runner.forget(created.sessionId);

    const status = await harness.service.status({
      caller: harness.caller,
      sessionId: created.sessionId,
    });
    // 「死」是四格里的最后一格（查不到对象），不是「不在了」：会话行还在；
    // 也没有内存可读，所以最近一句是 null（会话行上的旧消息不是「它刚说的」）
    expect(status).toEqual({ found: true, status: "dead", label: created.label, lastMessage: null });
  });

  it("那一段的会话行没了（用户删了它）→ 答 `found: false`，别让调用方等一个不会来的结果", async () => {
    const harness = makeHarness([{ deltas: [{ content: "回答" }] }]);
    await harness.warmUp();
    const created = await harness.service.create({ caller: harness.caller, prompt: "干点活" });
    if (!created.ok) throw new Error("没建成");
    await harness.waitFor(() => harness.runner.state(created.sessionId).status === "idle");
    // 会话行没了：判据只剩「这一段还在不在」，`found: false` 只说这一件事
    harness.drop(created.sessionId);
    harness.runner.forget(created.sessionId);

    const status = await harness.service.status({
      caller: harness.caller,
      sessionId: created.sessionId,
    });
    expect(status).toEqual({ found: false, status: null });
  });
});

describe("接着说话：一句投进去就回，不等它答", () => {
  it("投给闲着的子会话 → 回「收下了」，这句以调用者的名字为来源落地", async () => {
    const harness = makeHarness([{ deltas: [{ content: "回答" }] }]);
    await harness.warmUp();
    const created = await harness.service.create({ caller: harness.caller, prompt: "开头" });
    if (!created.ok) throw new Error("没建成");
    await harness.waitFor(() => harness.runner.state(created.sessionId).status === "idle");
    await harness.flush();

    const sent = await harness.service.send({
      caller: harness.caller,
      sessionId: created.sessionId,
      content: "再说一句",
    });
    // 回执只有「收下了」：它忙着还是闲着、什么时候取件，都不是投递那一刻能定下的事实
    expect(sent).toEqual({ ok: true });

    await harness.waitFor(() => harness.runner.state(created.sessionId).inbox.length === 0);
    await harness.flush();
    const rows = await harness.rows(created.sessionId);
    const last = String(rows[rows.length - 2]!.content);
    expect(last.split("\n\n")[0]).toMatch(/^\/\/ 这条消息来自 会话「父对话」 自动推送（.+）$/);
    expect(last.split("\n\n")[1]).toBe("再说一句");
    // 这里仍然没有任何「把结果推回父对话」的痕迹
    expect(await harness.rows(PARENT_ID)).toEqual([]);
  });
});
