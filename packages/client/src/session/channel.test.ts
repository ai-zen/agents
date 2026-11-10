/**
 * `SessionChannel` 的用例：**对着真 daemon**（真 socket、真存档、假 Agent）。
 *
 * 为什么这一组必须真起服务端：要验的全是「连接真的断掉之后」的事 —— 旧订阅废了、事件丢了、
 * 会话在服务端还活着、新实例只能从存档把它装回来。假客户端复现不了任何一条。
 * 等待一律「轮询到条件成立」（见 `waitFor`）：断线与重连都没有确定性时机（socket 的 close、
 * 新进程的监听都依赖事件循环），固定 `sleep` 在机器一忙时就翻车。
 *
 * 三条重连不变式（设计文档 D7）逐条各一个用例：
 *   1. 在飞的那一轮不能永远挂着（空闲时断线 / 一轮中断线，两条路径）；
 *   2. 重连最多 3 次、递增退避（全失败就以连接错误失败）；
 *   3. 单飞（多个断线信号只起一次重连）。
 *
 * 另外两条来自 CLI 的边界：`dispose`（这里是 `close()`）之后不再重连；重连不新增任何
 * 用户可见文案（`notices` 全程为空）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Daemon,
  FileSessionStore,
  SessionManager,
  createSessionHandlers,
  type AgentLike,
  type CreateAgentInput,
  type ModelLevel,
} from "@ai-zen/agents-server";
import type { SessionQuestionEvent } from "@ai-zen/agents-protocol";
import { ERROR_CODES, codeOf } from "@ai-zen/agents-protocol";
import { RemoteSessions } from "../facade/sessions.js";
import { SocketServerClient } from "../socket-server-client.js";
import { ServerConnection } from "../transport/connection.js";
import type { ClientInfo } from "../types.js";
import { SessionChannel, type ChannelNoticePayload, type SessionChannelPolicy } from "./channel.js";

const clientInfo: ClientInfo = { name: "@ai-zen/agents-client", version: "0.0.0-test" };

/**
 * 假 Agent：**测试就是服务端那一侧的「模型」**。
 *
 * 用它而不是真 SDK + 假模型服务（`startFakeLlm`）：这一组要验的是客户端的时序（断线、
 * 重连、收尾），而真链路只能按它自己的节奏吐字 —— 断线必须发生在「一轮还在跑」的那一刻，
 * 那就得由用例决定 `finally` 什么时候来。`turn-and-resume.test.ts` 用真链路验的是另一件事
 * （流式与落盘），两处各司其职。
 */
class FakeAgent implements AgentLike {
  messages: any[] = [];
  lastUsage: undefined = undefined;
  modelLevel: ModelLevel = "agent";
  tools: Array<{ function?: { name?: string } }> = [];
  model = "test-model";
  modelConfig: Record<string, unknown> = {};
  definition: { messages: any[]; modelId: string; modelParams?: Record<string, unknown> } = {
    messages: [],
    modelId: "test-model",
  };
  client: unknown = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: DOC } }] }) } },
  };
  scope = { cwd: "/work/proj" };
  sent: string[] = [];
  aborted = 0;

  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  readonly events = {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      this.handlers.get(event)?.delete(handler);
    },
  };

  use(_plugin: unknown): void {}
  send(input: string): Promise<unknown> {
    this.sent.push(input);
    return Promise.resolve();
  }
  abort(): void {
    this.aborted++;
  }
  /** 手动驱动 SDK 时序 */
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

/** 交接文档正文：SDK 对「自交接」有 400 字节的有效性阈值（摘要模式不看，但两份假件用同一份数据更省事） */
const DOC = `# 交接\n\n${"- 桩\n".repeat(80)}`;

/** 「下一次要连哪个端口」：`null` = 等新 daemon 起来（断线重连期间） */
interface PortSignal {
  readonly promise: Promise<number>;
  settle: (port: number) => void;
}

