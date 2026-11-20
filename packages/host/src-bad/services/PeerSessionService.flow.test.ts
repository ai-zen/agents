/**
 * 平级会话与**真执行者**拼起来的验收：投一句真的进那一段、真的落库，而**父会话一个字都
 * 收不到**（没有「答完把结果投回去」这回事）；问状态读的是那一段此刻的那一格。
 *
 * 为什么单独一个文件：投递落地、来源注释、四件事这些事只有「真 `ChatRunner` + 真 agent +
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
import type { Session } from "../storage/types.js";
import type { SessionCreateParams, SessionCreateResult, SessionView } from "../wire/index.js";
import { HostError } from "../wire/index.js";
import { PeerSessionService } from "./PeerSessionService.js";
import type { PeerSessionSessionCreator } from "./PeerSessionService.js";

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
    // v4 的四列：用用例摆出来的都是「用户建的那一侧」（阈值跟模型走、开关关、没血缘）
    handoffThreshold: null,
    guardThreshold: null,
    autoHandoff: false,
    lineage: null,
    // 待交接：刚建出来 / 没答过交接题，没有待交接
    pendingHandoff: null,
    nameIsAuto: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 血缘反查（执行者那边只有会话行，没有进程内记录） */
function childrenOf(rows: Map<string, Session>, lineage: string): { id: string }[] {
  return [...rows.values()].filter((row) => row.lineage === lineage).map((row) => ({ id: row.id }));
}

/**
 * 平级会话的诞生：与 `session.create` 一样把新会话登记进「库里」（执行者只认那一行）。
 *
 * id 从 `c-child-1` 开始按序给：用例要靠它提前把那一段叫起来（见 {@link Harness.warmUp}）。
 */
class RegisteringCreator implements PeerSessionSessionCreator {
  readonly created: SessionCreateParams[] = [];
  private seq = 0;
  constructor(private readonly rows: Map<string, Session>) {}

  async create(
    params: SessionCreateParams & { lineage: string; autoHandoff: boolean },
  ): Promise<SessionCreateResult> {
    this.created.push(params);
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
    const row = this.rows.get(sessionId);
    if (!row) throw new Error(`session ${sessionId} not registered`);
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
   * **只为了不动下面的行数断言**（那几条要看到「热身 + 回答」在历史里）：`create` 自己会把
   * 刚建出来的那一段叫起来（它显式调了 `start`，见 PLAN §5.1）。
   */
  warmUp(): Promise<void>;
  /** 把后台的写库推进到「没有立即的后续」为止 */
  flush(): Promise<void>;
  /** 把一段会话从「库里」删掉（用户删了它：会话行不再在了） */
  drop(sessionId: string): void;
  waitFor(check: () => boolean): Promise<void>;
  /** 某段会话主线的行 */
  rows(sessionId: string): Promise<Array<{ role: string; content: unknown }>>;
}

function makeHarness(rounds: FakeRound[]): Harness {
  const clock = new ManualClock();
  const store = new RecordingMessageStore();
  const rows = new Map<string, Session>();
  rows.set(PARENT_ID, session(PARENT_ID, { name: "父会话" }));
  const { scope } = createFakeScope("/tmp/ai-zen-peers");
  const scopes = new ScopeRegistry({ createScope: async () => scope });
  const agents = new Map<string, FakeAgent>();
  const caller = new FakeAgent();

  const registry = new AgentRegistry({
    scopes,
    createAgent: async (context) => {
      const agent = new FakeAgent(rounds);
      agents.set(context.sessionId, agent);
      return agent;
    },
  });

  const runner = new ChatRunner({
    messages: store,
    abortedStrategies: () => ({ toolRounds: "fill", messages: "keep" }),
    sessions: {
      get: async (id) => rows.get(id),
      // 「库里那一行」：本文件的登记器已经在 `create` 那一刻把它放好了
      ensurePersisted: async (id) => {
        const row = rows.get(id);
        if (!row) {
          throw new HostError("not_found", { params: { entity: "session" } });
        }
        return row;
      },
    },
    scopes,
    agents: registry,
    emit: () => undefined,
    clock,
    streamWriteIntervalMs: 0,
  });

  const service = new PeerSessionService({
    sessions: {
      get: async (id) => rows.get(id),
      listByLineage: async (lineage) => childrenOf(rows, lineage),
    },
    sessionCreator: new RegisteringCreator(rows),
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
    drop: (sessionId) => {
      rows.delete(sessionId);
    },
    waitFor: async (check) => {
      for (let index = 0; index < 200; index += 1) {
        if (check()) return;
        await flushMicrotasks();
      }
      throw new Error("条件没有到达");
    },
    rows: async (sessionId) => {
      const stored = await store.listBySession(sessionId);
      return stored.map((row) => ({ role: row.message.role, content: row.message.content }));
    },
    warmUp: async () => {
      rows.set("c-child-1", session("c-child-1"));
      // 界面/创建者叫醒它的两步（PLAN §5.1）：先复活，再投递
      await runner.start("c-child-1");
      await runner.deliver("c-child-1", {
        content: "热身",
        source: { kind: "user" },
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

describe("建完之后第一句真的进那一段；父会话一个字都收不到", () => {
  it("平级会话落了「来自 父会话」的一句与它自己的回答；父会话没有新消息", async () => {
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
    // 正文最前面那行来源注释由 core 拼（来源是「父会话」）
    const prompt = String(childRows[2]!.content);
    expect(prompt.split("\n\n")[0]).toMatch(/^\/\/ 这条消息来自 父会话 自动推送（.+）$/);
    expect(prompt.split("\n\n")[1]).toBe("查一下登录页");
    expect(childRows[3]!.content).toBe("登录页查过了");

    // 没有「答完把结果投回去」这回事：父会话的库里什么也没有
    expect(await harness.rows(PARENT_ID)).toEqual([]);
  });
});

describe("问状态：忙不忙与死活都是现读", () => {
  it("它就那儿闲着 → 答 idle + alive（没有存下来的状态，全是现读）", async () => {
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
      alive: true,
      label: created.label,
      lastMessage: "回答",
    });
  });

  it("那一段的 agent 不在了（有人杀了它）→ 答 alive: false：会话行还在，只是没人接着跑", async () => {
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
    // 「没有 agent」是死活那一件事（`alive: false`），不是另一个状态值；
    // 也没有内存可读，所以最近一句是 null（会话行上的旧消息不是「它刚说的」），
    // 忙闲也无可读 —— 拿 `idle` 占位，读的人要看的是 `alive`。
    expect(status).toEqual({
      found: true,
      status: "idle",
      alive: false,
      label: created.label,
      lastMessage: null,
    });
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
  it("投给闲着的平级会话 → 回「收下了」，这句以调用者的名字为来源落地", async () => {
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
    expect(last.split("\n\n")[0]).toMatch(/^\/\/ 这条消息来自 会话「父会话」 自动推送（.+）$/);
    expect(last.split("\n\n")[1]).toBe("再说一句");
    // 这里仍然没有任何「把结果推回父会话」的痕迹
    expect(await harness.rows(PARENT_ID)).toEqual([]);
  });
});
