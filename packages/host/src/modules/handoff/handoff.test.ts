/**
 * 五条验收：交接态只落在进入的那一段上，输出开关按 SDK 那一侧的分工走（`start` 不碰、收口开、
 * 取消显式关）；后台那一趟失败也开开关并留下一条通知（成则一句话不说）；换手那一档交接期间这段会话
 * 的消息照样推给客户端，但不落库 —— 收口之后恢复；换记忆之后库里与 Agent 里是同一份新的，且换的是
 * 数组的内容而不是数组本身。
 *
 * 只写文档那一档另有三件：交接回合照常落库（内存与库逐条一致，重启读回来也是同一份）、取消之后
 * 两边仍一致、记忆与存档会话都不动。
 *
 * 自动交接那一条路另有两件：它不经 `start`，所以交接态与开关得由插件那两拍自己接上；开关关着时
 * 它一格都不碰。
 *
 * 最后一条是执行者：`start` 收到 `mode` 就把它原样递给 SDK（谁写这份文档由那一格定），不给时
 * 这一格不往下传 —— 与这一格加进来之前的那一趟是同一趟。
 *
 * 把交接态写成宿主上的一格开关，「这一段在交接」就会连带把别的段的消息写入一起停掉 —— 那几段上
 * 的人只是发现自己的回答不再落库，界面上看不出来。
 *
 * Agent 与 SDK 都是假的：真的 `Agent` 会起请求、跑循环、拉插件，真的 `migrate` 是一次完整的模型
 * 调用，而这几条要证的只有「交接态落在谁身上、开关开没开、记忆落在哪、失败收没收口」。
 *
 * **没有「降级」这一档可报**：申请哪个执行者就跑哪个，做不成就抛 —— 于是宿主这一侧只有
 * 「成了」与「失败」两种收口，没有第三种。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
import type { FormRequest } from "../question/types.js";
import { messageTable } from "../session/messages.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { NewSession, SessionRecord } from "../session/types.js";
import { WorkspaceService } from "../workspace/service.js";
import { workspaceTable } from "../workspace/table.js";
import { HandoffService, type CreateSdkHandoff, type SdkHandoffOptions } from "./service.js";

const input: NewSession = {
  workspaceId: "ws-1",
  name: "1712345678000",
  agentId: "agent-1",
  modelId: "model-1",
  nameSource: "default",
  autoHandoff: false,
  lineage: null,
};

/**
 * 假 Agent：只做这几处会问的事，外加让用例自己触发订阅收到的那几条事件。
 *
 * `on` 一个事件名只留一个监听者就够了：同一个 Agent 不会把同一件事订阅两次。
 */