function portSignal(): PortSignal {
  let settle!: (port: number) => void;
  const promise = new Promise<number>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

let dir: string;
let workspaceDir: string;
let daemon: Daemon | null = null;
let manager: SessionManager | null = null;
let agent: FakeAgent;
let connection: ServerConnection;
let channel: SessionChannel | null = null;
let notices: ChannelNoticePayload[];
let changes: number;
/** 建连**成功**的次数（单飞断言用） */
let connects: number;
/** 建连**尝试**的次数（重试次数断言用） */
let attempts: number;
/** 置上之后每次建连都失败：模拟「服务端再也没起来」 */
let failConnect: boolean;
/**
 * 「新连接该连到哪个端口」的闸门。
 *
 * 为什么要一道闸：断线重连的第一跳就在断开通知里立刻发生，而有些用例必须**先**往盘上
 * 造好状态（「断线期间跑完的那一轮」）再让它接回来 —— 否则接回来的还是旧快照，用例就
 * 变成了「等一个永远不出现的东西」。所以建连一律等这道闸，由用例决定什么时候开。
 */
let gate = portSignal();
/** `createAgent` 最近一次收到的入参（拿服务端注入的 `resolveMode`） */
let lastAgentInput: CreateAgentInput | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-channel-"));
  workspaceDir = join(dir, "proj");
  // 服务端的工作目录得真的存在（生产里它就是服务端进程的 cwd）
  mkdirSync(workspaceDir, { recursive: true });
  agent = new FakeAgent();
  notices = [];
  changes = 0;
  connects = 0;
  attempts = 0;
  failConnect = false;
  gate = portSignal();
  lastAgentInput = undefined;
  manager = newManager();
  connection = new ServerConnection({
    connect: async () => {
      attempts += 1;
      if (failConnect) throw new Error("connect refused (test)");
      const port = await gate.promise;
      const client = await SocketServerClient.connect({
        address: { host: "127.0.0.1", port },
        client: clientInfo,
      });
      connects += 1;
      return client;
    },
  });
});

afterEach(async () => {
  await channel?.close();
  channel = null;
  connection.close();
  manager?.dispose();
  manager = null;
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 一个**新的** SessionManager（同一个 `dir`、同一份存档根）：重连用例要「换一台服务端」 */
function newManager(): SessionManager {
  let counter = 0;
  return new SessionManager({
    createAgent: async (input) => {
      lastAgentInput = input;
      /**
       * 真服务端这一跳会按 `input.modelId` / `input.modelParams` **重建** Agent，快照里的
       * `modelId` / `modelParams` 就是从重建后的定义里读的（`modelIdOf` /
       * `agentModelParamsOf`）。假件不照抄这两样的话，「换完模型快照里就是新模型」永远
       * 测不出来 —— 假件永远说 `test-model`，而那正是「假件迁就实现」的另一种形状。
       */
      if (input.modelId) agent.definition.modelId = input.modelId;
      // `null` = 清掉覆盖（与「从来没设过」同一条路），所以只有真给了才抄
      if (input.modelParams == null) delete agent.definition.modelParams;
      else agent.definition.modelParams = input.modelParams as Record<string, unknown>;
      return agent;
    },
    nextSessionId: () => `chat_${++counter}`,
    storeFor: (workspaceId) =>
      new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
    // 自动迁移要用交接服务（`session-id-changed` 只从这条路上发）：不配的话服务端会回
    // `no-handoff`，而「客户端能不能跟上新 id」根本不是那一层的错
    handoff: { aiZenDir: join(dir, "ai-zen"), homeDir: dir },
  });
}

function newDaemon(): Daemon {
  return new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: createSessionHandlers({
      manager: manager!,
      workspacesRoot: join(dir, "workspaces"),
      defaultWorkspacePath: workspaceDir,
    }),
  });
}

async function startServer(): Promise<void> {
  daemon = newDaemon();
  await daemon.start();
  gate.settle(daemon.port);
}

/**
 * 服务端那侧的「断线」：停掉当前 daemon，在**同目录**起一个新的（新端口、新 SessionManager）。
 *
 * 新实例的内存里没有那段会话，只能从盘上把它装回来 —— 这正是 `session.attach` 的
 * 「盘上有就装回来」那条路，「接回原会话」才算真的被验证过。
 */
async function restartServer(): Promise<void> {
  // 关闸：重连要等用例把盘上的状态造完（见 `gate` 的注释）
  gate = portSignal();
  if (daemon) {
    await daemon.stop("test disconnect");
    daemon = null;
  }
  manager?.dispose();
  manager = newManager();
  daemon = newDaemon();
  await daemon.start();
}

/** 开闸：让断线重连连到**新的**那个 daemon 上 */
function releasePort(): void {
  gate.settle(daemon!.port);
}

/** 起服务端并开一段会话（`policy` 是应用注入的那三四个回调） */
async function open(
  policy: SessionChannelPolicy = {},
  input: { path?: string } = {},
): Promise<SessionChannel> {
  await startServer();
  channel = new SessionChannel({
    connection,
    policy: {
      onChange: (immediate) => {
        changes += 1;
        void immediate;
      },
      onNotice: (payload) => notices.push(payload),
      ...policy,
    },
  });
  await channel.open({ path: workspaceDir, agentId: "default", ...input });
  return channel;
}

