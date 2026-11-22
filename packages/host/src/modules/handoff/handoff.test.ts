/**
 * 五条验收：交接态只落在进入的那一段上，输出闸按 SDK 那一侧的分工走（`start` 不碰、收口开、
 * 取消显式关）；后台那一趟失败也开闸并留下一条通知（成则一句话不说）；交接期间这
 * 段会话的消息照样推给客户端，但不落库 —— 收口之后恢复；换记忆之后库里与执行体里是同一份新的，
 * 且换的是数组的内容而不是数组本身。
 *
 * 自动交接那一条路另有两件：它不经 `start`，所以交接态与闸得由插件那两拍自己接上；开关关着时
 * 它一格都不碰。
 *
 * 最后一条是执行者：`start` 收到 `mode` 就把它原样递给 SDK（谁写这份文档由那一格定），不给时
 * 这一格不往下传 —— 与这一格加进来之前的那一趟是同一趟。
 *
 * 把交接态写成宿主上的一格开关，「这一段在交接」就会连带把别的段的消息写入一起停掉 —— 那几段上
 * 的人只是发现自己的回答不再落库，界面上看不出来。
 *
 * 执行体与 SDK 都是假的：真的 `Agent` 会起请求、跑循环、拉插件，真的 `migrate` 是一次完整的模型
 * 调用，而这几条要证的只有「交接态落在谁身上、闸开没开、记忆落在哪、失败收没收口」。
 *
 * **没有「降级」这一档可报**：申请哪个执行者就跑哪个，做不成就抛 —— 于是宿主这一侧只有
 * 「成了」与「失败」两种收口，没有第三种。
 */

import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { AgentNS, Message, type Agent, type OuterLoopContext } from "@ai-zen/agents-core";
import {
  AgentRuntime,
  AutoMigratePlugin,
  HandoffAbortedError,
  type HandoffContext,
  type HandoffMode,
  type RuntimeFact,
  type SdkAgent,
} from "@ai-zen/agents-sdk";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import { inboxTable } from "../agent/inbox.js";
import { HostObserver } from "../agent/observer.js";
import { AssetService } from "../asset/service.js";
import { assetTable, sessionAssetTable } from "../asset/table.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { NoticeService } from "../notice/service.js";
import { noticeTable } from "../notice/table.js";
import { QuestionRegistry } from "../question/registry.js";
import { messageTable } from "../session/messages.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { NewSession, Session } from "../session/types.js";
import { WorkspaceService } from "../workspace/service.js";
import { workspaceTable } from "../workspace/table.js";
import { HandoffService, type CreateSdkHandoff, type SdkHandoffOptions } from "./service.js";

const input: NewSession = {
  workspaceId: "ws-1",
  name: "1712345678000",
  agentId: "agent-1",
  modelId: "model-1",
  nameIsAuto: true,
  autoHandoff: false,
  lineage: null,
};

/**
 * 假执行体：只做这几处会问的事，外加让用例自己触发订阅收到的那几条事件。
 *
 * `on` 一个事件名只留一个监听者就够了：同一个执行体不会把同一件事订阅两次。
 */
function fakeAgent() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const agent = {
    state: "idle" as AgentNS.AgentState,
    messages: [] as AgentNS.Message[],
    isInputPaused: false,
    isOutputPaused: false,
    inboxPending: [],
    subAgents: [],
    start: () => Promise.resolve(),
    kill: () => {},
    on(event: string, listener: (payload: unknown) => void) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    pauseOutput: () => {
      agent.isOutputPaused = true;
    },
    resumeOutput: () => {
      agent.isOutputPaused = false;
    },
    fire(event: string, payload: unknown): void {
      listeners.get(event)?.(payload);
    },
  };
  return agent;
}

/**
 * 运行时的替身：交接只问它「这一段有没有活执行体」（`get`），观察者只从它的那条事实流上收事实
 * （`observe`）。这两格由用例喂。
 *
 * 它是一个**真的** `AgentRuntime` 实例（端口给空实现，一条路径都走不到），只把上面那两格换成
 * 用例喂的 —— 真的那一套会去造容器、读定义、建模型客户端，而这几条要证的只有「交接态落在谁
 * 身上、闸开没开、记忆落在哪、失败收没收口」。
 */