function fakeAgent() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const agent = {
    state: "idle" as AgentNS.AgentState,
    messages: [] as AgentNS.Message[],
    /** 换记忆那一路要数「开头有几条是 AgentDefinition 带来的系统提示」，假件也得有这一格 */
    definition: { messages: [] as AgentNS.Message[] },
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
 * 运行时的替身：交接只问它「这一段有没有活 Agent」（`get`），观察者只从它的那条事实流上收事实
 * （`observe`）。这两格由用例喂。
 *
 * 它是一个**真的** `AgentRuntime` 实例（端口给空实现，一条路径都走不到），只把上面那两格换成
 * 用例喂的 —— 真的那一套会去造容器、读定义、建模型客户端，而这几条要证的只有「交接态落在谁
 * 身上、开关开没开、记忆落在哪、失败收没收口」。
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
 * 「失败也开开关」那条要的就是一个会抛的替身；其余几条要的是「后台那一趟还没跑完时状态是什么」，
 * 所以 `migrate` 停在那里等人推。掐断也照真的来：信号响了就抛取消那个类型，它不是失败。
 *
 * `succeed` 没有任何参数：宿主不再读回「这一趟实际是谁写的」（没有降级可报了），成功就是
 * 「没抛、回来了」。
 */
/** 一趟交接的替身记下来的那几格 */
interface FakeHandoffRun {
  readonly options: SdkHandoffOptions;
  readonly agent: SdkAgent;
  /**
   * 这一趟申请的执行者：宿主从 `start` 那一格原样递下来的。`undefined` 的意思是「调用方没挑」，
   * 由 SDK 的默认值定（`createSdkHandoff` 没建 `mode` 时是 `self`）。
   */
  readonly mode: HandoffMode | undefined;
  readonly signal: AbortSignal;
  /**
   * 宿主调的是 SDK 的哪个方法：只写文档那一档调 `handoff`，换手那一档调 `migrate`。
   *
   * 两档在宿主这一侧的差别全在这一点上，所以它得是一条可断言的事实，而不是靠"文档写没写"推。
   */
  readonly method: "handoff" | "migrate";
  /** 写出来的文档路径（只有 `handoff` 那一档有，`undefined` 说明还没跑完） */
  written?: string;
  succeed(): void;
  /** 照真的 `migrate` 来：算好的记忆交给宿主那个接缝，然后才返回 */
  succeedWithMemory(memory: readonly AgentNS.Message[]): void;
  fail(error: unknown): void;
}

function fakeHandoffs() {
  const runs: FakeHandoffRun[] = [];

  /** 这一档写出来的文件名：固定一个值，断言时不必去猜时间戳 */
  const FILE = "20260101-000000.md";

  const create: CreateSdkHandoff = (options) => ({
    handoff: ({ agent, mode, signal }) =>
      new Promise<HandoffContext>((resolve, reject) => {
        const run: FakeHandoffRun = {
          options,
          agent,
          mode,
          signal,
          method: "handoff",
          succeed: () => {
            // 真的把文档写出来："落在项目的 handoffs 下"与"通知里的路径"必须是同一个文件
            mkdirSync(options.handoffDir, { recursive: true });
            const handoffPath = join(options.handoffDir, FILE);
            writeFileSync(handoffPath, "# 交接文档\n\n正文。\n", "utf8");
            run.written = handoffPath;
            resolve({
              agent,
              mode: mode ?? "self",
              requestedMode: mode ?? "self",
              handoffPath,
              model: "fake-model",
              // 交接回合开始之前的条数：照 SDK 那个形状填，宿主不拿它动记忆（交接回合照常落库）
              messageCountBefore: agent.messages.length,
              historyText: "",
            });
          },
          succeedWithMemory: () => {
            throw new Error("只写文档那一档不换记忆");
          },
          fail: reject,
        };
        runs.push(run);
        signal.addEventListener("abort", () => reject(new HandoffAbortedError()), { once: true });
      }),

    migrate: ({ agent, mode, signal }) =>
      // 形状照真的来（`migrate` 回的就是那份 ctx 里的 `mode`），但宿主一次都不读它
      new Promise<Pick<HandoffContext, "mode">>((resolve, reject) => {
        const run: FakeHandoffRun = {
          options,
          agent,
          mode,
          signal,
          method: "migrate",
          succeed: () => resolve({ mode: "self" }),
          succeedWithMemory: (memory: readonly AgentNS.Message[]) => {
            // 接缝是真的那一份：真的 `migrate` 先把它交出去，再返回。`commit` 是同步的，
            // 所以先调再接回就是真的那个次序
            options.commitMemory?.({
              memory: [...memory],
              handoffPath: join(options.handoffDir, FILE),
              mode: mode ?? "self",
            });
            resolve({ mode: "self" });
          },
          fail: reject,
        };
        runs.push(run);
        signal.addEventListener("abort", () => reject(new HandoffAbortedError()), { once: true });
      }),
  });

  return { create, runs, FILE };
}

/**
 * 每个用例自己收拾临时项目目录：断言失败时也不留（`rmSync` 带 `force`，目录没造出来也不报）。
 */
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function setup(dbFile = ":memory:") {
  const db = openDatabase(dbFile);
  const workspaceRows = workspaceTable(db);
  // 项目目录是真的：交接文档要真的写到它下面，路径也得从它算
  const cwd = mkdtempSync(join(tmpdir(), "handoff-ws-"));
  tempDirs.push(cwd);
  workspaceRows.put({ id: "ws-1", name: "项目一", cwd, createdAt: 1 });

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
    messages,
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
    // Asset 域：这几条用例的消息都是纯文本，引用登记不会走到写盘（`link` 只在带 `__asset_id`
    // 的段上发生），所以数据根给一个存在的目录就够
    assets: new AssetService({
      assets: assetTable(db),
      sessionAssets: sessionAssetTable(db),
      dataRoot: tmpdir(),
      t,
    }),
    events,
    onError: (error) => errors.push(error),
    suppressesPersist: (id) => handoff.suppressesPersist(id),
    // 交接这条路不重装：窗口永远是关的
    isReloading: () => false,
    touchSession: () => {},
  }).attach(fake.runtime);

  /** 造一个活着的 Agent，并把它放进运行时那张登记表（`get` 取到的就是它） */
  function wake(sessionId: string) {
    const agent = fakeAgent();
    fake.place(sessionId, agent as unknown as SdkAgent);
    return agent;
  }

  /**
   * 报一条「这段会话多了一条消息」。观察者听的是运行时交出来的那一條事实流（一条消息的内核事件
   * 只是其中一格），所以用例直接造那一条事实递给它 —— 与运行时转发时造的那一条同形。
   */
  function reportMessage(
    sessionId: string,
    agent: ReturnType<typeof fakeAgent>,
    added: AgentNS.Message,
  ): void {
    fake.emit({
      type: "messageAdded",
      sessionId,
      agent: agent as unknown as Agent,
      seq: 1,
      at: new Date().toISOString(),
      message: added,
    });
  }

  function messageAdded(
    sessionId: string,
    agent: ReturnType<typeof fakeAgent>,
    id: string,
    text: string,
  ): void {
    reportMessage(sessionId, agent, message(id, text));
  }

  return {
    handoff,
    handoffs,
    sessions,
    workspaces,
    questions,
    runtime: fake.runtime,
    messages,
    inbox,
    notices,
    seen,
    errors,
    wake,
    reportMessage,
    messageAdded,
    /** 这一段会话所属项目的目录（交接文档就落在它下面） */
    cwd,
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

/** 一个字段的候选（收窄到单选枚举那一种；类型不对就是没这一格） */
function enumOf(question: FormRequest, field: string): readonly string[] | undefined {
  const found = question.requestedSchema.properties[field];
  return found !== undefined && found.type === "string" ? found.enum : undefined;
}

/** 交接那道题：一个单选枚举字段 */
const HANDOFF_FORM = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      title: "用哪种方式交接？",
      enum: ["self", "summary", "no"],
      enumNames: ["自交接", "独立交接", "不交接"],
    },
  },
  required: ["mode"],
} as const;