/** 等到条件成立（或超时）。不固定 sleep：只等到「该发生的事」发生，不猜时长 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor: 超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 盯着一个 promise（不 await 它）：用例轮询着等它落定 */
interface Watch<T> {
  settled: boolean;
  value?: T;
  error?: Error;
}

function watch<T>(promise: Promise<T>): Watch<T> {
  const watched: Watch<T> = { settled: false };
  void promise.then(
    (value) => {
      watched.value = value;
      watched.settled = true;
    },
    (error) => {
      watched.error = error as Error;
      watched.settled = true;
    },
  );
  return watched;
}

/** 拿一条连接上的会话门面（用例要旁证服务端那一侧的状态：存档、活会话清单） */
async function sessionsOf(): Promise<RemoteSessions> {
  return new RemoteSessions(await connection.client());
}

/**
 * 服务端认定的默认工作区 → 它的存档目录（与 `SessionManager.storeFor` 同一个目录）。
 *
 * 「断线期间跑完的那一轮」只能这么造：真让服务端跑一轮它就不会是「断线期间」了。
 */
async function storeOf(workspaceId: string): Promise<FileSessionStore> {
  return new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) });
}

describe("SessionChannel：开一段会话并跑一轮", () => {
  it("快照就是屏幕的全部事实；send 拿到 turnId，waitForTurn 等收尾之后才落定", async () => {
    agent.messages = [{ role: "user", content: "上次聊到这儿" }];
    const opened = await open();
    const state = opened.stream.state;

    expect(state.sessionId).toBe("chat_1");
    expect(state.modelId).toBe("test-model");
    expect(state.modelLevel).toBe("agent");
    expect(state.messages).toEqual([{ role: "user", content: "上次聊到这儿" }]);
    expect(state.phase).toBeNull();
    expect(state.subAgents).toEqual([]);

    const turnId = await opened.send("你好");
    expect(turnId).toBe(1);
    const done = watch(opened.waitForTurn(turnId));

    // 服务端这一侧：追加用户消息 → 流式两片 → 收尾
    agent.messages.push({ role: "user", content: "你好" });
    agent.fire("chunk-parsed", {}, { choices: [{ delta: { content: "答" } }] });
    await waitFor(() => JSON.stringify(opened.stream.state.messages).includes("答"));
    expect(done.settled).toBe(false); // 还在跑：界面靠它管 busy
    // 真链路上「增量拼起来」与「最终正文」是同一串字；对不上时合并规则宁可重复也不吞字
    // （那条边界在 `stream.test.ts` 里单测）
    agent.fire("chunk-parsed", {}, { choices: [{ delta: { content: "完了" } }] });

    agent.messages.push({ role: "assistant", content: "答完了", reasoning_content: "想一想" });
    agent.fire("finally");
    await waitFor(() => done.settled);

    expect(done.error).toBeUndefined();
    expect(opened.stream.state.messages).toEqual([
      { role: "user", content: "上次聊到这儿" },
      { role: "user", content: "你好" },
      { role: "assistant", content: "答完了", reasoning_content: "想一想" },
    ]);
    expect(opened.stream.state.phase).toBeNull();
    expect(opened.stream.state.turnId).toBeNull();
    // 透明恢复口径的另一半：正常跑完也不该多出任何通知
    expect(notices).toEqual([]);
  });

  it("路径与工作区身份对外只读可查，且都是**服务端**给的那一份", async () => {
    // 调用方（CLI 的 `/new`、侧栏）要知道「这段会话落在哪个工作区」，而自己记下的那个
    // 只是「当初请求的路径」—— 规范化（相对路径、`..`、末尾斜杠）发生在服务端。
    // 这里钉住「出口给的就是服务端 `workspace.resolve` 的答案」，不是客户端又算了一遍。
    const opened = await open();
    const resolved = await (await sessionsOf()).resolveWorkspace(workspaceDir);

    expect(opened.path).toBe(resolved.path);
    expect(opened.workspaceId).toBe(resolved.workspaceId);
  });

  it("abort 转发给服务端（由服务端掐本轮），不自己造收尾", async () => {
    const opened = await open();
    await opened.send("长任务");
    await waitFor(() => agent.sent.length === 1);

    await opened.abort();
    await waitFor(() => agent.aborted === 1);
    agent.fire("finally");
    await waitFor(() => opened.stream.state.status === "idle");
  });
});

/**
 * 换一段会话时的「轮次账」。
 *
 * `waitForTurn()` 的「已收尾」判据是 `lastEndedTurn >= turnId`，而 `turnId` 是**会话内**的
 * 编号（服务端 `send()` 里 `turnId += 1`，新建 / 续接的会话都从 0 起）—— 上一段跑到第 3 轮
 * 与这一段跑第 1 轮是两个不同的坐标系。
 *
 * 为什么这条必须真起 daemon：判据错位的症状恰好是「等的东西已经存在」，假件里没有服务端的
 * 轮次计数器，复现不出来。
 */
