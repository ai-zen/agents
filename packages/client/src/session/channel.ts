/**
 * `SessionChannel` —— 一条会话的 I/O：订阅、请求、**重连**，以及「接回来之后重新 attach」。
 *
 * ## 为什么与 `SessionStream` 分成两个
 *
 * 一纯一脏。`SessionStream` 是「一轮之内前端必须持有的状态」（零 I/O，可以直接单测）；
 * 这里是它的另一半 —— 只有这一半知道 socket、往返、退避。理由与 `PhaseTracker`（纯）/
 * `SessionManager`（脏）那一刀完全相同：把「什么时候要重连、重连几次」混进状态机，
 * 状态机就只能靠「摆一台真服务端」来测。
 *
 * ## 三条不变式（丢掉任何一条都是回归）
 *
 * 每一条都是踩出来的：
 *
 * 1. **在飞的那一轮不能永远挂着。** 界面用 `await waitForTurn()` 包着 busy 状态与输入禁用，
 *    而 `await` 的落定靠同一 `turnId` 的 `session-turn-end`。断线时那条 socket 上的一切都扔了，
 *    `session-turn-end` 可能就丢在里面 —— promise 永不落定 = 永久卡在「生成中」，比直接报错更糟。
 *    判据是重连后那份快照：`phase !== null` 说明服务端还在跑（事件会继续来，接着等）；
 *    `phase === null` 说明那一轮在我们不在线的时候结束了，快照里的消息就是结果 ——
 *    用**与 `session-turn-end` 完全相同**的那条收尾路径落定（同一个 `finishTurn`，不另造一套
 *    「重连专用」的状态机）。
 * 2. **重连有终点**：最多 3 次、递增退避，全失败就回到「连接断了」的既有行为（在飞的调用
 *    以连接错误失败、之后的调用也失败）。不无限重试、不静默吞掉。
 * 3. **单飞**：多个断线信号同时到达只跑一次重连，否则会同时开出几条连接、几条都往上 attach。
 *
 * 另外两条边界：主动 `close()` 不重连（那是我们自己关的）；重连**不新增任何用户可见文案**
 * （成功不弹「已重连」，失败沿用既有错误通道）。
 *
 * ## 换 id 之后事件怎么认领
 *
 * 会话 id 会在一轮**进行中**变（自动迁移）。之后的事件用的是新 id，所以过滤判据必须跟着
 * 状态里的 id 走（`this.stream.state.sessionId`），不能缓存一份副本 —— 缓存那份就是
 * 「客户端在旧 id 上等一个永远不会到的 `session-turn-end`」，界面永久卡在生成中。
 * `session-id-changed` 是唯一的例外：它的载荷用 `from` 说「这段会话现在叫什么」，
 * 所以它按 `event.from` 认领（旧 id 已经不存在了，用 `sessionId` 过滤永远不命中）。
 *
 * ## 谁负责生命周期
 *
 * 连接**不是**它的（一个进程一条，见 `ServerConnection`），会话**是**它的：
 * `close()` 会 `session.close()` 让服务端当场回收。这是「我不看这段了」的唯一显式表达，而一条长连接不会因为切换会话而消失 —— 不主动收，内存峰值会随
 * `/new` 的次数线性增长，直到服务端宽限期到点。
 *
 * ## 工作区身份：包里给的是**答案**，不是意图
 *
 * `path` / `workspaceId` 对外只读可查，但要先说清它们是什么。`open()` 的入参 `path` 是
 * **意图**（「我想在这个目录开会话」），服务端把它规范化（相对路径、`..`、末尾斜杠）之后
 * 回来的 `workspace.path` / `workspace.workspaceId` 才是**答案** —— 这两个出口给的是后者。
 *
 * 为什么不让应用自己记「当初请求的那个 path」：它**不是**第二份规范化答案（它只是意图，
 * 留着不算重定义），但它便宜得让人误用。拿它去 `/new` 还能凑合（服务端反正会再规范化一次），
 * 拿它去问「这个工作区有哪些会话 / 哪些文件」就会问出**另一个**工作区：客户端与服务端不是
 * 同一台机器时，那个路径在服务端根本不存在。同理 `workspaceId` 也别自己算 —— 它是
 * 「目录名 + 路径哈希」，算法在服务端，推一遍就是又一份会漂的答案。
 *
 * 两个出口都是**只读**的：`path` 跟着 `open()` / 重连走，`workspaceId` 由服务端算定 ——
 * 调用方改它没有任何意义（改了也不会发给服务端任何一个字段）。
 */

import type {
  ContentUploadResult,
  HandoffMode,
  MessageContent,
  MigrationStrategy,
  ModelParams,
  ServerEvent,
  ServerNoticeEvent,
  SessionListResult,
  SessionModelParamsSetResult,
  SessionModelSetResult,
  SessionNoticeEvent,
  SessionQuestionEvent,
  SessionSnapshotResult,
  WorkspaceFileEntry,
} from "@ai-zen/agents-server/protocol";
import { ERROR_CODES, codeOf } from "../wire/errors.js";
import { RemoteSessions, type UploadContentInput } from "../facade/sessions.js";
import type { ServerConnection } from "../transport/connection.js";
import type { ServerClient } from "../types.js";
import { isSessionGone, connectionLostError } from "./errors.js";
import { SessionStream, type TurnFailure } from "./stream.js";

/**
 * 重连的最多次数（含第一次尝试）。
 *
 * **三次就是终点**：连接断了无非两种 —— 网络抖一下（几百毫秒就回来），或服务端重启
 * （`ensureServer` 会把它拉起来，通常一两秒）。三次足够覆盖这两种；再多只是让用户对着
 * 卡住的界面干等，而连不上这件事最终必须让人看见（走既有错误通道）。
 */
const MAX_RECONNECT_ATTEMPTS = 3;

/** 第 `i` 次**重试**之前等多久（`i=0` 对应第 2 次尝试）：递增，给抖动的网络与服务端重启留时间 */
const RECONNECT_BACKOFF_MS = [100, 300] as const;