function fakeRuntime() {
  const alive = new Map<string, SdkAgent>();
  const listeners = new Set<(fact: RuntimeFact) => void>();

  const runtime = new AgentRuntime({
    openScope: () => Promise.reject(new Error("替身不造容器")),
    open: async () => ({ ok: false, reason: "model_unresolved" }),
    nameOf: async () => undefined,
  });

  // 两格换成用例喂的：登记表由 `wake` 填、事实流由 `emit` 推
  runtime.get = (sessionId) => alive.get(sessionId);
  runtime.observe = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    runtime,
    place(sessionId: string, agent: SdkAgent): void {
      alive.set(sessionId, agent);
    },
    emit(fact: RuntimeFact): void {
      for (const listener of [...listeners]) listener(fact);
    },
  };
}

/**
 * 一趟交接的替身：接住宿主造实例时递给 SDK 的那几格，结论由用例给。
 *
 * 「失败也开闸」那条要的就是一个会抛的替身；其余几条要的是「后台那一趟还没跑完时状态是什么」，
 * 所以 `migrate` 停在那里等人推。掐断也照真的来：信号响了就抛取消那个类型，它不是失败。
 *
 * `succeed` 没有任何参数：宿主不再读回「这一趟实际是谁写的」（没有降级可报了），成功就是
 * 「没抛、回来了」。
 */
function fakeHandoffs() {
  const runs: {
    readonly options: SdkHandoffOptions;
    readonly agent: SdkAgent;
    /**
     * 这一趟申请的执行者：宿主从 `start` 那一格原样递下来的。`undefined` 的意思是「调用方没挑」，
     * 由 SDK 的默认值定（`createSdkHandoff` 没建 `mode` 时是 `self`）。
     */
    readonly mode: HandoffMode | undefined;
    readonly signal: AbortSignal;
    succeed(): void;
    fail(error: unknown): void;
  }[] = [];

  const create: CreateSdkHandoff = (options) => ({
    migrate: ({ agent, mode, signal }) =>
      // 形状照真的来（`migrate` 回的就是那份 ctx 里的 `mode`），但宿主一次都不读它
      new Promise<Pick<HandoffContext, "mode">>((resolve, reject) => {
        runs.push({
          options,
          agent,
          mode,
          signal,
          succeed: () => resolve({ mode: "self" }),
          fail: reject,
        });
        signal.addEventListener("abort", () => reject(new HandoffAbortedError()), { once: true });
      }),
  });

  return { create, runs };
}