describe("SessionChannel：换一段会话时的轮次账", () => {
  it("同一条 channel 上 open 两次：第二段的 waitForTurn(1) 真的等到这一轮收尾", async () => {
    const opened = await open();

    // 第一段跑完一轮：账上留下 lastEndedTurn = 1
    await opened.send("第一段");
    const first = watch(opened.waitForTurn(1));
    await waitFor(() => agent.sent.length === 1);
    agent.messages.push({ role: "user", content: "第一段" });
    agent.fire("finally");
    await waitFor(() => first.settled);
    expect(opened.stream.state.sessionId).toBe("chat_1");

    // 同一 channel 上换一段会话（不换 channel：通道本身没有问题，有问题的是账）
    await opened.open({ path: workspaceDir, agentId: "default" });
    expect(opened.stream.state.sessionId).toBe("chat_2");

    const turnId = await opened.send("第二段");
    // 新会话的轮次从 1 起 —— 正是这一步让上一段没清的账立即命中
    expect(turnId).toBe(1);
    const second = watch(opened.waitForTurn(turnId));

    // 服务端确实收下了这一轮（已经过了一轮事件循环，不是「还来不及 resolve」）
    await waitFor(() => agent.sent.length === 2);
    // 红点：账没清时 `1 <= lastEndedTurn(=1)` → 立刻返回，界面以为这一轮已经结束
    expect(second.settled).toBe(false);
    expect(opened.stream.state.turnId).toBe(turnId);
    expect(opened.stream.state.status).toBe("streaming");

    agent.messages.push({ role: "user", content: "第二段" });
    agent.fire("finally");
    await waitFor(() => second.settled);
    expect(second.error).toBeUndefined();
    expect(opened.stream.state.turnId).toBeNull();
  });

  /**
   * `adopt()`（`saveAs` / `migrate`）**不能**顺手清轮次账 —— 它与 `open()` 是两件事。
   *
   * 理由在服务端那一侧：`rekey` 换的是**同一个**会话对象（`turnId`、消息、holders 都跟着走），
   * `saveAs` 的注释写得很直白：「这是同一段对话换个名字，所以 `turnId` 不动」。所以：
   *   · 换键之后 `send()` 拿到的不是 1 而是 2（编号真的跟着走了）；
   *   · 换键**之前**已经收尾的那一轮，账必须还在 —— 清掉它的人会让 `waitForTurn(1)` 永久挂住
   *     （服务端那一轮确实结束了，`session-turn-end` 不会再来一遍）。
   */
  it("adopt（saveAs 换键）**不**清账：轮次编号跟着走，已收尾的那一轮仍然算数", async () => {
    const opened = await open();

    await opened.send("第一轮");
    const first = watch(opened.waitForTurn(1));
    await waitFor(() => agent.sent.length === 1);
    agent.messages.push({ role: "user", content: "第一轮" });
    agent.fire("finally");
    await waitFor(() => first.settled);

    await opened.saveAs("chat_named");
    expect(opened.sessionId).toBe("chat_named");

    // 第一轮已经结束：换键之后问它也得当场落定（清掉账的人在这里超时）
    const replayed = watch(opened.waitForTurn(1));
    await waitFor(() => replayed.settled);

    // 换键的是同一个会话对象：编号接着 1 往下数，「这一段的第 1 轮」不会重现
    const turnId = await opened.send("换键之后的第一轮");
    expect(turnId).toBe(2);
    const second = watch(opened.waitForTurn(turnId));
    await waitFor(() => agent.sent.length === 2);
    expect(second.settled).toBe(false);

    agent.messages.push({ role: "user", content: "换键之后的第一轮" });
    agent.fire("finally");
    await waitFor(() => second.settled);
    expect(second.error).toBeUndefined();
  });
});

/**
 * 会话级的模型动作（`session.model.set` / `session.modelParams.set`）。
 *
 * 它们以前只能在应用里 `new RemoteSessions(await connection.client())` 现取门面：
 * 参数拼装仍然只有包里一份，但「当前这一段是哪个 id」与「接哪条连接」两个来源在应用里
 * 又成了一个会漂的配对。接到 channel 上之后，与 `saveAs` / `rollback` 同级。
 */