/**
 * 服务端通知的码在**另一个联合**里（`ServerNoticeCode`），所以出口的类型是两者的并集。
 *
 * 两支都**带 `id`**（A35）：通知在服务端是**有状态的槽位**，寿命的终点是「有人确认」
 * （`notice.ack { ids }`）。这里是客户端唯一拿到那个 id 的地方 —— 把它剥掉，调用方就只能按
 * 「code + params」本地去重，确认时还得回头再查一次列表。
 *
 * 形状取自**事件**（去掉事件名与归属会话）而不是 `NoticePayload`：后者是「产生一条通知时
 * 要说的东西」，本来就不含 `id`（id 由登记槽位的那一次生成），拿它当出口类型会把 id 剥掉。
 */
export type ChannelNoticePayload =
  Omit<SessionNoticeEvent, "event" | "sessionId"> | Omit<ServerNoticeEvent, "event">;

export interface SessionChannelPolicy {
  /**
   * 服务端提问时怎么答（自动迁移的「交接方式三选一」）。
   *
   * 不注入 = 直接回服务端给的 `fallback`：无头 / 测试里没有人能回答，而**沉默的代价不是
   * 「等一会儿」** —— 服务端要等满超时才降级，那一轮就一直卡在迁移里。
   * 回调自己抛错也走同一条降级（面板被别的交互拆掉、渲染异常都会走到这里）。
   */
  answerQuestion?: (event: SessionQuestionEvent) => Promise<string | null>;
  /**
   * 通知 / 错误上报（`id` + `code` + `params`，**不在这里做 i18n**）。
   *
   * 服务端只给机器可判的码，句子由应用查自己的词典 —— 否则一个服务端同时接中文终端和
   * 英文浏览器时只能挑一个语言撒谎。
   *
   * `id` 是确认这条通知的唯一凭据（`notice.ack { ids }`）：调用方要留到确认之后才丢，
   * 不要拿「code + params」自己造一份去重表 —— 那是把服务端的槽位在本地再实现一遍。
   */
  onNotice?: (payload: ChannelNoticePayload) => void;
  /**
   * 「屏幕该重画了」。`immediate` = 不要合帧（阶段回到空闲、栏目出现这类**状态跃变**），
   * 其余情况调用方可以攒到下一帧。
   */
  onChange?: (immediate: boolean) => void;
}

/**
 * 等一段时间的实现（只用在重连退避上）。
 *
 * 注入出来是为了让「三次都失败」的用例不必真等 400ms —— 但**不许**用它伪装成假时钟去测
 * 别的时序：真正的等待一律轮询到条件成立（见用例）。
 */
export interface SessionClock {
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: SessionClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface SessionChannelDeps {
  /** 一条（进程级共享的）连接：会话不建连接，只借它说话 */
  connection: ServerConnection;
  policy?: SessionChannelPolicy;
  /** 重连退避的等待实现；缺省真 setTimeout */
  clock?: SessionClock;
}

/** 开一段会话要说的几句话（与 `RemoteSessions.open` / `attach` 的参数同源） */
export interface SessionChannelOpenInput {
  /**
   * 工作目录。**建议不给**：不给就用服务端自己的工作区（cwd 归服务端）。
   * 本地服务端才该递客户端 cwd —— 判据在 `local-host.ts`，不在这里。
   */
  path?: string;
  /** 用哪个 Agent；续接已有会话时可以不给（存档里记着它属于谁） */
  agentId?: string;
  /** 续接这一段（`/load` 选中的那个，或上次的存档 id） */
  sessionId?: string;
  /**
   * 接着本工作区的「上一轮会话」（有就接着，没有就开新的）。
   *
   * 这是**意图**不是数据：哪一段是「上一轮」只存在于服务端（指针 + 存档）。
   * 给了明确的 `sessionId` 时以它为准（用户已经指名道姓了）。
   */
  resume?: boolean;
  /** 每轮收尾是否自动落盘（缺省 `true`）；`false` 给一次性调用（`ai "…"`） */
  persist?: boolean;
}

/** 一次重连尝试的结果：接上了 / 会话已经没了（不重试）/ 这次没接上（还能再试） */
type RestoreOutcome = { status: "ok" } | { status: "gone"; error: Error } | { status: "retry" };

export class SessionChannel {
  /** 纯状态机：屏幕要的事实全在这里（应用订阅它的 `onChange` ） */
  readonly stream: SessionStream;

  private readonly connection: ServerConnection;
  private readonly policy: SessionChannelPolicy;
  private readonly clock: SessionClock;

  /** 当前连接（可变：重连成功会换一条）与它上面的门面 */
  private client: ServerClient | null = null;
  private sessions: RemoteSessions | null = null;
  /** 这一整组事件订阅的解绑函数（重连时整组换掉） */
  private offs: Array<() => void> = [];
  /** 「连接断了」的订阅；`close()` 先摘掉它，否则主动关闭会被当成断线去重连 */
  private offClose: (() => void) | null = null;

  /**
   * 这段会话落在哪个工作区（`attach` / `list` / `files` 都要它；重连也得带回去）。
   *
   * 带 `Value` 后缀是照 `agentIdValue` 的写法：对外有同名只读出口（`get workspaceId()`），
   * 同名字段与取值器在类里不能共存。
   */
  private workspaceIdValue = "";
  /**
   * 这个工作区在**服务端**的规范路径（重连时原样递回去，两处说的才是同一个工作区）。
   *
   * 它来自 `workspace.resolve` 的返回值，不是 `open()` 收到的那份入参 —— 两者可以不同
   * （相对路径、`..`、末尾斜杠、客户端与服务端不是同一台机器时那个路径压根不存在）。
   */
  private pathValue: string | undefined;
  private agentIdValue = "";

  /** 重连进行中（单飞：多个断线信号同时到达只跑一次） */
  private reconnecting = false;
  /** 已经 `close()`：此后任何断线信号都不该再触发重连 */
  private disposed = false;