function setup() {
  const db = openDatabase(":memory:");
  const workspaceRows = workspaceTable(db);
  workspaceRows.put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });

  const t = createTranslator(() => "zh");
  const events = createBus<HostEvent>();
  const seen: HostEvent[] = [];
  events.subscribe((event) => seen.push(event));

  const messages = messageTable(db);
  const inbox = inboxTable(db);
  const sessions = new SessionService({ sessions: sessionTable(db), events, t });
  const workspaces = new WorkspaceService({ workspaces: workspaceRows, t });
  const fake = fakeRuntime();
  // 通知的日志口给一个不出声的：这几条用例验的是通知本身（写库与发事件），日志那一行由
  // `notice.test.ts` 验
  const notices = new NoticeService({
    notices: noticeTable(db),
    events,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const questions = new QuestionRegistry({ events, t });
  const handoffs = fakeHandoffs();
  const handoff = new HandoffService({
    db,
    sessions,
    workspaces,
    runtime: fake.runtime,
    notices,
    questions,
    events,
    t,
    createSdk: handoffs.create,
  });

  const errors: unknown[] = [];

  // 观察者与装配根上的那一个同形：全进程一份、挂在事实流上。它必须在第一次 `wake` 之前挂好
  // （事实只报变化，晚一步就漏掉前面那几条）—— 用例里没有真装载，但这根线的接法不变
  new HostObserver({
    messages,
    inbox,
    // 素材域：这几条用例的消息都是纯文本，引用登记不会走到写盘（`link` 只在带 `__asset_id`
    // 的段上发生），所以数据根给一个存在的目录就够
    assets: new AssetService({
      assets: assetTable(db),
      sessionAssets: sessionAssetTable(db),
      dataRoot: tmpdir(),
      t,
    }),
    events,
    onError: (error) => errors.push(error),
    isHandingOff: (id) => handoff.isHandingOff(id),
    // 交接这条路不重装：窗口永远是关的
    isReloading: () => false,
  }).attach(fake.runtime);

  /** 造一个活着的执行体，并把它放进运行时那张登记表（`get` 取到的就是它） */
  function wake(sessionId: string) {
    const agent = fakeAgent();
    fake.place(sessionId, agent as unknown as SdkAgent);
    return agent;
  }

  /**
   * 报一条「这段会话多了一条消息」。观察者听的是运行时交出来的那一條事实流（一条消息的内核事件
   * 只是其中一格），所以用例直接造那一条事实递给它 —— 与运行时转发时造的那一条同形。
   */
  function messageAdded(
    sessionId: string,
    agent: ReturnType<typeof fakeAgent>,
    id: string,
    text: string,
  ): void {
    fake.emit({
      type: "messageAdded",
      sessionId,
      agent: agent as unknown as Agent,
      seq: 1,
      at: new Date().toISOString(),
      message: message(id, text),
    });
  }

  return {
    handoff,
    handoffs,
    sessions,
    questions,
    runtime: fake.runtime,
    messages,
    notices,
    seen,
    errors,
    wake,
    messageAdded,
  };
}

/** 后台那一趟是 fire-and-forget：用例得等它把状态改完，才断言得到东西 */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function handoffEvents(seen: HostEvent[]): HostEvent[] {
  return seen.filter((event) => event.type === "session.handoff");
}

function message(id: string, text: string): AgentNS.Message {
  return new Message({
    id,
    role: AgentNS.Role.Assistant,
    status: AgentNS.MessageStatus.Completed,
    content: text,
  });
}

describe("交接态", () => {
  it("只落在进入的那一段上；`start` 不碰闸、收口开、取消关；事件一进一出", async () => {
    const { handoff, handoffs, sessions, runtime, seen, wake } = setup();
    const first = sessions.create(input);
    const second = sessions.create(input);
    wake(first.id);
    wake(second.id);

    // `start` 立刻返回：这一段进入交接态，另一段一点没动
    handoff.start(first.id);
    expect(handoff.isHandingOff(first.id)).toBe(true);
    expect(handoff.isHandingOff(second.id)).toBe(false);
    // 闸不归 `start` 管：关闸是 `HandoffGuardPlugin.onOuterLoopStart` 在指令被取走那一拍做的。
    // 这里先关上，`runSelfHandoff` 第一句就判「会话不收件」—— 那一趟整个失败（不会换成摘要）
    expect(runtime.get(first.id)?.isOutputPaused).toBe(false);
    expect(runtime.get(second.id)?.isOutputPaused).toBe(false);
    // 交接文档落在这一段所属项目里，不是宿主的 cwd：多项目共用一个目录，文档就跟代码分家了
    expect(handoffs.runs[0].options.handoffDir).toBe("/tmp/ws-1/.ai-zen/handoffs");
    expect(handoffs.runs[0].options.strategy).toBe("prune");
    expect(handoffs.runs[0].agent).toBe(runtime.get(first.id));
    // 不给 `mode`：这一格不往下递，执行者由 SDK 的默认值定（`self`）—— 与这一格加进来之前的
    // 每一趟一致。要给「独立摘要」得调用方自己开口（下一条）
    expect(handoffs.runs[0].mode).toBeUndefined();

    // 后台那一趟跑完：闸开回来、退出交接态
    handoffs.runs[0].succeed();
    await settle();
    expect(handoff.isHandingOff(first.id)).toBe(false);
    expect(runtime.get(first.id)?.isOutputPaused).toBe(false);

    // 用户按了停：闸关上、退出交接态 —— 取消之后这一段保持暂停（回滚了就不该再取件）。
    // 这一下是取消自己关的：取消可能发生在批头关闸之前，那时闸还开着
    handoff.start(first.id);
    handoff.cancel(first.id);
    await settle();
    expect(handoff.isHandingOff(first.id)).toBe(false);
    expect(runtime.get(first.id)?.isOutputPaused).toBe(true);

    expect(handoffEvents(seen)).toEqual([
      { type: "session.handoff", sessionId: first.id, handingOff: true },
      { type: "session.handoff", sessionId: first.id, handingOff: false },
      { type: "session.handoff", sessionId: first.id, handingOff: true },
      { type: "session.handoff", sessionId: first.id, handingOff: false },
    ]);
  });
});

describe("交接的执行者", () => {
  /**
   * 调用方挑了「独立摘要」，这一趟就得是摘要：宿主把这一格原样递给 SDK，SDK 照它另起一个一次性
   * 执行体去写 —— 那一个是空队列、不属于任何记忆，跑完即散。
   *
   * 逆过来的错法是安静的那种：这一格丢在路上，宿主跑的是默认的 `self`，用户挑的「独立摘要」变成
   * 这段会话自己的 agent 在写文档，而界面上两者长得一模一样。
   *
   * 「一次性执行体」是 SDK 那一侧的事，宿主这儿能验的只有那一格：递进去的 `mode` 是 `summary`。
   * 递进去的 `agent` 仍是这一段自己的 —— 摘要要读它的记忆与模型，写的那一支另起。
   */
  it("给了 `mode: summary` 就按独立摘要跑", async () => {
    const { handoff, handoffs, sessions, runtime, wake } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);

    handoff.start(session.id, "summary");

    expect(handoffs.runs[0].mode).toBe("summary");
    expect(handoffs.runs[0].agent).toBe(agent);
    expect(handoffs.runs[0].signal).toBeInstanceOf(AbortSignal);
    // 交接态照常置上：选哪种执行者不影响「这一段正在交接」这一格
    expect(handoff.isHandingOff(session.id)).toBe(true);

    // 后台那一趟跑完就收口，与自交接那条路同一份收口
    handoffs.runs[0].succeed();
    await settle();
    expect(handoff.isHandingOff(session.id)).toBe(false);
    expect(runtime.get(session.id)?.isOutputPaused).toBe(false);
  });
});

