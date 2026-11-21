/**
 * 五条验收：交接态只落在进入的那一段上，输出闸按 SDK 那一侧的分工走（`start` 不碰、收口开、
 * 取消显式关）；后台那一趟失败也开闸并留下一条通知；自交接降级成摘要时推一条警告；交接期间这
 * 段会话的消息照样推给客户端，但不落库 —— 收口之后恢复；换记忆之后库里与执行体里是同一份新的，
 * 且换的是数组的内容而不是数组本身。
 *
 * 自动交接那一条路另有两件：它不经 `start`，所以交接态与闸得由插件那两拍自己接上；开关关着时
 * 它一格都不碰。
 *
 * 把交接态写成宿主上的一格开关，「这一段在交接」就会连带把别的段的消息写入一起停掉 —— 那几段上
 * 的人只是发现自己的回答不再落库，界面上看不出来。
 *
 * 执行体与 SDK 都是假的：真的 `Agent` 会起请求、跑循环、拉插件，真的 `migrate` 是一次完整的模型
 * 调用，而这几条要证的只有「交接态落在谁身上、闸开没开、记忆落在哪、失败收没收口、降级报没报」。
 */

import { describe, expect, it } from "vitest";

import { AgentNS, Message, type OuterLoopContext } from "@ai-zen/agents-core";
import {
  AutoMigratePlugin,
  HandoffAbortedError,
  type HandoffMode,
  type SdkAgent,
} from "@ai-zen/agents-sdk";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import { AgentSubscription } from "../agent/subscription.js";
import { inboxTable } from "../agent/inbox.js";
import { AgentRegistry } from "../agent/registry.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { NoticeService } from "../notice/service.js";
import { noticeTable } from "../notice/table.js";
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
 * 一趟交接的替身：接住宿主造实例时递给 SDK 的那几格，结论由用例给。
 *
 * 「失败也开闸」那条要的就是一个会抛的替身；其余几条要的是「后台那一趟还没跑完时状态是什么」，
 * 所以 `migrate` 停在那里等人推。掐断也照真的来：信号响了就抛取消那个类型，它不是失败。
 *
 * `succeed` 收下这一趟**实际**用的执行者：宿主只看这一格决定要不要报降级，那件事没有第二个观察
 * 面 —— 记忆、闸、事件在降级那一趟里与正常那一趟一模一样。
 */