describe("SessionChannel：会话级模型动作（转发，不换 id）", () => {
  it("setModel 转发 session.model.set：id 不变、返回值透传，屏幕跟着对齐", async () => {
    const opened = await open();
    const id = opened.sessionId;

    const snapshot = await opened.setModel("alt-model");

    // 不换 id（服务端只写存档的 modelId 并重建 Agent）：没走 adopt 也不能让状态机跑偏
    expect(snapshot.sessionId).toBe(id);
    expect(opened.sessionId).toBe(id);
    expect(opened.stream.state.sessionId).toBe(id);
    // 返回值透传：就是服务端那份快照（新模型名在里面）
    expect(snapshot.modelId).toBe("alt-model");
    // 顺手对齐了屏幕（否则「现在用的是哪个模型」要等到下一轮收尾才更新）
    expect(opened.stream.state.modelId).toBe("alt-model");
  });

  it("setModelParams 转发 session.modelParams.set：id 不变、返回值透传（`null` = 清覆盖）", async () => {
    const opened = await open();
    const id = opened.sessionId;

    const set = await opened.setModelParams({ reasoning_effort: "high" });
    expect(set.sessionId).toBe(id);
    expect(opened.sessionId).toBe(id);
    expect(set.modelParams).toEqual({ reasoning_effort: "high" });
    expect(opened.stream.state.modelParams).toEqual({ reasoning_effort: "high" });

    // `null` 是「清掉这一层覆盖」的合法值：不能因为它是 null 就当成「调用方没给」
    const cleared = await opened.setModelParams(null);
    expect(cleared.sessionId).toBe(id);
    expect(opened.sessionId).toBe(id);
    expect(cleared.modelParams).toBeUndefined();
  });
});

/**
 * 动作选项的**透传**。
 *
 * 这一类缺口全是同一个形状：门面上有选项、channel 上被吞掉。它比「少一个方法」更难发现 ——
 * 调用方写了 `{ setAsLast: false }` / `"omit"` 照样编译通过，行为却悄悄按缺省值发生，而
 * 缺省值恰好是「更常见的那一个」（写档就挪指针 / 迁移就换 id），所以没人会当场撞见，
 * 直到用户说「我明明只是存了一份，下一次 `ai` 怎么接到管道输出上了」。
 *
 * 所以每一条都用**服务端那一侧的事实**断言（指针 / id），不看 channel 自己的返回值 ——
 * 吞掉选项时返回值照样是 `saved: true`，那是它最容易骗人的地方。
 */
describe("SessionChannel：动作选项的透传", () => {
  it("save({ setAsLast: false })：写档，但不挪「本工作区上一轮会话」指针", async () => {
    const first = await open();
    // 缺省（`setAsLast` 不传）就是 `true`：这一段成为续接目标。它同时是下面那条断言的对照 ——
    // 没有它，「指针没变」可能只是因为指针压根没被写过
    await first.save();
    const firstId = first.sessionId;
    const workspaceId = first.workspaceId!;
    expect((await (await sessionsOf()).last(workspaceId)).sessionId).toBe(firstId);

    // 同一连接上的另一条 channel：`ai "…" --save` 这条一次性调用路径的形状
    // （它拿到的就是一条 channel，没有自己的门面）
    const second = new SessionChannel({ connection });
    await second.open({ path: workspaceDir, agentId: "default" });
    const secondId = second.sessionId;
    expect(secondId).not.toBe(firstId);

    expect(await second.save({ setAsLast: false })).toBe(secondId);

    // 档真的写了（事后翻得到）：`sessions/<id>.json` 就在盘上
    expect(existsSync(join(dir, "workspaces", workspaceId, "sessions", `${secondId}.json`))).toBe(
      true,
    );
    // 而续接指针**一点没动** —— 下次 `ai` 接的仍是用户真正聊过的那一段
    expect((await (await sessionsOf()).last(workspaceId)).sessionId).toBe(firstId);

    // 对照：同一个方法不传选项时指针会跟着走（证明上面那条不是「指针根本不动」）
    await second.save();
    expect((await (await sessionsOf()).last(workspaceId)).sessionId).toBe(secondId);

    await second.close();
  });

  it("migrate 的 strategy：`omit` 不换 id（缺省 `prune` 会换）", async () => {
    const opened = await open();
    // 真 Agent 的消息以模板（system）开头，SDK 的 `omit` 就是按「前 N 条是模板」判的
    agent.messages = [
      { role: "system", content: "模板" },
      { role: "user", content: "旧任务" },
      { role: "assistant", content: "旧答复" },
    ];
    const before = opened.sessionId;

    const handoffPath = await opened.migrate(undefined, "omit");

    // 文档真的落盘了（路径是服务端给的，不是包里拼的）
    expect(existsSync(handoffPath)).toBe(true);
    // 同一个 id：`omit` 的语义是「同一段会话、旧消息不再发送」。`strategy` 被 channel 吞掉时
    // 服务端按缺省 `prune` 走 —— 结果是**换了 id**，而调用方看不出是谁丢的。
    expect(opened.sessionId).toBe(before);
    expect(opened.stream.state.sessionId).toBe(before);
  });
});