describe("后台那一趟失败", () => {
  /**
   * 失败不开闸是这整件事最贵的错：闸关着就没人取件，界面上只表现为「它不理我」，而这段时间投进
   * 来的话一直排在队列里，谁也不知道为什么。
   */
  it("开闸、退出交接态，并推一条通知", async () => {
    const { handoff, handoffs, sessions, runtime, notices, seen, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    handoff.start(session.id);
    handoffs.runs[0].fail(new Error("端点 4xx"));
    await settle();

    expect(runtime.get(session.id)?.isOutputPaused).toBe(false);
    expect(handoff.isHandingOff(session.id)).toBe(false);

    const pushed = notices.listBySession(session.id);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].level).toBe("error");
    expect(pushed[0].code).toBe("handoff_failed");
    expect(pushed[0].message).toContain("端点 4xx");

    expect(handoffEvents(seen)).toEqual([
      { type: "session.handoff", sessionId: session.id, handingOff: true },
      { type: "session.handoff", sessionId: session.id, handingOff: false },
    ]);
  });

  /** 取消不是失败：不推「交接失败」，闸也不开 —— 回滚之后就该停在那一段 */
  it("取消不推通知", async () => {
    const { handoff, handoffs, sessions, runtime, notices, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    handoff.start(session.id);
    handoff.cancel(session.id);
    await settle();

    expect(runtime.get(session.id)?.isOutputPaused).toBe(true);
    expect(notices.listBySession(session.id)).toEqual([]);
    expect(handoffs.runs[0].signal.aborted).toBe(true);
  });
});