/** 一次「选了某一个」的作答 */
const pick = (mode: string) => ({ action: "accept" as const, content: { mode } });

describe("交接态", () => {
  it("只落在进入的那一段上；`start` 不碰开关、收口开、取消关；事件一进一出", async () => {
    const { handoff, handoffs, sessions, runtime, seen, wake, cwd } = setup();
    const first = sessions.create(input);
    const second = sessions.create(input);
    wake(first.id);
    wake(second.id);

    // `start` 立刻返回：这一段进入交接态，另一段一点没动
    handoff.start(first.id);
    expect(handoff.isHandingOff(first.id)).toBe(true);
    expect(handoff.isHandingOff(second.id)).toBe(false);
    // 开关不归 `start` 管：关开关是 `HandoffGuardPlugin.onOuterLoopStart` 在指令被取走那一拍做的。
    // 这里先关上，`runSelfHandoff` 第一句就判「会话不收件」—— 那一趟整个失败（不会换成摘要）
    expect(runtime.get(first.id)?.isOutputPaused).toBe(false);
    expect(runtime.get(second.id)?.isOutputPaused).toBe(false);
    // 交接文档落在这一段所属项目里，不是宿主的 cwd：多项目共用一个目录，文档就跟代码分家了
    expect(handoffs.runs[0].options.handoffDir).toBe(join(cwd, ".ai-zen", "handoffs"));
    expect(handoffs.runs[0].options.strategy).toBe("prune");
    expect(handoffs.runs[0].agent).toBe(runtime.get(first.id));
    // 不给 `mode`：这一格不往下递，执行者由 SDK 的默认值定（`self`）—— 与这一格加进来之前的
    // 每一趟一致。要给「独立摘要」得调用方自己开口（下一条）
    expect(handoffs.runs[0].mode).toBeUndefined();
    // 不给 `kind` 就是换手那一档：这一格加进来之前，`start` 跑的就是 `migrate`
    expect(handoffs.runs[0].method).toBe("migrate");

    // 后台那一趟跑完：开关开回来、退出交接态
    handoffs.runs[0].succeed();
    await settle();
    expect(handoff.isHandingOff(first.id)).toBe(false);
    expect(runtime.get(first.id)?.isOutputPaused).toBe(false);

    // 用户按了停：开关关上、退出交接态 —— 取消之后这一段保持暂停（回滚了就不该再取走）。
    // 这一下是取消自己关的：取消可能发生在批头关开关之前，那时开关还开着
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
   * Agent 去写 —— 那一个是空队列、不属于任何记忆，跑完即散。
   *
   * 逆过来的错法是安静的那种：这一格丢在路上，宿主跑的是默认的 `self`，用户挑的「独立摘要」变成
   * 这段会话自己的 agent 在写文档，而界面上两者长得一模一样。
   *
   * 「一次性 Agent」是 SDK 那一侧的事，宿主这儿能验的只有那一格：递进去的 `mode` 是 `summary`。
   * 递进去的 `agent` 仍是这一段自己的 —— 摘要要读它的记忆与模型，写的那一支另起。
   */
  it("给了 `mode: summary` 就按独立摘要跑", async () => {
    const { handoff, handoffs, sessions, runtime, wake } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);

    handoff.start(session.id, { mode: "summary" });

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

describe("手动那条路：没给执行者就先问一次", () => {
  /**
   * 手动敲命令与阈值撞线是两件事，但「用哪种方式交接」只有一个答案 —— 所以手动这一条也出那道题
   * （与 `automaticMode` 是**同一份**题、同一套文案）。这一组用例钉住四件事：
   *
   * - 没给 `mode` 就出题，且**出题那一刻还没开跑**（等人答）；
   * - 答什么就用什么跑；
   * - 答「不交接」就什么都不做，且**不**记成「这一段不再问」—— 那是阈值那条路的处置策略；
   * - 显式给了 `mode` 就不问：选择器只是「没指定时」的那一问。
   */
  it("没给 `mode`：先出三选题，答 self 才开跑", async () => {
    const { handoff, handoffs, sessions, questions, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    const asked = handoff.startAsked(session.id);

    // 题出来了，而这三种方式一个都还没开始：交接态没置、SDK 一次都没调
    const question = questions.list(session.id)[0];
    expect(question).toBeDefined();
    expect(enumOf(question, "mode")).toEqual(["self", "summary", "no"]);
    expect(question.blocking).toBe(false);
    expect(handoff.isHandingOff(session.id)).toBe(false);
    expect(handoffs.runs).toHaveLength(0);

    questions.answer(question.id, pick("self"));
    await asked;

    expect(handoffs.runs).toHaveLength(1);
    expect(handoffs.runs[0].mode).toBe("self");
    expect(handoff.isHandingOff(session.id)).toBe(true);
  });

  it("答「独立交接」就按 summary 跑", async () => {
    const { handoff, handoffs, sessions, questions, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    const asked = handoff.startAsked(session.id, { kind: "document" });
    questions.answer(questions.list(session.id)[0].id, pick("summary"));
    await asked;

    expect(handoffs.runs[0].mode).toBe("summary");
    // `kind` 照传：只写文档那一档是调用方开口说的，问题只问「谁去写」
    expect(handoffs.runs[0].method).toBe("handoff");
  });

  it("答「不交接」：什么都不做，也不记成「这一段不再问」", async () => {
    const { handoff, handoffs, sessions, questions, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    const asked = handoff.startAsked(session.id);
    questions.answer(questions.list(session.id)[0].id, pick("no"));
    await asked;

    expect(handoffs.runs).toHaveLength(0);
    expect(handoff.isHandingOff(session.id)).toBe(false);
    // 「不再问」是阈值那条路的处置策略（`automaticMode` 答 `no` 时把开关写成 false）；
    // 手动这一趟的「不交接」只是这一次不交 —— 下一次敲命令照样问
    expect(sessions.get(session.id)?.autoHandoff).toBe(false);
    void handoff.startAsked(session.id);
    expect(questions.list(session.id)).toHaveLength(1);
  });

  it("显式给了 `mode`：不问，直接开跑", async () => {
    const { handoff, handoffs, sessions, questions, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    handoff.startAsked(session.id, { mode: "self" });

    expect(questions.list(session.id)).toEqual([]);
    expect(handoffs.runs).toHaveLength(1);
    expect(handoffs.runs[0].mode).toBe("self");
  });

  it("判据在问之前：这一段跑不了就先拦住，一道题都不出（后台那条路只能收成通知）", async () => {
    const { handoff, sessions, questions, notices } = setup();
    // 没 `wake`：这一段没有活 Agent，交接根本无从谈起
    const session = sessions.create(input);

    // 不等结果地叫起来时，判据的拒绝只能收成一条通知 —— 变成没人接的 rejection 就是
    // 「敲了命令，什么都没发生」
    await handoff.startAsked(session.id);

    expect(questions.list(session.id)).toEqual([]);
    expect(notices.listBySession(session.id).at(-1)?.message).toContain("交接没有开始：");
  });

  it("与阈值那条共用同一道题：题挂着时，手动敲命令等的是同一句", async () => {
    const { handoff, sessions, questions, wake } = setup();
    const session = sessions.create(input);
    wake(session.id);

    // 撞线先问出去一道（自动交接关着）
    const auto = handoff.automaticMode(session.id);
    expect(questions.list(session.id)).toHaveLength(1);

    // 用户不等答复，直接敲了交接命令：不再新问一道
    const manual = handoff.startAsked(session.id);
    expect(questions.list(session.id)).toHaveLength(1);

    questions.answer(questions.list(session.id)[0].id, pick("summary"));
    await expect(auto).resolves.toBe("summary");
    await manual;
    expect(handoff.isHandingOff(session.id)).toBe(true);
  });
});

describe("后台那一趟失败", () => {
  /**
   * 失败不开开关是这整件事最贵的错：开关关着就没人取走，界面上只表现为「它不理我」，而这段时间投进
   * 来的话一直排在队列里，谁也不知道为什么。
   */
  it("开开关、退出交接态，并推一条通知", async () => {
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

  /** 取消不是失败：不推「交接失败」，开关也不开 —— 回滚之后就该停在那一段 */
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

/**
 * 两档：只写文档 / 写文档并换手。
 *
 * 这两条验的是「同一条交接态、同一个取消口，最后一步分成两件事」：只写文档那一档跑完之后，会话里
 * 的记忆没被换、没多出存档会话、Agent 的身份也没换（多出来的只有一份文档与一条带路径的通知），
 * 而它写下的那几条消息与库里逐条相等；换手那一档的记忆与存档会话才是它该有的样子。两档的取消都
 * 回到交接前，回去之后内存与库仍是同一份。
 */
describe("两档", () => {
  it("只写文档那一档：交接回合照常落库，记忆与库逐条一致；不建存档会话、不换Agent", async () => {
    const { handoff, handoffs, sessions, messages, notices, runtime, wake, cwd, reportMessage } =
      setup();
    const session = sessions.create(input);
    const agent = wake(session.id);
    // 交接前的那一份记忆：库里一条、Agent 手里也是那一条
    const old = message("m-1", "旧记忆里的那句");
    messages.upsertMany(session.id, [old]);
    agent.messages.push(old);
    const before = sessions.get(session.id);

    handoff.start(session.id, { kind: "document" });
    // 走的是 SDK 那个「只产出文档」的方法，不是换记忆那个
    expect(handoffs.runs[0].method).toBe("handoff");
    // 交接文档照样落在这一段所属项目里（两档共用一处落点）
    expect(handoffs.runs[0].options.handoffDir).toBe(join(cwd, ".ai-zen", "handoffs"));
    // 交接态照常置上：两档共用这一格
    expect(handoff.isHandingOff(session.id)).toBe(true);

    // 交接回合：指令与回执那几条，照运行时那一侧每条都报一条事实
    const round = [message("round-1", "写一份交接文档"), message("round-2", "回执：写好了")];
    for (const item of round) {
      agent.messages.push(item);
      reportMessage(session.id, agent, item);
    }
    // 交接期间就落了库：这一档不在落库抑制那一格
    expect(messages.get("round-1")).toBeDefined();

    handoffs.runs[0].succeed();
    await settle();

    // 记忆：库里那一份与 Agent 手里那一份逐条相等（条数、id、顺序），交接回合那几条也在
    const inDb = messages.listBySession(session.id).map((item) => item.id);
    expect(inDb).toEqual([old.id, "round-1", "round-2"]);
    expect(agent.messages.map((item) => item.id)).toEqual(inDb);
    // 没有多出一段「已存档_」会话，会话行一个字都没动
    expect(sessions.list(input.workspaceId).map((item) => item.name)).toEqual([session.name]);
    expect(sessions.get(session.id)).toEqual(before);
    // Agent 的身份没换：还是原来那一个对象
    expect(runtime.get(session.id)).toBe(agent);

    // 文档真的写在了项目的 handoffs 下，通知说的就是那一个路径
    const written = handoffs.runs[0].written ?? "";
    expect(written.startsWith(join(cwd, ".ai-zen", "handoffs"))).toBe(true);
    const pushed = notices.listBySession(session.id);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].level).toBe("success");
    expect(pushed[0].code).toBe("handoff_document");
    expect(pushed[0].message).toContain(written);

    // 收口与换手那一档同一份：交接态退掉、开关开回来
    expect(handoff.isHandingOff(session.id)).toBe(false);
    expect(agent.isOutputPaused).toBe(false);
  });

  /**
   * 重启读回来的是同一份：库里那一份就是内存那一份，不是「内存里有、库里没有」。
   */
  it("只写文档那一档跑完之后，另开一个读口读回来的是同一份", async () => {
    const dir = mkdtempSync(join(tmpdir(), "handoff-db-"));
    tempDirs.push(dir);
    const file = join(dir, "host.db");
    const { handoff, handoffs, sessions, wake, reportMessage } = setup(file);
    const session = sessions.create(input);
    const agent = wake(session.id);
    // 交接前的那一条：内存与库里都在
    const old = message("m-1", "旧记忆里的那句");
    agent.messages.push(old);
    reportMessage(session.id, agent, old);

    handoff.start(session.id, { kind: "document" });
    const round = [message("round-1", "写一份交接文档"), message("round-2", "回执：写好了")];
    for (const item of round) {
      agent.messages.push(item);
      reportMessage(session.id, agent, item);
    }
    handoffs.runs[0].succeed();
    await settle();

    // 另一个读口读同一个库文件：这是重启之后能读到的那一份
    const reread = messageTable(openDatabase(file));
    expect(reread.listBySession(session.id).map((item) => item.id)).toEqual(
      agent.messages.map((item) => item.id),
    );
  });

  it("只写文档那一档写不出来：走失败那条路，不降级、不换手", async () => {
    const { handoff, handoffs, sessions, messages, notices, wake } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);
    messages.upsertMany(session.id, [message("m-1", "旧记忆里的那句")]);

    handoff.start(session.id, { kind: "document" });
    handoffs.runs[0].fail(new Error("Cannot write the handoff document with this session"));

    await settle();

    // 失败那条路与换手那一档同一份：一条带原因的通知、开关开回来、交接态退掉
    const pushed = notices.listBySession(session.id);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].level).toBe("error");
    expect(pushed[0].code).toBe("handoff_failed");
    expect(pushed[0].message).toContain("Cannot write the handoff document");
    expect(agent.isOutputPaused).toBe(false);
    expect(handoff.isHandingOff(session.id)).toBe(false);
    // 记忆一个字节都没动，也没有多出一段存档会话
    expect(messages.listBySession(session.id).map((item) => item.id)).toEqual(["m-1"]);
    expect(sessions.list(input.workspaceId)).toHaveLength(1);
  });

  it("换手那一档：记忆换成新的一份，旧的那一份成为一段已存档会话", async () => {
    const { handoff, handoffs, sessions, messages, notices, wake } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);
    const prompt = Message.System("You are a test assistant.");
    agent.definition.messages.push(prompt);
    const old = message("m-1", "旧记忆里的那句");
    messages.upsertMany(session.id, [old]);
    agent.messages.push(prompt, old);

    handoff.start(session.id, { kind: "swap" });
    expect(handoffs.runs[0].method).toBe("migrate");

    // 照真的 `migrate` 来：模板那几条留着，末尾一条只带路径的断点
    const breakpoint = new Message({
      role: AgentNS.Role.System,
      status: AgentNS.MessageStatus.Completed,
      content: join(handoffs.runs[0].options.handoffDir, handoffs.FILE),
      hidden: true,
    });
    handoffs.runs[0].succeedWithMemory([prompt, breakpoint]);
    await settle();

    // 原会话换成新记忆，旧的那一份成了另一段会话：名字沿用原会话的，存档这件事由 `nameSource` 说
    expect(messages.listBySession(session.id).map((item) => item.id)).toEqual([breakpoint.id]);
    const archived = sessions.list(input.workspaceId).find((item) => item.id !== session.id);
    expect(archived?.name).toBe(session.name);
    expect(archived?.nameSource).toBe("handoff");
    // 换手那一档不推「文档写到哪」那一句：它要说的是记忆换了，而窗口里看得见
    expect(notices.listBySession(session.id)).toEqual([]);
  });

  it("两档的取消都回到交接前：交接态退掉，文档那一侧不留半截", async () => {
    const { handoff, handoffs, sessions, notices, wake } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);

    for (const kind of ["document", "swap"] as const) {
      handoff.start(session.id, { kind });
      expect(handoff.isHandingOff(session.id)).toBe(true);

      handoff.cancel(session.id);
      await settle();

      // 交接态退掉、开关留在关着的那一边（回滚之后就该停在那一段），也没有任何通知
      expect(handoff.isHandingOff(session.id)).toBe(false);
      expect(agent.isOutputPaused).toBe(true);
      expect(notices.listBySession(session.id)).toEqual([]);
      // 取消口就是那一格 `signal`：它响了，SDK 的那一趟才会把半截文档删掉
      expect(handoffs.runs.at(-1)?.signal.aborted).toBe(true);

      // 下一档接着用同一段：取消留下的暂停要先开回来，不然第二条起不来
      agent.resumeOutput();
    }
  });

  /**
   * 取消之后内存与库仍是同一份。SDK 取消时把交接回合从记忆里截回交接前的条数，于是只写文档那一档
   * 已经落过库的那几条要跟着撤 —— 留在库里就是重启之后复活几条记忆里从来没有的消息。换手那一档
   * 本来一条都没进库，不用动。
   */
  it("取消之后内存与库仍然逐条一致", async () => {
    const { handoff, sessions, messages, wake, reportMessage } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);
    const old = message("m-1", "旧记忆里的那句");
    messages.upsertMany(session.id, [old]);
    agent.messages.push(old);

    // 只写文档那一档：交接回合落过库
    handoff.start(session.id, { kind: "document" });
    const documentRound = message("round-1", "写一份交接文档");
    agent.messages.push(documentRound);
    reportMessage(session.id, agent, documentRound);
    expect(messages.get("round-1")).toBeDefined();

    // 照 SDK 取消那一手：交接回合从记忆里截掉（它的收尾排在宿主的收尾之前）
    agent.messages.splice(1);
    handoff.cancel(session.id);
    await settle();

    expect(agent.messages.map((item) => item.id)).toEqual([old.id]);
    expect(messages.listBySession(session.id).map((item) => item.id)).toEqual([old.id]);
    agent.resumeOutput();

    // 换手那一档：交接回合一条都没进库，取消之后两边也是同一份
    handoff.start(session.id, { kind: "swap" });
    const swapRound = message("round-2", "写一份交接文档");
    agent.messages.push(swapRound);
    reportMessage(session.id, agent, swapRound);
    expect(messages.get("round-2")).toBeUndefined();

    agent.messages.splice(1);
    handoff.cancel(session.id);
    await settle();

    expect(agent.messages.map((item) => item.id)).toEqual([old.id]);
    expect(messages.listBySession(session.id).map((item) => item.id)).toEqual([old.id]);
  });
});

describe("收口", () => {
  /**
   * 成了就一句话不说：开关开回来、交接态摘掉、没有通知。从前这里还有一条「降级成摘要」的警告，
   * 现在没有降级了 —— 换执行者那件事不存在，也就没有什么要告知的（`PRD.md` 3.6）。
   */
  it("成功收口不推任何通知，开关开回来、交接态摘掉", async () => {
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
    // 失败也开开关、也退交接态 —— 两者是失败那条路的一部分，不是降级
    expect(runtime.get(session.id)?.isOutputPaused).toBe(false);
    expect(handoff.isHandingOff(session.id)).toBe(false);
  });
});

describe("换记忆", () => {
  /**
   * 只落库不换内存是这整件事唯一没有红灯的那种错：库里是新记忆、模型手里还是旧的，它会带着旧
   * 记忆继续跑，直到进程重启才「好了」。
   */
  it("commit 之后库里与Agent里都是新记忆", () => {
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

    // 库里：原会话只剩断点那一条（开头那条系统提示不落成行，装载时由 AgentDefinition 装上）
    expect(messages.listBySession(session.id).map((item) => item.id)).toEqual([breakpoint.id]);
    // 内存里：Agent 手里那一份也换成了新的，系统提示还在
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
  it("换手那一档：消息照样推给客户端，一行都不进库；收口之后恢复", async () => {
    const { handoff, handoffs, sessions, messages, seen, errors, wake, messageAdded } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);

    handoff.start(session.id, { kind: "swap" });
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
 * 换手那一趟丢弃的消息里，从排队区来的那几条要把 `inbox` 表里那一行一起删掉。
 *
 * `inboxTaken` 那一格的判据是「这条消息在库里吗」（写库失败过的话得留着，重启时再落一次），
 * 而换手这一批是**故意**不写 —— 判据在那里永远不成立。行留着，下次唤醒时 `materialsFor` 会照
 * 「它的消息不在历史里」把它当成还没处理的话交给 `restore()`，于是那条指令自己再跑一趟：交接
 * 文档被重写一遍、一次全量输入白烧。这一幕实际发生过（宿主重启后十几秒，agent 自发重写了一遍
 * 交接文档，还盖掉了上一次那份）。
 */
describe("换手那一趟丢弃的排队条目", () => {
  /** 排队区那一行：形状照 `send` 落库的那一份（身份就是 `messageId`） */
  function queue(
    inbox: ReturnType<typeof inboxTable>,
    sessionId: string,
    messageId: string,
    content: string,
  ): void {
    inbox.insert(sessionId, {
      messageId,
      createdAt: new Date().toISOString(),
      priority: "low",
      source: { kind: "system", label: "handoff" },
      content,
    });
  }

  /** 那条 InboxEntry 落成的 user 消息（id 就是排队行的主键） */
  function fromQueue(id: string, content: string): AgentNS.Message {
    return new Message({
      id,
      role: AgentNS.Role.User,
      status: AgentNS.MessageStatus.Completed,
      content,
      source: { kind: "system", label: "handoff" },
    });
  }

  it("换手期间取走的那一条：行在丢弃那一刻就删掉，不会留到下次唤醒", async () => {
    const { handoff, handoffs, sessions, messages, inbox, errors, wake, reportMessage } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);

    queue(inbox, session.id, "m-handoff", "写交接文档");
    handoff.start(session.id, { kind: "swap" });
    reportMessage(session.id, agent, fromQueue("m-handoff", "写交接文档"));

    // 这一批一条都不进库（换手那一档的抑制），但排队区那一行不能留着
    expect(messages.get("m-handoff")).toBeUndefined();
    expect(inbox.listBySession(session.id)).toEqual([]);
    expect(handoffs.runs[0].method).toBe("migrate");
    expect(errors).toEqual([]);
  });

  it("不在换手时落库的那一条：行不动（删行归 `inboxTaken`）", async () => {
    const { sessions, messages, inbox, errors, wake, reportMessage } = setup();
    const session = sessions.create(input);
    const agent = wake(session.id);

    queue(inbox, session.id, "m-1", "这句话还在队里");
    reportMessage(session.id, agent, fromQueue("m-1", "这句话还在队里"));

    // 消息进了库，行也还在（那一条此刻确实还排着）；它由 `inboxTaken` 在取走时删
    expect(messages.get("m-1")?.content).toBe("这句话还在队里");
    expect(inbox.listBySession(session.id).map((entry) => entry.messageId)).toEqual(["m-1"]);
    expect(errors).toEqual([]);
  });
});

/**
 * 自动那一套插件的接法：与装配时同一份（服务、阈值、开关现读、两个回声）。
 *
 * 阈值 100 配用例里那条 200 的用量，就是「越线」。
 */
function autoMigrate(handoff: HandoffService, session: SessionRecord) {
  return new AutoMigratePlugin({
    service: handoff.automatic(session),
    handoffTokens: 100,
    resolveMode: () => handoff.automaticMode(session.id),
    onMigrated: () => handoff.finish(session.id),
    onFailed: ({ error }) => handoff.finish(session.id, { error }),
  });
}

/** 一条带用量的 AgentDefinition 消息：越线只读上一次回答的 `usage.prompt_tokens` */
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

    // 关开关那一半在 SDK 的 `HandoffGuardPlugin`（指令被取走那一拍）：这里照那一拍按住
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