describe("SessionChannel：断线重连的三条不变式", () => {
  it("不变式 1（空闲时断线）：接回同一段会话，屏幕由**新连接**的快照对齐", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "断线前的对话" }];
    // 落盘：新服务端的内存里没有这段会话，只能从盘上把它装回来
    await (await sessionsOf()).save(opened.sessionId);
    const sessionId = opened.sessionId;
    const workspaceId = (await (await sessionsOf()).resolveWorkspace(workspaceDir)).workspaceId;

    await restartServer();
    /**
     * 断线**之后**才落到盘上的那条：只有真的走了新连接上的 `session.snapshot` 才会出现在
     * 屏幕上 —— 本地那份是旧内存，不可能凭空长出这句话。
     */
    await (
      await storeOf(workspaceId)
    ).write({
      id: sessionId,
      agentId: "default",
      messages: [
        { role: "user", content: "断线前的对话" },
        { role: "assistant", content: "断线期间跑完的那句" },
      ],
    });
    releasePort();

    await waitFor(() => opened.stream.state.messages.length === 2);

    expect(opened.sessionId).toBe(sessionId); // 会话没变
    expect(opened.stream.state.messages).toEqual([
      { role: "user", content: "断线前的对话" },
      { role: "assistant", content: "断线期间跑完的那句" },
    ]);
    expect(opened.stream.state.phase).toBeNull();
    expect(opened.stream.state.status).toBe("idle");
    // 单飞：一次断线只起一次重连（初始建连 + 重连 = 2 次）
    expect(connects).toBe(2);
    // 透明恢复：不弹「已重连」这类通知
    expect(notices).toEqual([]);
  });

  it("不变式 1（一轮进行中断线）：服务端已空闲 → waitForTurn 当场落定，既不悬挂也不当错误", async () => {
    agent.messages = [{ role: "user", content: "上一轮" }];
    const opened = await open();
    await (await sessionsOf()).save(opened.sessionId); // 新服务端只能从盘上把它装回来

    const turnId = await opened.send("长任务");
    await waitFor(() => agent.sent.length === 1);
    const pending = watch(opened.waitForTurn(turnId));
    // 假 Agent **不** fire finally：那一轮的 session-turn-end 就丢在断线里

    await restartServer();
    releasePort();

    await waitFor(() => pending.settled);
    // 既不永远挂着（界面靠它恢复输入），也不把它当错误
    expect(pending.error).toBeUndefined();
    expect(opened.stream.state.phase).toBeNull();
    expect(opened.stream.state.turnId).toBeNull();
    // 按快照落定：屏幕上是盘上那份权威消息，不是断线前本地拼的残片
    expect(opened.stream.state.messages).toEqual([{ role: "user", content: "上一轮" }]);
    expect(notices).toEqual([]);
  });

  it("不变式 2 + 3（连不回来）：恰好试三次，在飞的那一轮以连接错误失败，状态标终态", async () => {
    const opened = await open();
    const turnId = await opened.send("长任务");
    await waitFor(() => agent.sent.length === 1);
    const pending = watch(opened.waitForTurn(turnId));

    // 断线之后**每次**建连都失败：重连必然用尽次数
    failConnect = true;
    attempts = 0;
    releasePort();
    await daemon!.stop("test disconnect");
    daemon = null;

    await waitFor(() => pending.settled);
    // 连接错误原样抛给等的人（界面据此恢复输入），不是静默悬挂
    expect(pending.error?.message).toMatch(/connection closed/);
    // 恰好三次：不无限重试
    expect(attempts).toBe(3);
    // 状态标终态：否则界面会永久停在「生成中」
    expect(opened.stream.state.status).toBe("failed");
    expect(opened.stream.state.failure?.code).toBe("connection-lost");
  });

  it("close() 之后断线不再重连（主动退出不该在后台拉起连接）", async () => {
    const opened = await open();
    const before = connects;

    await opened.close();

    await daemon!.stop("test disconnect");
    daemon = null;
    // 等到服务端真的把这个连接收掉（断线确实发生过，不是「还没轮到」）
    await waitFor(() => connection.closed);
    expect(connects).toBe(before);
    expect(attempts).toBe(before);
  });
});