  /**
   * 本轮等待中的 `session-turn-end`（`waitForTurn()` 的 promise 靠它落地）。
   *
   * `reject` 给「连不回来」那条路用：连不上时这一轮只能以**连接错误**失败，不能让 promise
   * 永远悬着（界面靠它恢复输入）。
   */
  private pendingTurn: {
    turnId: number;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  /** 最近一次收到的 `session-turn-end` 的轮次：挡住「事件比回执先到」那种竞态 */
  private lastEndedTurn = 0;

  constructor(deps: SessionChannelDeps) {
    this.connection = deps.connection;
    this.policy = deps.policy ?? {};
    this.clock = deps.clock ?? REAL_CLOCK;
    this.stream = new SessionStream();
    // 断线通知挂一次就够：它在 `ServerConnection` 上（那才是连接的主人），
    // 重连换掉的是它内部的 socket，这个订阅跟着进程走、不受影响
    this.offClose = this.connection.onClose(() => this.handleClose());
  }

  /** 这段会话的 id（唯一真相在状态里：`session-id-changed` 会让它变） */
  get sessionId(): string {
    return this.stream.state.sessionId;
  }

  /**
   * 这段会话用哪个 Agent。
   *
   * 它跟着 `open()` / `setAgent()` 走，**不是**应用自己记的那一份：`/think`、`/model` 与拼
   * 请求都要按「这段会话现在挂在谁身上」判断，两个副本迟早会出现「界面显示 A、服务端跑 B」。
   */
  get agentId(): string {
    return this.agentIdValue;
  }

  /**
   * 这个工作区在**服务端**的规范路径（`open()` 之前是 `undefined`）。
   *
   * 它不是 `open()` 收到的那份入参，而是服务端规范化后的**答案** —— 拿它回服务端
   * （`/new`、重连）才落在同一个工作区里。详细理由见文件头「工作区身份」。
   */
  get path(): string | undefined {
    return this.pathValue;
  }

  /**
   * 这个工作区的服务端身份（键，不是路径；`open()` 之前是 `undefined`）。
   *
   * 形状是 `<目录名>-<路径哈希>`，**由服务端算**：自己推一遍就是把一个会漂的答案抱回家。
   * 要按工作区问服务端要东西（会话清单 / `last` 指针 / 文件清单）时用它。
   */
  get workspaceId(): string | undefined {
    // 初值是空串（`open()` 之前没有工作区）：对外说 `undefined`，不说 "" —— 那会诱使
    // 调用方把一个空键当成某个工作区的东西
    return this.workspaceIdValue || undefined;
  }

  // ==================== 开 / 接 ====================

  /**
   * 连上服务端并打开（或续接）一段会话。
   *
   * 三处顺序是必须的：
   *  · **先订阅事件再 attach**：接上之后服务端可能立刻推 `session-phase`，晚一步就会漏掉
   *    开头的阶段（屏幕停在上一个状态不动）；
   *  · **`events.watch` 先于 attach**：订阅是连接级的，没订阅的连接收不到任何事件；
   *  · **最后拉一次快照**：续接时的历史也在这份快照里（服务端 `session.create` 已经把存档
   *    消息装进了 Agent），客户端不搬、不拼，屏幕上的第一条都来自服务端。
   */
  async open(input: SessionChannelOpenInput = {}): Promise<void> {
    /**
     * 换一段会话，上一段的轮次账一概不算数。
     *
     * `lastEndedTurn` 是 `waitForTurn()` 的「已收尾」判据，而 `turnId` 是**会话内**的编号：
     * 服务端每一轮 `turnId += 1`，新建 / 续接的会话都从 0 起（`LiveSession` 初始化
     * `turnId: 0`）。同一条 channel 上换一段会话（新会话的 `turnId` 也从 1 起）时不清账，
     * `waitForTurn(1)` 会因为 `1 <= lastEndedTurn`（上一段跑到第几轮就是几）**立即返回** ——
     * 界面于是以为这一轮已经结束，刚发出去的那一轮的收尾再也无人认领。
     *
     * 挂着的 promise 一并落定（`resolveTurn`）：它等的那一轮属于**上一段**会话，换走之后
     * 它的 `session-turn-end` 永远不会从新会话上来 —— 留着它就是一条永挂的 promise（界面永久
     * 待在 「生成中」）。与 `close()` 对同一个局面的处理一致。
     *
     * 注意**不在这里清轮次账的是 `adopt()`**：`saveAs` / `migrate` 换的只是**键**，服务端
     * 换键的是同一个会话对象（`turnId` 跟着走，见 `SessionManager.rekey`）—— 那一轮还在跑，
     * 清了反而会在「这一轮已收尾」上漏判。
     */
    this.lastEndedTurn = 0;
    this.resolveTurn();

    const client = await this.connection.client();
    this.install(client);
    await this.connection.watch();

    const workspace = await this.sessions!.resolveWorkspace(input.path);
    this.workspaceIdValue = workspace.workspaceId;
    this.pathValue = workspace.path;

    /**
     * 续接：`resume` 只是意图，**哪一段是上一轮**只有服务端知道（`session.last`）。
     * 明确的 `sessionId` 永远优先：`/load` 已经指定了具体那一段，再拿指针覆盖它
     * 就成了「悄悄换了用户点的东西」。
     */
    const lastId =
      input.sessionId || input.resume !== true
        ? null
        : (await this.sessions!.last(workspace.workspaceId)).sessionId;
    const sessionId = input.sessionId ?? lastId ?? undefined;

    /**
     * 有明确目标 id 就走 `attach`，否则才 `open` 一段新的。
     *
     * 为什么不能一律 `open`：那段会话很可能**还在服务端活着**（上次只是断开了连接，
     * Agent 与 MCP 连接都没销毁），而 `open` 对活着的 id 是「拒绝」（不静默顶掉正在跑的
     * 会话）—— 于是「接着上次」会撞在 `session-exists` 上，用户看到的是「打不开自己上一轮
     * 会话」。`attach` 的语义就是「这段我要接上」。
     */
    const opened = sessionId
      ? await this.sessions!.attach({
          workspaceId: workspace.workspaceId,
          path: workspace.path,
          sessionId,
          ...(input.agentId ? { agentId: input.agentId } : {}),
        })
      : await this.sessions!.open({
          path: workspace.path,
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.persist !== undefined ? { persist: input.persist } : {}),
        });

    this.agentIdValue = opened.agentId;
    this.stream.applyIdChanged(opened.sessionId);
    this.stream.applySnapshot(await this.sessions!.snapshot(opened.sessionId));
  }

  // ==================== 一轮 ====================