describe("收口", () => {
  /**
   * 成了就一句话不说：闸开回来、交接态摘掉、没有通知。从前这里还有一条「降级成摘要」的警告，
   * 现在没有降级了 —— 换执行者那件事不存在，也就没有什么要告知的（`PRD.md` 3.6）。
   */
  it("成功收口不推任何通知，闸开回来、交接态摘掉", async () => {
    const { handoff, handoffs, sessions, runtime, notices, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    handoff.start(session.id);
    handoffs.runs[0].succeed();
    await settle();

    expect(notices.listBySession(session.id)).toEqual([]);
    expect(runtime.get(session.id)?.isOutputPaused).toBe(false);
    expect(handoff.isHandingOff(session.id)).toBe(false);
  });

  /**
   * SDK 报的那几种做不成（没有写文件的工具 / 不是常驻会话 / 会话不收件 / 会话已不存在 /
   * 没写出可用的文档）走的是同一条：失败通知里就是它那一句原因，一字不改。
   */
  it("做不成就是失败：原因原样进通知，没有第二种收口", async () => {
    const { handoff, handoffs, sessions, runtime, notices, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    handoff.start(session.id);
    handoffs.runs[0].fail(
      new Error(
        "Cannot write the handoff document with this session: it no longer exists (it was stopped or killed during the round), so there is nothing left to write with. No other writer was swapped in.",
      ),
    );
    await settle();

    const pushed = notices.listBySession(session.id);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].level).toBe("error");
    expect(pushed[0].code).toBe("handoff_failed");
    expect(pushed[0].message).toContain("it no longer exists");
    expect(pushed[0].durationMs).toBeNull();
    // 失败也开闸、也退交接态 —— 两者是失败那条路的一部分，不是降级
    expect(runtime.get(session.id)?.isOutputPaused).toBe(false);
    expect(handoff.isHandingOff(session.id)).toBe(false);
  });
});

describe("换记忆", () => {
  /**
   * 只落库不换内存是这整件事唯一没有红灯的那种错：库里是新记忆、模型手里还是旧的，它会带着旧
   * 记忆继续跑，直到进程重启才「好了」。
   */
  it("commit 之后库里与执行体里都是新记忆", () => {
    const { handoff, sessions, messages, wake } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);

    const prompt = Message.System("You are a test assistant.");
    const old = message("m-1", "旧记忆里的那句");
    messages.upsertMany(session.id, [old]);
    agent.messages.push(prompt, old);

    const breakpoint = new Message({
      role: AgentNS.Role.System,
      status: AgentNS.MessageStatus.Completed,
      content: "/tmp/handoff.md",
      hidden: true,
    });
    handoff.commit(session.id, [prompt, breakpoint], 1);

    // 库里：原会话只剩断点那一条（开头那条系统提示不落成行，装载时由助手定义装上）
    expect(messages.listBySession(session.id).map((item) => item.id)).toEqual([breakpoint.id]);
    // 内存里：执行体手里那一份也换成了新的，系统提示还在
    expect(agent.messages.map((item) => item.id)).toEqual([prompt.id, breakpoint.id]);
  });

  /**
   * 记忆数组已经交出去过：插件的钩子上下文、正在进行的那次请求拿的都是它。换掉数组而不是换内容，
   * 那些持有者会继续指着旧的那一份，而它们不报错。
   */
  it("replaceMessages 不改数组身份：换之前拿到的引用看到的是新内容", () => {
    const { handoff, sessions, wake } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);
    agent.messages.push(message("m-1", "旧记忆里的那句"));
    const held = agent.messages;

    const breakpoint = new Message({
      role: AgentNS.Role.System,
      status: AgentNS.MessageStatus.Completed,
      content: "/tmp/handoff.md",
      hidden: true,
    });
    handoff.commit(session.id, [breakpoint], 0);

    expect(held).toBe(agent.messages);
    expect(held.map((item) => item.id)).toEqual([breakpoint.id]);
  });
});