describe("SessionChannel：换 id 与快照里的「还在跑」（P4 会立刻踩到的三条）", () => {
  /**
   * 与服务端在一轮内部换 id（自动迁移）有关的那条：`session-turn-end` 从**新** id 上来。
   *
   * 为什么必须有用例钉住：id 是事件过滤的判据，而过滤读的是状态里的那一份 —— 不跟着换，
   * 客户端就会在旧 id 上等一个永远不会到的 `session-turn-end`，界面永久停在「生成中」。
   */
  it("一轮内部自动迁移（session-id-changed）：session-turn-end 从新 id 上来，waitForTurn 照样落定", async () => {
    const opened = await open();
    agent.messages = [{ role: "user", content: "旧任务" }];
    const turnId = await opened.send("继续");
    await waitFor(() => agent.sent.length === 1);
    const pending = watch(opened.waitForTurn(turnId));

    // 服务端这一侧：自动迁移（存档 + prune + 换 id），`session-id-changed` 随之发出
    await (manager as unknown as { autoMigrate(id: string): Promise<void> }).autoMigrate(
      opened.sessionId,
    );
    await waitFor(() => opened.sessionId !== "chat_1");

    // 这一轮的收尾事件带的是**新** id
    agent.fire("finally");
    await waitFor(() => pending.settled);

    expect(pending.error).toBeUndefined();
    expect(opened.sessionId).not.toBe("chat_1");
    // 屏幕上是迁移之后那份（模板 + 交接断点），旧历史已经剔除
    expect(JSON.stringify(opened.stream.state.messages)).not.toContain("旧任务");
  });

  it("saveAs 换 id 之后，新 id 上照样能跑一轮（`adopt` 把状态机带过去了）", async () => {
    // 这条验的是 `adopt` 那两步本身：换 id + 重取快照。漏掉第一步的症状就是「服务端换了键、
    // 客户端还在旧 id 上等事件」—— 一轮发得出去，却永远等不到收尾。
    const opened = await open();
    agent.messages = [{ role: "user", content: "聊过一句" }];

    const newId = await opened.saveAs("chat_named");
    expect(newId).toBe("chat_named");
    expect(opened.sessionId).toBe("chat_named");
    // 快照也跟着重取过了（历史还在）
    expect(opened.stream.state.messages).toEqual([{ role: "user", content: "聊过一句" }]);

    const turnId = await opened.send("新 id 上的第一轮");
    const pending = watch(opened.waitForTurn(turnId));
    await waitFor(() => agent.sent.length === 1);
    agent.messages.push({ role: "user", content: "新 id 上的第一轮" });
    agent.fire("finally");

    await waitFor(() => pending.settled);
    expect(pending.error).toBeUndefined();
    expect(opened.sessionId).toBe("chat_named");
  });

  /**
   * 重连时服务端**还在跑**（快照 `phase !== null`）：不落定、不猜结果，接着收增量。
   *
   * 与「服务端已空闲 → 用同一个 `finishTurn` 落定」是同一处判断的两个分支；搞反的症状是
   * 「一轮还在跑，界面却已经恢复输入」—— 用户接着发，撞在 `turn-busy` 上。
   *
   * 这里刻意**不重启服务端**：只把连接拉掉，那段会话仍在服务端内存里跑着 —— 只有这样才能
   * 拿到「phase 非空」的快照（重启之后它只能从存档装回来，phase 必然是空的）。
   */
  it("重连时服务端还在跑（快照 phase 非空）：不落定，增量接着来", async () => {
    const opened = await open();
    const turnId = await opened.send("长任务");
    await waitFor(() => agent.sent.length === 1);
    // 先让服务端的阶段非空（快照里才有东西可给）
    agent.messages.push({ role: "user", content: "长任务" });
    agent.fire("chunk-parsed", {}, { choices: [{ delta: { content: "一" } }] });
    await waitFor(() => JSON.stringify(opened.stream.state.messages).includes("一"));
    const pending = watch(opened.waitForTurn(turnId));
    const connectsBefore = connects;
    const changesBefore = changes;

    // 只拉掉这一条连接（服务端不重启）
    (await connection.client()).close();

    // 新连接建出来，并且那一整段恢复已经落定（`restore` 末尾那一次通知）
    await waitFor(() => connects > connectsBefore);
    await waitFor(() => changes > changesBefore);

    // 服务端说「还在跑」：promise 不能落定，状态仍是「在飞」，等的还是同一轮
    expect(pending.settled).toBe(false);
    expect(opened.stream.state.status).toBe("streaming");
    expect(opened.stream.state.turnId).toBe(turnId);

    // 增量继续来，并且落在**同一条**消息上（合并规则负责这件事，见 stream.test.ts）
    agent.fire("chunk-parsed", {}, { choices: [{ delta: { content: "二" } }] });
    await waitFor(() => JSON.stringify(opened.stream.state.messages).includes("二"));
    expect(JSON.stringify(opened.stream.state.messages)).toContain("一二");

    agent.messages.push({ role: "assistant", content: "一二" });
    agent.fire("finally");
    await waitFor(() => pending.settled);
    expect(pending.error).toBeUndefined();
  });

  /**
   * `attach` 回 `session-missing`：服务端说这段会话没了（存档被删 / 换了一台实例）。
   *
   * 这是**终局**，不是「这次没接上」：再试三次也是同一个答案，所以立刻停手，并把在飞的
   * 那一轮以**服务端给的原码**失败 —— 界面据此恢复输入，且能说出「会话不在了」而不是
   * 一句含糊的「连接断了」。
   */
  it("attach 回 session-missing：走 gone 分支（不再重试），waitForTurn 以服务端原码失败", async () => {
    const opened = await open();
    const turnId = await opened.send("长任务");
    await waitFor(() => agent.sent.length === 1);
    const pending = watch(opened.waitForTurn(turnId));

    // 换一台服务端，且盘上没有这段会话（没有 save）：attach 只能回 `session-missing`
    attempts = 0;
    await restartServer();
    releasePort();

    await waitFor(() => pending.settled);
    // 服务端原码原样交给调用方（不是包一层「连接断了」）
    expect(codeOf(pending.error)).toBe(ERROR_CODES.sessionMissing);
    // 恰好一次：gone 是终局，不重试
    expect(attempts).toBe(1);
    // 状态标终态，且带的是同一个码（界面靠它说清「会话不在了」）
    expect(opened.stream.state.status).toBe("failed");
    expect(opened.stream.state.failure?.code).toBe(ERROR_CODES.sessionMissing);
  });
});