  /**
   * 开始一轮，返回 `turnId`。
   *
   * 它**不等**这一轮结束：`await send() → await waitForTurn(turnId)` 两步分开，是因为
   * `session-turn-end` 有可能先于 `send()` 的回执落地（事件是推的），两件事合成一个 promise
   * 就得在里面记一份「已经收尾过的轮次」才能不挂死 —— 那正是 `waitForTurn` 干的事。
   *
   * 同步拒绝（`turn-busy` / `handoff-in-flight` / 连接已断）原样抛出：那是调用方该告诉
   * 用户的事（「这轮没发出去」），包成「本轮失败」只会让界面以为它跑过。
   */
  async send(content: MessageContent): Promise<number> {
    const { turnId } = await this.sessions!.send(this.sessionId, content);
    this.stream.beginTurn(turnId);
    return turnId;
  }

  /**
   * 等这一轮结束（收尾之后才 resolve）。界面用 `busy` 状态与输入禁用全靠它。
   *
   * 事件可能**比回执先到**（一轮太快时连 `session-turn-end` 都可能在 `send()` 返回之前落地），
   * 所以先看 `lastEndedTurn` 再挂 promise。连不回来时它会 reject —— 这一轮已经不可能
   * 结束了，界面必须能恢复输入。
   */
  async waitForTurn(turnId: number): Promise<void> {
    if (this.lastEndedTurn >= turnId) return;
    // 从判断到挂 promise 之间没有 await：中间不会被事件插进来
    await new Promise<void>((resolve, reject) => {
      this.pendingTurn = { turnId, resolve, reject };
    });
  }

  /**
   * 中止本轮（Ctrl+C）：只取消这一轮，不退出。
   *
   * 失败不报：这只是「请求服务端掐掉本轮」，随后 `session-turn-end` 照样会来；而会话已经不在
   * （`cancelled:false` / `unknown-session`）时目的也已经达成。
   */
  async abort(): Promise<void> {
    await this.sessions?.cancel(this.sessionId).catch(() => {});
  }

  /**
   * 显式回收这一段（**对外唯一手段**）。
   *
   * 三件事，顺序有讲究：
   *  1. 先摘「断线」订阅，再关——否则下面那次主动收尾引发的断开会被当成断线去重连；
   *  2. 挂着的 `waitForTurn()` 立刻落定（连接/会话都要没了，这一轮只能算结束）；
   *  3. `session.close()` **等回执**：服务端当场回收这段会话（Agent、MCP 连接一起还回去）。
   *     不等的话，切换十次会话就在服务端留下十段活会话，直到宽限期到点。
   *
   * 它**不关连接**：一个进程一条，会话只是这条连接上的一个对象。
   */
  async close(): Promise<void> {
    this.disposed = true;
    this.offClose?.();
    this.offClose = null;
    for (const off of this.offs.splice(0)) off();
    this.resolveTurn();
    await this.sessions?.close(this.sessionId).catch(() => {});
  }

  // ==================== 会话动作（「请求」那半边） ====================

  /**
   * 另存为指定 id（`/save <名字>`）；**返回之后的 id**（旧 id 在服务端已经退场）。
   *
   * 不用返回值的话，之后每一次请求都会撞在 `unknown-session` 上 —— 服务端只管自己那边
   * 换键，它不知道客户端缓存了一份旧的。
   */
  async saveAs(id: string): Promise<string> {
    const result = await this.sessions!.saveAs(this.sessionId, id);
    await this.adopt(result.sessionId);
    return this.sessionId;
  }

  /**
   * 交接 + 开新会话（`/migrate`）：返回交接文档的路径（在**服务端**的工作区里）。
   *
   * `strategy` 缺省 `prune`，那会换 id，所以必须走 {@link adopt}：不换的话这一轮的
   * `session-turn-end` 会从新 id 上来，状态机还在旧 id 上等 —— 界面永久卡在「生成中」。
   * `omit` 不换 id（`adopt` 于是只是重取一次快照），这也是为什么换不换 id 由**返回值**
   * 决定，而不是由这里再判一次 `strategy`：两个判据迟早会有一个落单。
   *
   * `strategy` 必须从这里透传下去（与 {@link save} 的 `setAsLast` 同一个道理）：它是
   * 「这一迁移算什么」的唯一开关，而调用方手里只有 channel —— 门面上有、channel 上吞掉，
   * 症状就是「传了 `omit` 却一样换了 id」，且看不出是谁丢的。
   */
  async migrate(mode?: HandoffMode, strategy?: MigrationStrategy): Promise<string> {
    const result = await this.sessions!.migrate(this.sessionId, mode, strategy);
    await this.adopt(result.sessionId);
    return result.handoffPath;
  }

  /**
   * 按服务端盘上的新配置 / Agent 定义重建 Agent（**保留消息、id 不变**）。
   *
   * 直接 `applySnapshot`：结果就是一份快照，而 id 没变 —— 走 `adopt` 只会多此一举地
   * 再拉一次同样的东西。
   */
  async reload(): Promise<void> {
    this.stream.applySnapshot(await this.sessions!.reload(this.sessionId));
  }

  /**
   * 换 Agent：同一段对话换个 Agent 继续（服务端保留消息、更新 `agentId` 并落盘）。
   *
   * `agentId` 必须跟着换成返回值里那一个：`/think`、`/model` 与下一次 `open` 都读它。
   * 模型、阈值也一起变，所以拿返回的快照整屏对齐（与 {@link reload} 同一个形状）。
   */
  async setAgent(agentId: string): Promise<void> {
    const snapshot = await this.sessions!.setAgent(this.sessionId, agentId);
    this.agentIdValue = snapshot.agentId;
    this.stream.applySnapshot(snapshot);
  }