function fakeHandoffs() {
  const runs: {
    readonly options: SdkHandoffOptions;
    readonly agent: SdkAgent;
    readonly signal: AbortSignal;
    succeed(mode?: HandoffMode): void;
    fail(error: unknown): void;
  }[] = [];

  const create: CreateSdkHandoff = (options) => ({
    migrate: ({ agent, signal }) =>
      new Promise<{ readonly mode: HandoffMode }>((resolve, reject) => {
        runs.push({
          options,
          agent,
          signal,
          succeed: (mode = "self") => resolve({ mode }),
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
  const agents = new AgentRegistry({ sessions, workspaces, events });
  const notices = new NoticeService({ notices: noticeTable(db), events });
  const handoffs = fakeHandoffs();
  const handoff = new HandoffService({
    db,
    sessions,
    workspaces,
    agents,
    notices,
    events,
    t,
    createSdk: handoffs.create,
  });

  const errors: unknown[] = [];

  /** 造一个活着的执行体，并把真的那条订阅接在它上面 */
  function wake(sessionId: string) {
    const agent = fakeAgent();
    const sdk = agent as unknown as SdkAgent;
    agents.add(
      sessionId,
      sdk,
      new AgentSubscription(
        {
          messages,
          inbox,
          events,
          onError: (error) => errors.push(error),
          isHandingOff: (id) => handoff.isHandingOff(id),
        },
        sessionId,
        sdk,
      ),
    );
    return agent;
  }

  return { handoff, handoffs, sessions, agents, messages, notices, seen, errors, wake };
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
    const { handoff, handoffs, sessions, agents, seen, wake } = setup();
    const first = sessions.create(input);
    const second = sessions.create(input);
    wake(first.id);
    wake(second.id);

    // `start` 立刻返回：这一段进入交接态，另一段一点没动
    handoff.start(first.id);
    expect(handoff.isHandingOff(first.id)).toBe(true);
    expect(handoff.isHandingOff(second.id)).toBe(false);
    // 闸不归 `start` 管：关闸是 `HandoffGuardPlugin.onOuterLoopStart` 在指令被取走那一拍做的。
    // 这里先关上，`runSelfHandoff` 第一句就判「不收件」返回 false，整趟单向降级成摘要
    expect(agents.get(first.id)?.isOutputPaused).toBe(false);
    expect(agents.get(second.id)?.isOutputPaused).toBe(false);
    // 交接文档落在这一段所属项目里，不是宿主的 cwd：多项目共用一个目录，文档就跟代码分家了
    expect(handoffs.runs[0].options.handoffDir).toBe("/tmp/ws-1/.ai-zen/handoffs");
    expect(handoffs.runs[0].options.strategy).toBe("prune");
    expect(handoffs.runs[0].agent).toBe(agents.get(first.id));

    // 后台那一趟跑完：闸开回来、退出交接态
    handoffs.runs[0].succeed();
    await settle();
    expect(handoff.isHandingOff(first.id)).toBe(false);
    expect(agents.get(first.id)?.isOutputPaused).toBe(false);

    // 用户按了停：闸关上、退出交接态 —— 取消之后这一段保持暂停（回滚了就不该再取件）。
    // 这一下是取消自己关的：取消可能发生在批头关闸之前，那时闸还开着
    handoff.start(first.id);
    handoff.cancel(first.id);
    await settle();
    expect(handoff.isHandingOff(first.id)).toBe(false);
    expect(agents.get(first.id)?.isOutputPaused).toBe(true);

    expect(handoffEvents(seen)).toEqual([
      { type: "session.handoff", sessionId: first.id, handingOff: true },
      { type: "session.handoff", sessionId: first.id, handingOff: false },
      { type: "session.handoff", sessionId: first.id, handingOff: true },
      { type: "session.handoff", sessionId: first.id, handingOff: false },
    ]);
  });
});

describe("后台那一趟失败", () => {
  /**
   * 失败不开闸是这整件事最贵的错：闸关着就没人取件，界面上只表现为「它不理我」，而这段时间投进
   * 来的话一直排在队列里，谁也不知道为什么。
   */
  it("开闸、退出交接态，并推一条通知", async () => {
    const { handoff, handoffs, sessions, agents, notices, seen, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    handoff.start(session.id);
    handoffs.runs[0].fail(new Error("端点 4xx"));
    await settle();

    expect(agents.get(session.id)?.isOutputPaused).toBe(false);
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
    const { handoff, handoffs, sessions, agents, notices, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    handoff.start(session.id);
    handoff.cancel(session.id);
    await settle();

    expect(agents.get(session.id)?.isOutputPaused).toBe(true);
    expect(notices.listBySession(session.id)).toEqual([]);
    expect(handoffs.runs[0].signal.aborted).toBe(true);
  });
});

describe("降级", () => {
  /**
   * 申请自交接、拿回来摘要 = 降级。这一趟文档是独立摘要写的，保真度低了一档，而记忆照换、闸照
   * 开、事件一样 —— 界面上根本看不出差别。不说出来用户就永远不知道（`PRD.md` 3.6）。
   */
  it("自交接降级成摘要时推一条警告，其余照常收口", async () => {
    const { handoff, handoffs, sessions, agents, notices, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    handoff.start(session.id);
    handoffs.runs[0].succeed("summary");
    await settle();

    const pushed = notices.listBySession(session.id);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].level).toBe("warning");
    expect(pushed[0].code).toBe("handoff_degraded");
    expect(pushed[0].durationMs).toBeNull();

    // 降级不是失败：闸开回来了、交接态也摘了
    expect(agents.get(session.id)?.isOutputPaused).toBe(false);
    expect(handoff.isHandingOff(session.id)).toBe(false);
  });

  /** 申请的就是自交接、拿回来的也是自交接：没降级，不能因为「跑完了」就报一声 */
  it("自交接就是自交接时不推通知", async () => {
    const { handoff, handoffs, sessions, notices, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    handoff.start(session.id);
    handoffs.runs[0].succeed("self");
    await settle();

    expect(notices.listBySession(session.id)).toEqual([]);
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
    const { handoff, handoffs, sessions, messages, seen, errors, wake } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);

    handoff.start(session.id);
    agent.fire("messageAdded", {
      agent,
      message: message("m-1", "这一任最后说的"),
      subAgent: undefined,
      via: undefined,
    });

    expect(messages.get("m-1")).toBeUndefined();
    expect(seen.filter((event) => event.type === "message.added")).toHaveLength(1);

    handoffs.runs[0].succeed();
    await settle();
    agent.fire("messageAdded", {
      agent,
      message: message("m-2", "收口之后说的"),
      subAgent: undefined,
      via: undefined,
    });

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
    onMigrated: ({ mode }) => handoff.finish(session.id, { mode }),
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
    const { handoff, handoffs, sessions, messages, errors, wake } = setup();
    const session = sessions.create({ ...input, autoHandoff: true });
    const agent = wake(session.id);
    agent.messages.push(answered(200));

    const plugin = autoMigrate(handoff, session);
    plugin.onOuterLoopStart({ agent } as unknown as OuterLoopContext);
    const idle = plugin.onIdle();
    await settle();

    expect(handoff.isHandingOff(session.id)).toBe(true);
    agent.fire("messageAdded", {
      agent,
      message: message("m-1", "这一任最后说的"),
      subAgent: undefined,
      via: undefined,
    });
    expect(messages.get("m-1")).toBeUndefined();

    // 关闸那一半在 SDK 的 `HandoffGuardPlugin`（指令被取走那一拍）：这里照那一拍按住
    agent.pauseOutput();
    handoffs.runs[0].succeed();
    await idle;

    expect(handoff.isHandingOff(session.id)).toBe(false);
    expect(agent.isOutputPaused).toBe(false);

    agent.fire("messageAdded", {
      agent,
      message: message("m-2", "收口之后说的"),
      subAgent: undefined,
      via: undefined,
    });
    expect(messages.get("m-2")?.content).toBe("收口之后说的");
    expect(errors).toEqual([]);
  });

  /** 用户建的会话默认关（`PRD.md` 4.5）：关着就不动手 —— 那一趟既不进交接态，也不碰模型 */
  it("`autoHandoff` 关着时这一趟什么都不做", async () => {
    const { handoff, handoffs, sessions, wake } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);
    agent.messages.push(answered(200));

    const plugin = autoMigrate(handoff, session);
    plugin.onOuterLoopStart({ agent } as unknown as OuterLoopContext);
    void plugin.onIdle();
    await settle();

    expect(handoffs.runs).toEqual([]);
    expect(handoff.isHandingOff(session.id)).toBe(false);

    // 开关是现读的：同一个插件还挂在同一条会话上，开关一开它就自己交班
    sessions.update(session.id, { autoHandoff: true });
    expect(handoff.automaticMode(session.id)).toBe("self");
  });
});