describe("交接期间不落库", () => {
  it("消息照样推给客户端，一行都不进库；收口之后恢复", async () => {
    const { handoff, handoffs, sessions, messages, seen, errors, wake, messageAdded } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);

    handoff.start(session.id);
    messageAdded(session.id, agent, "m-1", "这一任最后说的");

    expect(messages.get("m-1")).toBeUndefined();
    expect(seen.filter((event) => event.type === "message.added")).toHaveLength(1);

    handoffs.runs[0].succeed();
    await settle();
    messageAdded(session.id, agent, "m-2", "收口之后说的");

    expect(messages.get("m-2")?.content).toBe("收口之后说的");
    expect(errors).toEqual([]);
  });
});

/**
 * 自动那一套插件的接法：与装配时同一份（服务、阈值、开关现读、两个回声）。
 *
 * 阈值 100 配用例里那条 200 的用量，就是「越线」。
 */
function autoMigrate(handoff: HandoffService, session: Session) {
  return new AutoMigratePlugin({
    service: handoff.automatic(session),
    handoffTokens: 100,
    resolveMode: () => handoff.automaticMode(session.id),
    onMigrated: () => handoff.finish(session.id),
    onFailed: ({ error }) => handoff.finish(session.id, { error }),
  });
}

/** 一条带用量的助手消息：越线只读上一次回答的 `usage.prompt_tokens` */
function answered(promptTokens: number): AgentNS.Message {
  return new Message({
    role: AgentNS.Role.Assistant,
    status: AgentNS.MessageStatus.Completed,
    content: "上一句回答",
    usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
  });
}

describe("自动交接", () => {
  /**
   * 自动那条路不经 `start`：不置交接态的话，这一趟写下的消息会照常落库，而记忆马上被 `prune`
   * 掉 —— 库里留下的是永远读不回来的残渣。
   */
  it("自动那一趟期间消息不落库，收口之后恢复", async () => {
    const { handoff, handoffs, sessions, messages, errors, wake, messageAdded } = setup();
    const session = sessions.create({ ...input, autoHandoff: true });
    const agent = wake(session.id);
    agent.messages.push(answered(200));

    const plugin = autoMigrate(handoff, session);
    plugin.onOuterLoopStart({ agent } as unknown as OuterLoopContext);
    const idle = plugin.onIdle();
    await settle();

    expect(handoff.isHandingOff(session.id)).toBe(true);
    messageAdded(session.id, agent, "m-1", "这一任最后说的");
    expect(messages.get("m-1")).toBeUndefined();

    // 关闸那一半在 SDK 的 `HandoffGuardPlugin`（指令被取走那一拍）：这里照那一拍按住
    agent.pauseOutput();
    handoffs.runs[0].succeed();
    await idle;

    expect(handoff.isHandingOff(session.id)).toBe(false);
    expect(agent.isOutputPaused).toBe(false);

    messageAdded(session.id, agent, "m-2", "收口之后说的");
    expect(messages.get("m-2")?.content).toBe("收口之后说的");
    expect(errors).toEqual([]);
  });

  /**
   * 用户建的会话默认关（`dev-docs/prd/07-handoff.md`）：关着就不背着人动手 —— 题已经问出去了，
   * 人还没答，这一趟就不停在那里（不等一个没人答的题）。
   */
  it("`autoHandoff` 关着时这一趟等用户答复，自己不交班", async () => {
    const { handoff, handoffs, sessions, questions, wake } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);
    agent.messages.push(answered(200));

    const plugin = autoMigrate(handoff, session);
    plugin.onOuterLoopStart({ agent } as unknown as OuterLoopContext);
    void plugin.onIdle();
    await settle();

    // 问出去了一道题（开关关着），这一趟就停在这里等人答
    expect(questions.list(session.id)).toHaveLength(1);
    expect(handoffs.runs).toEqual([]);
    expect(handoff.isHandingOff(session.id)).toBe(false);

    // 开关是现读的：同一个插件还挂在同一条会话上，开关一开它就自己交班
    sessions.update(session.id, { autoHandoff: true });
    await expect(handoff.automaticMode(session.id)).resolves.toBe("self");
  });
});