  /**
   * 换**这一段会话**的模型（`session.model.set`）：写存档的 `modelId` 并重建 Agent。
   *
   * ## 为什么它在 channel 上（而不是只留在 `RemoteSessions`）
   *
   * `RemoteSessions` 是「按 id 说话」的无状态门面，它不知道「当前这一段是哪个 id」；而
   * 调用方（`/model`）手里拿的恰恰只有 channel。让应用自己
   * `new RemoteSessions(await connection.client())` 现取一次门面也能做 —— 参数拼装仍然只有包里
   * 一份（不是第二份实现），但多绕一层，且「当前 id」与「门面」两个来源在应用里又成了一个会
   * 漂的配对。
   *
   * ## 为什么它**不**换 id、却要把返回的快照对齐屏幕
   *
   * 换模型不换键（服务端只写存档的 `modelId` 并重建 Agent），所以不走 `adopt`（那会多跑
   * 一次快照往返）。但返回的快照里带着新的 `modelId` / `apiModel` / `modelParams` —— 它们
   * 是屏幕上的事实（「现在用的是哪个模型」），不对齐就要等到下一轮收尾才更新。与
   * {@link setAgent} / {@link reload} 同一个形状（它们也都换模型、也都 `applySnapshot`）。
   */
  async setModel(modelId: string): Promise<SessionModelSetResult> {
    const snapshot = await this.sessions!.modelSet(this.sessionId, modelId);
    this.stream.applySnapshot(snapshot);
    return snapshot;
  }

  /**
   * 改**这一段会话**的模型**参数**（`session.modelParams.set`）；`null` = 清掉这一层覆盖。
   *
   * 与 {@link setModel} 一样是「一条会话的动作」：不换 id、返回快照、顺手对齐屏幕（`/think`
   * 之后状态栏要立刻显示新的思考强度，而不是等下一轮）。两者的差别只在语义 —— 换模型会
   * 连带清掉参数（新模型不一定接受旧参数），改参数不该动模型 —— 所以它们是两个方法。
   */
  async setModelParams(params: ModelParams | null): Promise<SessionModelParamsSetResult> {
    const snapshot = await this.sessions!.modelParamsSet(this.sessionId, params);
    this.stream.applySnapshot(snapshot);
    return snapshot;
  }

  /**
   * 只产出交接文档（`/handoff`）：**不换 id、不别历史**，返回文档路径。
   *
   * 交接回合会往会话里追加消息（指令 + 工具调用 + 回执），而它们不是通过增量到达的：
   * 重取一次快照对齐屏幕（id 没变，所以不走 `adopt`）。取不到也不算交接失败 ——
   * 文档已经写完了，屏幕下一轮收尾还会再对齐。
   */
  async handoff(mode?: HandoffMode): Promise<string> {
    const result = await this.sessions!.handoff(this.sessionId, mode);
    await this.syncFromServer().catch(() => {});
    return result.handoffPath;
  }

  /**
   * 撤回：从 `index` 起删掉并落盘，返回被删的首条用户消息**原文**（服务端不剥「工作目录
   * 备注」那类装饰 —— 那是客户端拼进去的，也该由客户端还原成输入框里的字）。
   *
   * 消息变了，所以同样要重取一次快照（与 {@link handoff} 同一个理由）。
   */
  async rollback(index: number): Promise<string> {
    const result = await this.sessions!.rollback(this.sessionId, index);
    await this.syncFromServer().catch(() => {});
    return result.prompt;
  }

  /**
   * 一批字节 → 一块能放进消息的内容（粘贴的图片走这条路）。
   *
   * 为什么在 channel 上而不只留在门面：这件事要问「**这一段**会话用的是什么端点 / 模型」
   * （上传还是内联、模型看不看得见图），而唯一知道当前 id 的就是 channel —— 与
   * {@link setModel} 同一个理由。
   *
   * 它**不碰状态**：只回一块内容，发不发、怎么拼消息由调用方决定（`session.send` 之前
   * 拼进去）。失败原样抛出（`unknown-session` / 体积超限 / 端点拒绝），由调用方决定是
   * 丢掉这一张还是整条不发。
   */
  async uploadContent(input: UploadContentInput): Promise<ContentUploadResult> {
    return await this.sessions!.uploadContent(this.sessionId, input);
  }

  /**
   * 落盘当前会话（缺省同时把它设为「本工作区上一轮会话」），返回它落盘时用的 id。
   *
   * `setAsLast: false` 是**一次性调用的归档**（`ai "…" --save`）：写档但**不**挪续接指针 ——
   * 否则连着跑几条 `cat … | ai --save` 之后，下次 `ai` 会续接到最后一条管道结果上。
   *
   * 选项必须从这里透传，因为**调用方手里只有 channel**（它知道「当前这一段是哪个 id」），
   * 而 `RemoteSessions` 是「按 id 说话」的无状态门面。不透传的后果不是「少一个参数」，
   * 而是逼调用方在应用里 `new RemoteSessions(await connection.client())` 现取一次门面 ——
   * 参数拼装仍然只有包里一份，但「当前 id」与「门面」两个来源在应用里又成了一个会漂的配对。
   */
  async save(options: { setAsLast?: boolean } = {}): Promise<string> {
    return (await this.sessions!.save(this.sessionId, options)).sessionId;
  }

  /**
   * 本工作区的会话清单（存档 ∪ 活会话，一条不重）。
   *
   * 不映射成「只有 id」：标题 / 条数 / 活否都是侧栏要的，映射一次就是丢掉信息，而调用方
   * 将来要它们时只能再问一次服务端（中间夹着新事件，两份清单会不一致）。
   */
  async listSaved(): Promise<SessionListResult["sessions"]> {
    return (await this.sessions!.list(this.workspaceIdValue)).sessions;
  }

  /** 这一段还在不在（存档或活会话里有它）；选择器与续接判断用 */
  async exists(id: string): Promise<boolean> {
    return (await this.listSaved()).some((entry) => entry.sessionId === id);
  }

  /**
   * 本工作区的文件清单（`@` 补全用）。
   *
   * 问服务端要（`workspace.files`），不扫本地：清单必须来自**会话真正跑在哪个目录**。
   * 扫客户端自己的 cwd，在「客户端连远端服务端」那种形态下会列出另一台机器上的文件。
   */
  async listWorkspaceFiles(): Promise<WorkspaceFileEntry[]> {
    return (await this.sessions!.files(this.workspaceIdValue)).entries;
  }

