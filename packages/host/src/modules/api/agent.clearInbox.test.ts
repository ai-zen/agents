/**
 * `runtime.agent.clearInbox`：作废这一段还没被取走的那些 InboxEntry（`/free` 那一条命令的宿主入口）。
 *
 * 这条 procedure 的意思全在「排队区有两处」上：内存里是 Agent 的队列，库里是 `inbox` 表的那几行
 * （关掉再打开，那几句还在等，靠的就是它），而**用户看到的排队区就是库里那几行**。所以：
 *
 * - 有活 Agent 时以内存为事实：`runtime.agent.clearInbox()` 作废队列、报 `inboxCleared`，观察者据此删库行
 *   并推一条空队列 —— 这一层只借它返回的条数；
 * - 没有活 Agent 时库就是它的全部：直接数、直接删，再自己推一条空的 `agent.inbox`（那条路上没有
 *   Agent，没有别人替它说这一句）。
 *
 * 台架照 `session.transient.test.ts` 与 `handoff.test.ts`：真内存库、真 `SessionService`、真
 * `inbox` 表、**真的 `HostObserver`**（它才是「删库行 + 推客户端」那两步的执行者，换成替身就等于
 * 把要验的东西一起替掉了），只有 Agent 是假的 —— 真的 `Agent` 会起请求、跑循环、拉插件，而这两条
 * 路要证的只有「队列谁清、库行谁删、客户端听到的是什么」。
 */

import { tmpdir } from "node:os";

import { AgentNS, type Agent } from "@ai-zen/agents-core";
import { AgentRuntime, type RuntimeFact, type SdkAgent } from "@ai-zen/agents-sdk";
import { describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import { HostError } from "../../infra/errors.js";
import { inboxTable } from "../agent/inbox.js";
import { HostObserver } from "../agent/observer.js";
import { AssetService } from "../asset/service.js";
import { assetTable, sessionAssetTable } from "../asset/table.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { messageTable } from "../session/messages.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { SessionRecord } from "../session/types.js";
import { workspaceTable } from "../workspace/table.js";
import { agentRouter } from "./agent.js";
import type { HostApiDeps } from "./deps.js";
import { createTrpc } from "./trpc.js";

const WORKSPACE_ID = "ws-1";

/**
 * 假 Agent：这条路上只用到三格 —— 内存队列（`inboxPending`）、往里放一条、以及 `clearInbox()`。
 *
 * `clearInbox()` 照内核那一条来（`Agent.clearInbox`）：作废队列、报 `inboxCleared`、把丢掉的
 * InboxEntry 交回去。报事件这一下不能省 —— 观察者听的就是它，删库行与推客户端都挂在它上面。
 */
function fakeAgent(sessionId: string, emit: (fact: RuntimeFact) => void) {
  /** 内存里的队列：与真队列一样是个会被清掉内容的数组（`inboxPending` 拿的就是它本身） */
  const pending: AgentNS.InboxEntry[] = [];

  const agent = {
    inboxPending: pending,
    push(entry: AgentNS.InboxEntry): void {
      pending.push(entry);
    },
    clearInbox(): AgentNS.InboxEntry[] {
      const cleared = pending.splice(0, pending.length);
      if (cleared.length) {
        // 与运行时转发时造的那一条同形：内核事件那三格（谁发的、第几条、什么时候）原样带上
        emit({
          type: "inboxCleared",
          sessionId,
          agent: agent as unknown as Agent,
          seq: 1,
          at: new Date().toISOString(),
          entries: cleared,
        });
      }
      return cleared;
    },
  };

  return agent;
}

type FakeAgent = ReturnType<typeof fakeAgent>;

/**
 * 这一条路上的几个域。`runtime` 是真的 `AgentRuntime` 实例（端口给空实现，一条路径都走不到），
 * 只把 `get` / `observe` 两格换成用例喂的 —— 与 `handoff.test.ts` 同一个接法。
 */
function setup() {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: WORKSPACE_ID, name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });

  const t = createTranslator(() => "zh");
  const events = createBus<HostEvent>();
  /** 客户端那一侧收到的东西：用例断言的就是这一串 */
  const seen: HostEvent[] = [];
  events.subscribe((event) => seen.push(event));

  const messages = messageTable(db);
  const inbox = inboxTable(db);
  const sessions = new SessionService({ sessions: sessionTable(db), events, t });

  const alive = new Map<string, SdkAgent>();
  const listeners = new Set<(fact: RuntimeFact) => void>();
  const runtime = new AgentRuntime({
    openScope: () => Promise.reject(new Error("替身不造容器")),
    open: async () => ({ ok: false, reason: "model_unresolved" }),
    nameOf: async () => undefined,
  });
  // 两格换成用例喂的：登记表由 `wake` 填、事实流由 Agent 的 `clearInbox` 推
  runtime.get = (sessionId) => alive.get(sessionId);
  runtime.observe = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const errors: unknown[] = [];
  /** 观察者与装配根上的那一个同形：全进程一份、挂在事实流上 */
  new HostObserver({
    messages,
    inbox,
    // Asset 域：这几条用例的 InboxEntry 都是纯文本，引用登记不会走到写盘，所以数据根给一个存在的目录就够
    assets: new AssetService({
      assets: assetTable(db),
      sessionAssets: sessionAssetTable(db),
      dataRoot: tmpdir(),
      t,
    }),
    events,
    onError: (error) => errors.push(error),
    suppressesPersist: () => false,
    // 这条路上没有重装：窗口永远是关的（重装那一支由 `reload.inbox.test.ts` 验）
    isReloading: () => false,
    touchSession: () => {},
  }).attach(runtime);

  /**
   * 这一条 procedure 只用 `sessions`（认行）、`runtime`（有活物吗）、`inbox`（库里那几行）与
   * `events`（推客户端）四格，其余域整份转成 `HostApiDeps`：补齐它们得先编出七八个与本题无关的
   * 替身，那些替身一格都不会被走到。
   */
  const deps = { sessions, messages, inbox, events, runtime, t } as unknown as HostApiDeps;

  const api = createTrpc(t);
  const router = api.router({ runtime: api.router({ agent: agentRouter(deps, api) }) });
  const caller = router.createCaller({});

  function newSession(): SessionRecord {
    return sessions.create({
      workspaceId: WORKSPACE_ID,
      name: "1712345678000",
      nameSource: "default",
      agentId: "agent-1",
      modelId: "model-1",
      autoHandoff: false,
      lineage: null,
    });
  }

  /** 让这一段现在活着一个 Agent，并把它放进运行时那张登记表（`get` 取到的就是它） */
  function wake(sessionId: string): FakeAgent {
    const agent = fakeAgent(sessionId, (fact) => {
      for (const listener of [...listeners]) listener(fact);
    });
    alive.set(sessionId, agent as unknown as SdkAgent);
    return agent;
  }

  /**
   * 往排队区放一条。真宿主上 `deliver` 就是这两步 —— 先落库，再交给 Agent；没有 Agent 时只剩
   * 前面那一步（重启之后库里那几行就是这一段排队区的全部）。
   */
  function enqueue(sessionId: string, messageId: string, agent?: FakeAgent): void {
    const entry: AgentNS.InboxEntryWithContent & { messageId: string } = {
      messageId,
      createdAt: new Date().toISOString(),
      priority: "high",
      source: { kind: "user" },
      content: messageId,
    };
    inbox.insert(sessionId, entry);
    agent?.push(entry);
  }

  return { db, inbox, errors, seen, caller, runtime, newSession, wake, enqueue };
}