describe("SessionChannel：服务端提问的兜底", () => {
  /** 从服务端注入给 Agent 的 `resolveMode` 驱动提问（与真链路同构） */
  const ask = async (): Promise<string | null> => {
    const resolveMode = lastAgentInput?.resolveMode;
    if (!resolveMode) throw new Error("服务端没有给 Agent 注入 resolveMode");
    return await resolveMode({ promptTokens: 999, handoffTokens: 100 });
  };

  it("没有 answerQuestion：立刻回服务端的 fallback（不让服务端干等超时）", async () => {
    await open();

    // 服务端超时是 5 分钟：这里几秒内落定就证明客户端自己答了
    const settled = watch(ask());
    await waitFor(() => settled.settled);
    // 交接类问题的 fallback 是「本次不交接」
    expect(settled.value).toBeNull();
  });

  it("注入的选择器拿到触发时的用量，选的方式被送回服务端", async () => {
    const seen: SessionQuestionEvent[] = [];
    await open({
      answerQuestion: async (event) => {
        seen.push(event);
        return "summary";
      },
    });

    const settled = watch(ask());
    await waitFor(() => settled.settled);

    expect(settled.value).toBe("summary");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe("handoff-mode");
    expect(seen[0]!.params).toEqual({ promptTokens: 999, handoffTokens: 100 });
  });

  it("选择器自己抛错：按「没人能回答」降到 fallback，不让这一轮卡死", async () => {
    const opened = await open({
      answerQuestion: async () => {
        throw new Error("面板被拆掉了");
      },
    });

    const settled = watch(ask());
    await waitFor(() => settled.settled);

    expect(settled.value).toBeNull();
    expect(opened.stream.state.sessionId).toBe("chat_1");
  });
});

describe("SessionChannel：close 是对外唯一的回收手段（D5×D8）", () => {
  it("close 之后服务端当场回收这段会话（存档还在，attach 装得回来）", async () => {
    agent.messages = [{ role: "user", content: "聊过一句" }];
    const opened = await open();
    await (await sessionsOf()).save(opened.sessionId);
    const sessionId = opened.sessionId;
    const workspaceId = (await (await sessionsOf()).resolveWorkspace(workspaceDir)).workspaceId;

    const liveIds = async (): Promise<string[]> =>
      (await (await sessionsOf()).list(workspaceId)).sessions
        .filter((entry) => entry.live)
        .map((entry) => entry.sessionId);
    expect(await liveIds()).toContain(sessionId);

    await opened.close();

    // 活会话没了（连接仍在：一条长连接不会因为切会话而消失，所以必须**主动**收）
    expect(await liveIds()).not.toContain(sessionId);
    // 但存档还在：这就是「回收不丢内容」的依据
    expect(
      (await (await sessionsOf()).list(workspaceId)).sessions.map((e) => e.sessionId),
    ).toContain(sessionId);
  });

  it("close 之后 send 立刻被服务端拒（unknown-session），不静默丢掉这一轮", async () => {
    const opened = await open();
    await opened.close();

    await expect(opened.send("还有人吗")).rejects.toThrow(/unknown-session/);
  });
});