  /**
   * 换到**新的** sessionId 并重新对齐屏幕 —— 「换 id 的动作」的唯一入口。
   *
   * ## 为什么必须在包里而不是让应用自己记住
   *
   * 服务端在好几个动作里会换掉活会话的键（`saveAs`、`migrate` 的 `prune`）。状态机里的 id
   * 不跟着换，之后到达的事件就全被过滤掉 —— 症状是「在旧 id 上等一个永远不来的
   * `session-turn-end`，界面永久生成中」。把它收成一个方法，调用方就不必记得「换完 id
   * 还得通知状态机」。
   *
   * 两步的顺序是必须的：先 `applyIdChanged`（此后的事件按新 id 认领），再拉快照（迁移把
   * 历史剔成了「模板 + 断点」，屏幕上的那份已经作废）。
   */
  private async adopt(sessionId: string): Promise<void> {
    this.stream.applyIdChanged(sessionId);
    await this.syncFromServer();
  }

  // ==================== 事件接线 ====================

  /**
   * 把这条连接上的事件接到状态机上；**返回这一整组订阅的解绑函数**。
   *
   * 过滤不是可选优化：同一条连接可以先后服务好几段会话（`/load`、`/migrate` 换了 id），
   * 不过滤就会把上一段会话的事件拼进当前这段。之所以**可重复调用、且把解绑函数交回给
   * 调用方**：断线后旧连接上的一切订阅都废了，重连必须在新连接上重新订一遍 —— 而且必须
   * 「先在新连接上订好、整段恢复成功再换上去」（见 `commit`），半途失败时不会留下一批
   * 指向一条已关连接的死订阅。
   */
  private wire(client: ServerClient): Array<() => void> {
    const offs: Array<() => void> = [];
    // 订阅范围就是下面这些：状态机真正会用的那几条。core 原名的那几条里 `open` / `chunk` /
    // `parsed` / `error` / `finally` 也会到这条连接上（服务端在 core 的时机照发），客户端
    // 此刻**不需要**它们 —— 不订阅就是「收到了忽略」：帧层照样解析、类型上照样认识（它们在
    // `ServerEvent` 里），只是没有处理函数。将来要用（比如拿 `open` 起一个「已经开始」的
    // 计时）在这里加一条即可，协议面不用再改。
    const mine = <E extends ServerEvent["event"]>(
      event: E,
      handler: (payload: Extract<ServerEvent, { event: E }>) => void,
    ) => {
      offs.push(
        client.on(event, (payload) => {
          if ((payload as { sessionId?: string }).sessionId !== this.sessionId) return;
          handler(payload);
        }),
      );
    };

    mine("session-phase", (event) => {
      this.stream.setPhase(event.phase);
      // 每个 chunk 都会带一条 phase：走合帧，别把渲染压到每片一次；回到空闲才立即上屏
      this.notify(event.phase === null);
    });

    /**
     * 一片**原始 chunk**：正文 / 推理 / 工具调用的组装 / 流末用量与结束原因全在它里面。
     *
     * 状态机用 core 的 `applyChunk` 往那条正在拼的 assistant 消息上折，应用通过
     * {@link SessionChannelPolicy.onChange} 拿到更新后的状态（要算速率就看消息本身）。
     * 带 `subAgentId` 的片归子 Agent：折进**它自己**的消息，且不碰主阶段 ——
     * 子 Agent 的流是工具内部的事，主阶段此刻该停在「等待 xxx 返回」。
     */
    mine("chunk", (event) => {
      if (event.subAgentId) this.stream.subAgentChunk(event.subAgentId, event.chunk);
      else this.stream.applyChunk(event.chunk);
      this.notify(false);
    });

    // 一条已经定型的工具结果：原样搬进消息列表，不拼装（它就是服务端手里那条）
    mine("tool-call-end", (event) => {
      this.stream.applyMessageAppended(event.message);
      this.notify(true);
    });

    /**
     * 子 Agent 开工：标签上多一个「子AGENT{n}」，并**立刻**拉一次快照。
     *
     * `started` 说明它已经在跑，服务端此刻可能已经有内容（任务描述、上一轮工具调用）。
     * 首次通常只是一条空占位，但这一下让「中途接上连接」与「增量先于快照到达」都收敛到
     * 同一份数据上（合并规则见包里的 `mergeStreamedSnapshot`，由状态机执行）。
     * 失败不升级成通知：这次拉取只是「把已有内容补上」，增量照样拼、`session-turn-end` 照样清，
     * 连接真断了会有别的信号。
     */
    mine("sub-agent-start", (event) => {
      this.stream.subAgentStarted(event);
      void this.syncSubAgent(event.subAgentId).catch(() => {});
      // 标签立刻上屏（「它开跑了」这件事不该等一个往返）
      this.notify(true);
    });

    // 子 Agent 收尾：只改状态（正文由增量与快照负责，这里不再拉一次）
    mine("sub-agent-end", (event) => {
      this.stream.subAgentEnded(event);
      this.notify(true);
    });

    mine("session-turn-end", (event) => {
      void this.finishTurn(event.turnId, event.error);
    });

    /**
     * 服务端提问（自动迁移的「交接方式三选一」）。
     *
     * 这里只**发起**回答、不等结果：这条事件在一轮内部到达，服务端此刻正停在迁移上等答复，
     * 把界面卡在这个 await 里毫无好处。回答失败不升级成通知：这一问只是「迁移用哪种方式」，
     * 服务端有超时兜底，弹一条错误只会让用户以为迁移坏了。
     */
    mine("session-question", (event) => {
      void this.answerQuestion(event).catch(() => {});
    });

    mine("session-notice", (event) => {
      // `id` 跟着走：通知是有状态的槽位，确认靠 `notice.ack { ids }` —— 客户端收得到却拿不到
      // 凭据的话，只能按 code + params 本地去重，确认时还得回头再查一次
      this.policy.onNotice?.({
        id: event.id,
        level: event.level,
        code: event.code,
        params: event.params,
      });
    });

    /**
     * 服务端换 id（迁移 / 另存为 / **一轮进行中的自动迁移**）。
     *
     * 这里没有 `mine()` 那层过滤：它的载荷说的是「`from` 那段会话现在叫 `sessionId` 了」，
     * 旧 id 已经不存在，所以用 `from` 认领。不跟着换的后果很硬：自动迁移发生在一轮内部，
     * 客户端会在旧 id 上等一个永远不会到的 `session-turn-end`，界面就永久卡在「生成中」。
     */
    offs.push(
      client.on("session-id-changed", (event) => {
        if (event.from !== this.sessionId) return;
        this.stream.applyIdChanged(event.sessionId);
        // 迁移已经把历史剔成「模板 + 断点」：屏幕上的那份已经作废，重取一次
        void this.syncFromServer()
          .catch(() => {})
          .finally(() => this.notify(true));
      }),
    );

    // 全局通知不属于任何会话：切会话也不该消失，所以不过滤 sessionId
    offs.push(
      client.on("server-notice", (event) => {
        // 同上：`id` 是确认这条通知的唯一凭据，不能在这一层丢掉
        this.policy.onNotice?.({
          id: event.id,
          level: event.level,
          code: event.code,
          params: event.params,
        });
      }),
    );

    return offs;
  }