type Host = ReturnType<typeof setup>;

/** 客户端收到的「排队区变了」那几条 */
function inboxEvents(seen: HostEvent[]): HostEvent[] {
  return seen.filter((event) => event.type === "agent.inbox");
}

/**
 * 这一次调用抛出的是哪个 `HostError`。tRPC 把 resolver 抛出的原始错误放在 `cause` 里（出网那一层
 * 换成 tRPC 自己的码），所以码要从 `cause` 上读。
 */
async function hostErrorOf(call: Promise<unknown>): Promise<HostError> {
  try {
    await call;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof HostError) return cause;
    throw error;
  }
  throw new Error("这一次调用没有抛错");
}

describe("清排队区", () => {
  it("有活Agent：队列清空、库里那几行也没了、回的是条数", async () => {
    const host = setup();
    const session = host.newSession();
    const agent = host.wake(session.id);
    // 两条在等：库里有行、内存里也排着 —— 真宿主上它们本来就是同一批的两份
    host.enqueue(session.id, "m-1", agent);
    host.enqueue(session.id, "m-2", agent);
    expect(host.inbox.listBySession(session.id)).toHaveLength(2);

    const { cleared } = await host.caller.runtime.agent.clearInbox({ sessionId: session.id });

    // 回的是「清掉几条」：以内存为事实，条数就是队列丢掉的那几条
    expect(cleared).toBe(2);
    // 内存队列空了
    expect(agent.inboxPending).toEqual([]);
    // 库里那几行也没了（观察者按 `inboxCleared` 删的，不是这一层自己删的）
    expect(host.inbox.listBySession(session.id)).toEqual([]);
    // 客户端听到一条空队列：观察者推出的那一条，这一层不另说一次
    expect(inboxEvents(host.seen)).toEqual([
      { type: "agent.inbox", sessionId: session.id, inbox: [] },
    ]);
    // 两条路都不算事故：观察者一次都没报错
    expect(host.errors).toEqual([]);
  });

  it("没有活Agent：库里那几行照样清掉，并向客户端推一条空的 agent.inbox", async () => {
    const host = setup();
    const session = host.newSession();
    // 没有 Agent（重启之后所有会话都是这一种）：只有库里那几行，内存里没有队列
    host.enqueue(session.id, "m-1");
    host.enqueue(session.id, "m-2");

    const { cleared } = await host.caller.runtime.agent.clearInbox({ sessionId: session.id });

    // 条数是数出来的那几行
    expect(cleared).toBe(2);
    expect(host.inbox.listBySession(session.id)).toEqual([]);
    // 这条路上没有 Agent，没有别人替它说「队列空了」：这一层自己推，且只推这一条
    expect(inboxEvents(host.seen)).toEqual([
      { type: "agent.inbox", sessionId: session.id, inbox: [] },
    ]);
    expect(host.errors).toEqual([]);
  });

  it("会话不存在 → not_found", async () => {
    const host = setup();

    const error = await hostErrorOf(
      host.caller.runtime.agent.clearInbox({ sessionId: "没有这一段" }),
    );

    // 与别的 procedure 同一句词、同一个结构化事实
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("找不到 id 为 没有这一段 的会话");
    expect(error.details).toEqual({ entity: "session", sessionId: "没有这一段" });
    // 没有这一段，就没有「它的排队区」：一个字都没动、一句也没往客户端说
    expect(inboxEvents(host.seen)).toEqual([]);
  });
});