  // ==================== 收尾 ====================

  /**
   * 一轮收尾：用服务端快照对账。
   *
   * `known` = 手上已经有一份**刚刚才拉的**快照（重连后那一份）：再用它一次，不再为了收尾
   * 多跑一个往返（那个往返还可能拿回「下一轮已经开了」的更新状态，把这里的判定搅乱）。
   *
   * ## `lastEndedTurn` 为什么在末尾才置位
   *
   * 它是 `waitForTurn()` 的「已收尾」判据，所以只有**消息真的换成快照之后**才算数：开头就
   * 置位的话，一轮非常短时（`session-turn-end` 比 `send` 的**回执**先到）调用会立刻返回，而这里
   * 那份快照还在路上 —— 调用方紧接着读消息拿到的是空数组（stdio 会因此打印「模型没回答」）。
   */
  private async finishTurn(
    turnId: number,
    failure?: TurnFailure,
    known?: SessionSnapshotResult,
  ): Promise<void> {
    let snapshot: SessionSnapshotResult | null = known ?? null;
    if (!snapshot) {
      try {
        snapshot = await this.sessions!.snapshot(this.sessionId);
      } catch {
        // 拿不到快照（服务端刚重启 / 连接断了）：本地那份仍然可读，下一轮还会再同步
        snapshot = null;
      }
    }
    this.stream.settle(snapshot);
    // 失败原因进状态（`failed` 是终态）：文案由应用决定，包不产句子
    if (failure) this.stream.failTurn(failure);
    // 消息已经是服务端那份了：此刻起「这一轮已收尾」才对 `waitForTurn()` 成立
    this.lastEndedTurn = Math.max(this.lastEndedTurn, turnId);
    this.resolveTurn(turnId);
    this.notify(true);
  }

  /** 唤醒等待中的 `waitForTurn()`；带 turnId 时只唤醒它自己等的那一轮 */
  private resolveTurn(turnId?: number): void {
    if (turnId !== undefined && this.pendingTurn && this.pendingTurn.turnId !== turnId) return;
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    pending?.resolve();
  }

  /**
   * 让等着的 `waitForTurn()` 以错失败。
   *
   * 「连不回来」那条路用它：那一轮的 `session-turn-end` 已经不可能到达了，而 promise 不能永远悬着
   * （界面靠它恢复输入）。错误走的就是既有的那条渠道 —— 与 socket 断开时在飞调用被拒同一个
   * 口径，不新造一套。只动 `pendingTurn`：本地消息、阶段一概不碰。
   */
  private failPendingTurn(error: Error): void {
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    pending?.reject(error);
  }

  private async syncSubAgent(subAgentId: string): Promise<void> {
    this.stream.subAgentSnapshot(await this.sessions!.subAgentSnapshot(this.sessionId, subAgentId));
  }

  private async syncFromServer(): Promise<void> {
    this.stream.applySnapshot(await this.sessions!.snapshot(this.sessionId));
  }

  private async answerQuestion(event: SessionQuestionEvent): Promise<void> {
    const choice = await this.answerChoice(event);
    // 只带 `questionId`：它本身就能定位到问题（UUID 全局唯一），会话 id 递上去只是多一处配对
    await this.sessions!.answer(event.questionId, choice);
  }

  /**
   * 按 `kind` 分派「怎么答」。
   *
   * **分派不在包里**：协议允许客户端按 `kind` 扩展（今天只有 `handoff-mode`），但「哪一类问题
   * 弹哪个选择器」是应用的界面决定 —— 所以整条分派逻辑都在应用注入的
   * `policy.answerQuestion` 里（它拿到 `event.kind` 自己决定）。包只负责两条降级：
   * **没得问**（没注入选择器，无头 / 测试场景）与**问崩了**（回调自己抛错：面板被别的交互
   * 拆掉、渲染异常），两条都回服务端的 `fallback`。
   *
   * 为什么降级不是「等一会儿」：服务端此刻正卡在提问上等答复，沉默的代价是要等满超时才
   * 降级，那一轮就一直停在迁移里。
   */
  private async answerChoice(event: SessionQuestionEvent): Promise<string | null> {
    if (!this.policy.answerQuestion) return event.fallback;
    try {
      return await this.policy.answerQuestion(event);
    } catch {
      return event.fallback;
    }
  }

  private notify(immediate: boolean): void {
    this.policy.onChange?.(immediate);
  }

  // ==================== 断线重连 ====================

  /**
   * 连接断了的唯一入口。
   *
   * 两个不重连的理由：`disposed`（是我们自己关的）与 `reconnecting`（上一次还没跑完，
   * 单飞）。会话换了 id（`/migrate`、自动迁移）**不是**理由 —— `attach` 用的是重连那一刻
   * 的 `sessionId`，接的永远是当前这一段。
   */
  private handleClose(): void {
    if (this.disposed || this.reconnecting) return;
    void this.reconnect();
  }

  /**
   * 重建连接并把会话接回来：最多 {@link MAX_RECONNECT_ATTEMPTS} 次，失败就走既有错误通道。
   *
   * 每一次「尝试」都是完整的一段：拿连接 → `watch()` → `attach()` → 快照（见 {@link restore}）。
   * 半途失败（连接建不起来、`attach` 被拒）算这次失败，接着试；`session-missing` 不一样，
   * 那是**服务端说这段会话没了**（存档被删、服务端换了台实例）—— 再试三次也是同一个答案。
   */
  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.disposed) return;
    this.reconnecting = true;
    try {
      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          await this.clock.sleep(RECONNECT_BACKOFF_MS[attempt - 2] ?? 0);
        }
        // 等待期间用户退出了：不再拉连接，也不再往界面上推任何东西
        if (this.disposed) return;
        const outcome = await this.restore();
        if (outcome.status === "ok") return;
        if (outcome.status === "gone") {
          // 会话已经结束：重连没有意义。在飞的那一轮以服务端给的原话失败，状态也标终态
          this.stream.failTurn({
            // 沿用服务端给的码（`session-missing` / `unknown-session`），拿不到时用第一个
            code: codeOf(outcome.error) ?? "session-missing",
            message: outcome.error.message,
          });
          this.failPendingTurn(outcome.error);
          return;
        }
        if (this.disposed) return;
      }
      // 三次都没接上：保持既有行为 —— 在飞的调用以连接错误失败，之后的调用同样失败
      // （`this.client` 仍是那条断掉的连接，`call()` 会直接拒）。不无限重试、不静默吞掉。
      const lost = connectionLostError(this.client?.address);
      // 状态也标终态：否则界面会永久停在「生成中」（`failed` 只能被下一轮或换基线清掉）。
      // 只有真有一轮在飞时才标 —— 空闲时的断线不是「某一轮失败」。
      if (this.stream.state.status === "streaming") {
        // `code` 是**客户端**造的（不是线上码）：连接都没了，服务端没有机会给出原因
        this.stream.failTurn({ code: "connection-lost", message: lost.message });
      }
      this.failPendingTurn(lost);
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * 在新连接上把会话接回来：订阅 → `watch()` → `attach()` → 一次快照对齐屏幕。
   *
   * 两处顺序是必须的：**订阅先于 `attach`**（接上之后服务端可能立刻推事件，`phase` 最先），
   * 以及**整段成功才换上去**（`commit`）：半途失败时 `this.client` 仍是那条断掉的连接，
   * 「断了就用不了」这条语义不被半成品污染。
   *
   * 注意：**失败时不关连接**。连接是进程级共享的
   * （`ServerConnection`），这次 attach 失败不代表那条连接没用了 —— 关掉会连累别的会话。
   */
  private async restore(): Promise<RestoreOutcome> {
    let client: ServerClient;
    try {
      client = await this.connection.client();
    } catch {
      return { status: "retry" };
    }
    if (this.disposed) return { status: "retry" };

    const sessions = new RemoteSessions(client);
    const offs = this.wire(client);

    // 阶段一：只在这条**新**连接上做事。任何一步失败都算这次尝试失败，
    // 手上的连接原封不动（还是那条断掉的），不会留下半接上的状态。
    let snapshot: SessionSnapshotResult;
    try {
      // 在这条（新的）连接上订阅事件。重复调用无害：这条连接上次已订过就是空操作
      await this.connection.watch();
      // 接回**同一段**会话：活着就接上（Agent 与 MCP 连接都还在），盘上有就装回来。
      // id 用**此刻**的状态里的那个 —— 断线期间若它变了（自动迁移），接回来的该是新的那段
      await sessions.attach({
        workspaceId: this.workspaceIdValue,
        sessionId: this.sessionId,
        ...(this.pathValue ? { path: this.pathValue } : {}),
        ...(this.agentIdValue ? { agentId: this.agentIdValue } : {}),
      });
      snapshot = await sessions.snapshot(this.sessionId);
    } catch (error) {
      for (const off of offs) off();
      return isSessionGone(error) ? { status: "gone", error: error as Error } : { status: "retry" };
    }

    // 快照拿到之后、换上去之前它断了（或用户在这期间退出了）：当这次没接上。
    // 换上去的话「断了」的订阅永远等不到通知（`failAll` 已经跑完了），那才是真正的死局。
    if (client.closed || this.disposed) {
      for (const off of offs) off();
      return { status: "retry" };
    }

    // 阶段二：换成新连接，然后落定屏幕。能走到这里说明已经接上了 —— 这一段再出错也不该
    // 把刚接上的连接扔掉重试（那只会把同一件事再错一遍）。
    this.commit(client, sessions, offs);
    // 换基线：消息、阶段、模型、子 Agent 全部以这份快照为准
    this.stream.applySnapshot(snapshot);

    if (snapshot.phase === null) {
      /**
       * 服务端已经空闲：那一轮的 `session-turn-end` 丢在断线里了。
       *
       * 用**与真事件完全相同**的收尾路径（同一个 `finishTurn`），只是快照用刚拿到的那份 ——
       * 它就是这一轮的结果，按成功落定。`turnId` 取两者较大值：服务端重启后轮次计数从 0
       * 重来（`snapshot.turnId` 可能比我们等的那一轮小），而「服务端已空闲」意味着**我们等
       * 的那一轮已经结束** —— 落定它才是目的，不能让一个重启过的计数器把 promise 永远挂着。
       */
      const turnId = Math.max(snapshot.turnId, this.pendingTurn?.turnId ?? 0);
      await this.finishTurn(turnId, undefined, snapshot);
    } else {
      // 服务端还在跑这一轮：事件会继续来，接着等（不落定、不猜结果）
      this.notify(true);
    }
    return { status: "ok" };
  }

  /**
   * 换成新连接：旧连接的事件订阅全部作废，换上新的一套。
   *
   * 旧订阅必须在这里解掉：它们指向一条已经 destroy 的 socket，留着不但没用，还会让
   * `this.offs` 越积越长（每次重连多一组）。
   */
  private commit(client: ServerClient, sessions: RemoteSessions, offs: Array<() => void>): void {
    for (const off of this.offs.splice(0)) off();
    this.client = client;
    this.sessions = sessions;
    this.offs.push(...offs);
  }

  /** 首次接线：设好连接与门面，并把事件订阅挂上（`open()` 里的第一件事） */
  private install(client: ServerClient): void {
    this.client = client;
    this.sessions = new RemoteSessions(client);
    for (const off of this.offs.splice(0)) off();
    this.offs.push(...this.wire(client));
  }
}
