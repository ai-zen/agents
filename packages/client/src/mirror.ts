/**
 * 一段会话的**镜像**：按到达的事件把 `messages` 重建出来，另外记住**四件事**（忙闲 / 输入闸 /
 * 输出闸 / 死活）、subagent 名册与交接态。
 *
 * ## 为什么要镜像，以及它凭什么与宿主逐字一致
 *
 * 断线即作废、不重放、不 ack（`packages/host/src/wire/events.ts` 开头）：所以「现在有哪些消息、
 * 每条长什么样」只能由客户端拿**两样原料**自己攒出来：
 *
 *   · 一帧一帧的到达事件（`message.added` / `message.delta` / `message.changed` / `message.removed`）；
 *   · 打开或重连时 `message.list` 拉回来的那一份快照（全量，或从本地最后一条 id 起的增量）。
 *
 * 攒的规则里最容易出错的是「一片增量怎么折进一条消息」：正文拼串、内容段数组、工具参数串的
 * 两种厂商行为 —— 每条都有自己的边界情形。所以这里**不自己写**这套规则，直接调 core 的
 * `applyChunk`：宿主跑 agent 时攒消息用的就是它，同一份函数在两边跑，入参也是同一片东西
 * （`message.delta` 载荷里的 `AgentNS.Delta` 原样）—— 于是攒出来的那条消息与宿主存下来的
 * 逐字一致。这就是「完美镜像」的全部保证。
 *
 * 用量与结束原因**不在这片增量里**（它们是那次响应的外层字段，不进 `applyChunk`）：它们跟着
 * `message.changed` 整条回来。
 *
 * ## 只管这三样东西
 *
 * ① `messages`：主线一栏 + 按 `toolCallId` 归好的 subagent 各栏；
 * ② **四件事各占一格**（`PRD.md` 4.4）：忙闲 `status`（`working` / `idle`）、输入闸 `inputPaused`、
 *    输出闸 `outputPaused`、死活 `alive`。它们各有自己的来路 —— 忙闲来自 `state`，两道闸来自
 *    `output:paused` / `output:resumed` / `input:paused` / `input:resumed`，死活来自
 *    `session.changed` 的 `agent_started` / `agent_gone`；打开会话时由 `session.state`
 *    一次补齐。**没读到就是 `null`**（不是「死」，也不是「闲」：那两样都是要报给用户看的事实，
 *    拿它们当「还没读到」的占位就是借词）；
 * ③ `session.state` 的另外两格：subagent **名册**（只用来铺栏）与**交接态**
 *    （非空即「正在交接」）。交接态还有一条在线时的来路：`session.changed` 的
 *    `handoff_started` 把它置起来、`memory_replaced` 把它收掉（见 {@link SessionMirror} 的
 *    `sessionChanged`）—— 不然长时间在线、不重拉读数的窗口永远学不到「交接开始了」。
 *
 * **四件事不合成一格**：`status` 说「它会不会马上动」，两道闸说「它收不收 / 取不取」，
 * `alive` 说「还有没有那个对象」。按钮只读后三样（活着？闸开着？），与忙闲无关。
 *
 * subagent 那一栏的消息**一律来自事件**（每条消息事件都带 `toolCallId`）：subagent 不入库，
 * 也就没有第二个地方可以补 —— 重连之后靠名册把栏铺回来，内容靠之后的事件继续长。
 *
 * 用量**不在这里**：每条消息自带 `usage`，要显示就把消息上的 `usage` 自己加起来（core 不管
 * 用量，没有求和函数）—— 客户端不为了用量再养一条事件与一份汇总，那两份东西与消息上的事实
 * 迟早对不上。
 *
 * ## 就地改，不返回新对象
 *
 * `applyChunk` 的契约就是「就地攒进 `receiver`」。于是镜像里的消息对象是**活的**：读的人拿到
 * 的数组与对象会被后续增量就地更新。界面要重画，请按到达的事件重画，不要靠比较引用 ——
 * 引用一直是同一个。
 */

import { applyChunk } from "@ai-zen/agents-core";
import type {
  AgentNS,
  SessionActivity,
  SessionChangeKind,
  SessionState,
  EventPayload,
} from "@ai-zen/agents-host";

/**
 * 与镜像有关的一条事件（事件名 + 载荷，判别结构）。
 *
 * 另外三个事件与镜像无关：`notice` / `question` / `error` —— 它们说的不是「哪条消息怎么了」，
 * 也不是那四件事。`session.changed` **认领**，但只认其中三格：`agent_started` /
 * `agent_gone`（死活）与交接态那两格 `handoff_started` / `memory_replaced`
 * （见 {@link SessionMirror} 的 `sessionChanged`）。
 *
 * 两道闸那四条事件**各自一格**（与宿主的事件名逐字相同）：名字自己就说清了「哪一道、开还是关」，
 * 所以镜像这一层不再多造一个中间形状。
 */
export type MirrorEvent =
  | { kind: "message.added"; payload: EventPayload<"message.added"> }
  | { kind: "message.delta"; payload: EventPayload<"message.delta"> }
  | { kind: "message.changed"; payload: EventPayload<"message.changed"> }
  | { kind: "message.removed"; payload: EventPayload<"message.removed"> }
  | { kind: "state"; payload: EventPayload<"state"> }
  | { kind: "output:paused"; payload: EventPayload<"output:paused"> }
  | { kind: "output:resumed"; payload: EventPayload<"output:resumed"> }
  | { kind: "input:paused"; payload: EventPayload<"input:paused"> }
  | { kind: "input:resumed"; payload: EventPayload<"input:resumed"> }
  | { kind: "session.changed"; payload: EventPayload<"session.changed"> };

/**
 * 一条事件折成 {@link MirrorEvent}；与镜像无关的事件返回 `null`。
 *
 * 判据是事件名（`EventMap` 里的名字），不是载荷长什么样：宿主加了新事件时，这里的行为是
 * 「不认识就交给别人」，不是猜一个含义。
 */
export function toMirrorEvent(event: string, payload: unknown): MirrorEvent | null {
  switch (event) {
    case "message.added":
      return { kind: "message.added", payload: payload as EventPayload<"message.added"> };
    case "message.delta":
      return { kind: "message.delta", payload: payload as EventPayload<"message.delta"> };
    case "message.changed":
      return { kind: "message.changed", payload: payload as EventPayload<"message.changed"> };
    case "message.removed":
      return { kind: "message.removed", payload: payload as EventPayload<"message.removed"> };
    case "state":
      return { kind: "state", payload: payload as EventPayload<"state"> };
    case "output:paused":
      return { kind: "output:paused", payload: payload as EventPayload<"output:paused"> };
    case "output:resumed":
      return { kind: "output:resumed", payload: payload as EventPayload<"output:resumed"> };
    case "input:paused":
      return { kind: "input:paused", payload: payload as EventPayload<"input:paused"> };
    case "input:resumed":
      return { kind: "input:resumed", payload: payload as EventPayload<"input:resumed"> };
    case "session.changed":
      return {
        kind: "session.changed",
        payload: payload as EventPayload<"session.changed">,
      };
    default:
      return null;
  }
}

/** 某一栏 subagent 的消息（`toolCallId` = 那次委派的工具调用 id） */
export interface SubAgentColumn {
  toolCallId: string;
  messages: readonly AgentNS.Message[];
}

/**
 * 名册上的一行：哪一个 subagent、叫什么、跑到哪一格了（`session.state.subAgents` 原样）。
 *
 * 它只用来**铺栏**（重连之后一次问清有哪些栏），栏里的消息一律来自事件（`toolCallId`）——
 * subagent 的消息不入库，也就没有第二个地方可以补。
 */
export interface SubAgentFact {
  toolCallId: string;
  name: string;
  state: AgentNS.AgentState | "ended";
}

/**
 * 镜像的一份只读样子（给界面与用例看，不是另一份数据）。
 *
 * 四件事各占一格，字段名与宿主 `session.state` 的同名同义。每一格 `null` = **还没读到**：
 * 镜像刚建出来时（打开会话的这一刻）什么都还没读到，所以四件都是 `null` —— 不是「死」（界面会去
 * 提示复活一段其实好端端的会话），也不是「闲」（界面会以为它会理你）。拿到读数（`applyReadout`）
 * 之后四件一次补齐，之后各自由自己的事件换下去。
 */
export interface MirrorSnapshot {
  sessionId: string;
  /** 闲 / 忙（`working` / `idle`）：只读的观测值，来自 `state` */
  status: SessionActivity | null;
  /** 输入闸：`true` = 关着（投递进不来），来自 `input:paused` / `input:resumed` */
  inputPaused: boolean | null;
  /** 输出闸：`true` = 关着（不取 inbox），来自 `output:paused` / `output:resumed` */
  outputPaused: boolean | null;
  /** 死活：这一段此刻有没有 agent 实例，来自 `agent_started` / `agent_gone` */
  alive: boolean | null;
  /** 主线消息（不属于任何 subagent 的那些），顺序即会话里的先后 */
  messages: readonly AgentNS.Message[];
  /** 按 `toolCallId` 归好的 subagent 各栏 */
  subAgents: SubAgentColumn[];
  /** 名册（现读的那一份；没读过就是空） */
  roster: SubAgentFact[];
  /** 非空就是「正在交接」（不在那四件事里：交接期间这一段照旧有自己的忙闲与两道闸） */
  handoff: { since: string } | null;
}

/** 一段会话的镜像：主线一栏、subagent 各一栏、四件事各一格，外加名册与交接态 */
export class SessionMirror {
  readonly sessionId: string;
  /** 忙闲；还没读到就是 `null`（见 {@link MirrorSnapshot.status}） */
  private statusValue: SessionActivity | null = null;
  /** 输入闸：`true` = 关着；还没读到就是 `null` */
  private inputPausedValue: boolean | null = null;
  /** 输出闸：`true` = 关着；还没读到就是 `null` */
  private outputPausedValue: boolean | null = null;
  /** 死活：有没有 agent 实例；还没读到就是 `null` */
  private aliveValue: boolean | null = null;
  private main: AgentNS.Message[] = [];
  private readonly columns = new Map<string, AgentNS.Message[]>();
  private rosterValue: SubAgentFact[] = [];
  private handoffValue: { since: string } | null = null;
  /**
   * 「这一条是从快照里来的」—— 只在打开会话的那一小段时间有意义。
   *
   * 打开时先订阅、再拉快照，拉取期间到达的事件先攒着，快照落地之后按序补上。补的那一批里，
   * 属于快照已包含的那些消息的增量**不再折一遍**：快照里的内容已经是它的最新样子，再折一次
   * 就是同一段字写两遍。宁可少写（下一条 `message.changed` 会把整条带回来）也不写重。
   */
  private fromSnapshot = new Set<string>();

  /**
   * 建出来时**四件都是 `null`（还没读到）**：打开会话的那一刻 `session.state` 还没回来，
   * 而这四件都是要报给用户看的事实 —— 拿其中任何一个去占位，读的人就分不出「这段真的没人 /
   * 真的不收话」与「我还没读到」。
   */
  constructor(init: { sessionId: string }) {
    this.sessionId = init.sessionId;
  }

  /** 忙闲（`working` / `idle`）；还没读到就是 `null` */
  get status(): SessionActivity | null {
    return this.statusValue;
  }

  /** 输入闸：`true` = 关着；还没读到就是 `null` */
  get inputPaused(): boolean | null {
    return this.inputPausedValue;
  }

  /** 输出闸：`true` = 关着；还没读到就是 `null` */
  get outputPaused(): boolean | null {
    return this.outputPausedValue;
  }

  /** 死活：有没有 agent 实例；还没读到就是 `null` */
  get alive(): boolean | null {
    return this.aliveValue;
  }

  /** 名册（现读的那一份；客户端只用它铺栏） */
  get roster(): readonly SubAgentFact[] {
    return this.rosterValue;
  }

  /** 正在交接就是它的开始时刻；不在交接就是 `null` */
  get handoff(): { since: string } | null {
    return this.handoffValue;
  }

  /** 主线消息 */
  get messages(): readonly AgentNS.Message[] {
    return this.main;
  }

  /** 某一栏 subagent 的消息（没有那一栏就是空数组） */
  subAgent(toolCallId: string): readonly AgentNS.Message[] {
    return this.columns.get(toolCallId) ?? [];
  }

  /** 一份只读样子（四件事各一格，客户端一次拿到） */
  snapshot(): MirrorSnapshot {
    return {
      sessionId: this.sessionId,
      status: this.statusValue,
      inputPaused: this.inputPausedValue,
      outputPaused: this.outputPausedValue,
      alive: this.aliveValue,
      messages: [...this.main],
      subAgents: [...this.columns.entries()].map(([toolCallId, messages]) => ({
        toolCallId,
        messages: [...messages],
      })),
      roster: [...this.rosterValue],
      handoff: this.handoffValue,
    };
  }

  /** 主线最后一条的 id —— 重连时 `message.list` 的 `after` 就是它 */
  lastMessageId(): string | undefined {
    return this.main.at(-1)?.id;
  }

  /** 换忙闲这一格（`state` 事件的载荷） */
  applyActivity(status: SessionActivity): void {
    this.statusValue = status;
  }

  /** 输出闸关了（`output:paused`）：从下一批起不取 inbox，手上那批照跑 */
  applyOutputPaused(): void {
    this.outputPausedValue = true;
  }

  /** 输出闸开了（`output:resumed`）：又开始取件 */
  applyOutputResumed(): void {
    this.outputPausedValue = false;
  }

  /** 输入闸关了（`input:paused`）：投递进不来（只有 `stop` / `kill` 关它） */
  applyInputPaused(): void {
    this.inputPausedValue = true;
  }

  /** 输入闸开了（`input:resumed`）：又开始收投递 */
  applyInputResumed(): void {
    this.inputPausedValue = false;
  }

  /** 换死活这一格（`agent_started` → `true`、`agent_gone` → `false`） */
  applyAlive(alive: boolean): void {
    this.aliveValue = alive;
  }

  /**
   * 收下 `session.state` 的全部四件事 + 名册 + 交接态。
   *
   * 这也是那四件从 `null`（还没读到）**真正变成事实**的那一刻；之后各自被自己的事件换下去
   * （`applyActivity` / `applyOutputPaused` 这一类 / `applyAlive`）。
   *
   * 名册只**加栏、不删栏**：它说的是「这一段此刻有哪几个 subagent」，而栏里的消息是事件一条
   * 一条攒起来的。名册被清空（下一批开始了）不等于那些话没说过 —— 所以已经攒下的栏原样留着。
   *
   * 交接态非空就是「正在交接」：界面要把它与那四件事分开显示（交接期间输入框拦住、只留中断）。
   * 读数只是它的一条来路：在线时 `handoff_started` 那条事件会把它置起来（见
   * {@link SessionMirror} 的 `sessionChanged`），`memory_replaced` 会把它收掉。
   */
  applyReadout(
    state: Pick<
      SessionState,
      "status" | "inputPaused" | "outputPaused" | "alive" | "subAgents" | "handoff"
    >,
  ): void {
    this.statusValue = state.status;
    this.inputPausedValue = state.inputPaused;
    this.outputPausedValue = state.outputPaused;
    this.aliveValue = state.alive;
    this.rosterValue = [...state.subAgents];
    this.handoffValue = state.handoff;
    // 名册上有的栏先摆出来（空栏也是一栏），之后到达的事件往里面长
    for (const fact of state.subAgents) this.columnOf(fact.toolCallId);
  }

  /**
   * 整段替换主线（`message.list` 的全量、重连时本地最后一条 id 已经不在、`memory_replaced`
   * 之后的重拉）。
   *
   * subagent 那几栏**不动**：`message.list` 不带 `toolCallId` 时只回主线，把它们清掉等于把
   * 手里已有的那几栏凭空丢掉；而 subagent 的消息不入库，**没有**「再拉一次某一栏」这回事
   * （重连之后靠名册把栏铺回来，内容靠之后的事件继续长）。
   */
  replaceAll(messages: readonly AgentNS.Message[]): void {
    this.main = [...messages];
    this.noteSnapshot(messages);
  }

  /**
   * 替换 + 追加（重连时本地最后一条 id 还在）。
   *
   * 宿主回的**第一条就是 `anchor` 那条**，内容是它最新样子（上次拿到的可能正是流式中那一条，
   * 这段时间里它的内容变了）。所以从 `anchor` 起整段换成宿主给的：本地在它之前的部分原样留着，
   * 它自己与它之后的全部按宿主的来 —— 这叫替换，不是又追加一条（追加会在屏幕上留一段过期正文）。
   *
   * 本地找不到 `anchor`（被撤回 / 换过库）时按全量整段替换（那种情形宿主回的也是全量）。
   */
  mergeFrom(anchor: string | null, messages: readonly AgentNS.Message[]): void {
    const index = anchor === null ? -1 : this.main.findIndex((message) => message.id === anchor);
    if (index < 0) {
      this.replaceAll(messages);
      return;
    }
    this.main = [...this.main.slice(0, index), ...messages];
    this.noteSnapshot(messages);
  }

  /**
   * 折一条事件进来。
   *
   * `replay: true` 表示这是「打开会话期间攒下、快照落地之后补上」的那一批（见
   * {@link SessionMirror.fromSnapshot} 的说明）。
   */
  apply(event: MirrorEvent, options: { replay?: boolean } = {}): void {
    switch (event.kind) {
      case "state":
        this.applyActivity(event.payload.status);
        return;
      case "output:paused":
        this.applyOutputPaused();
        return;
      case "output:resumed":
        this.applyOutputResumed();
        return;
      case "input:paused":
        this.applyInputPaused();
        return;
      case "input:resumed":
        this.applyInputResumed();
        return;
      case "message.added":
        this.added(event.payload.message, event.payload.toolCallId, options.replay === true);
        return;
      case "message.changed":
        this.changed(event.payload.message, event.payload.toolCallId);
        return;
      case "message.removed":
        this.removed(event.payload.messageId, event.payload.toolCallId);
        return;
      case "message.delta":
        this.delta(event.payload, options.replay === true);
        return;
      case "session.changed":
        this.sessionChanged(event.payload.change, event.payload.at);
        return;
    }
  }

  /** 一批补完：之后到达的增量不再受「快照已包含」这条限制 */
  endReplay(): void {
    this.fromSnapshot.clear();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * `session.changed` 里只有两格与交接态有关：
   *
   *   · `handoff_started` —— 交接**开始**这一拍。置成「正在交接」，`since` 就是这条事件的 `at`
   *     （与 `applyReadout` 收到的那一格同形）。两件事都靠它：长时间在线、不重拉读数的窗口靠它
   *     学到「交接开始了」；收口那一拍（`memory_replaced`）要等交接跑完才有，不能靠它开头。
   *   · `memory_replaced` —— **收口**。交接提交（记忆已经换掉）与回滚（记忆回到交接前）两处都推
   *     它 —— 所以「成功 / 失败 / 取消」在这条上已经收成了同一件事：收到就清回 `null`（那一刻
   *     记忆已经换完，交接结束了）。
   *
   * 其余 change（`created` / `renamed` / `pinned` / `settings_changed` / `deleted`）与交接态无关，
   * 一格都不动。
   *
   * 这里**只改交接态这一格**：不触发 `message.list` / `session.state` —— 要不要重拉是
   * `Client` 那一层的事（`memory_replaced` 的重拉见 `client.ts` 的 `reloadOnMemoryReplaced`），
   * 镜像自己不去拉任何东西。
   */
  private sessionChanged(change: SessionChangeKind, at: string): void {
    if (change === "agent_started") this.aliveValue = true;
    else if (change === "agent_gone") this.aliveValue = false;
    else if (change === "handoff_started") this.handoffValue = { since: at };
    else if (change === "memory_replaced") this.handoffValue = null;
  }

  private added(message: AgentNS.Message, toolCallId: string | undefined, replay: boolean): void {
    const column = this.columnOf(toolCallId);
    const index = column.findIndex((existing) => existing.id === message.id);
    if (index < 0) {
      column.push(message);
      return;
    }
    // 已经有了这一条：补的那一批里以快照为准（快照比它新），实时到达的直接整条换掉
    if (!replay) column[index] = message;
  }

  private changed(message: AgentNS.Message, toolCallId: string | undefined): void {
    const column = this.columnOf(toolCallId);
    const index = column.findIndex((existing) => existing.id === message.id);
    // 整条替换，不做字段级合并：消息上的字段一律整条带
    if (index < 0) column.push(message);
    else column[index] = message;
    this.fromSnapshot.delete(message.id);
  }

  private removed(messageId: string, toolCallId: string | undefined): void {
    const column = this.columnOf(toolCallId);
    const index = column.findIndex((existing) => existing.id === messageId);
    if (index >= 0) column.splice(index, 1);
    this.fromSnapshot.delete(messageId);
  }

  private delta(payload: EventPayload<"message.delta">, replay: boolean): void {
    const column = this.columnOf(payload.toolCallId);
    const message = column.find((existing) => existing.id === payload.messageId);
    // 认不出是哪条：它属于打开之前的那一段（快照里已经有它），这一片没有可折的地方
    if (!message) return;
    // 快照里已经有它，补的那一批再折一遍就是同一段字写两遍
    if (replay && this.fromSnapshot.has(payload.messageId)) return;
    // 与宿主攒消息用的是同一个函数，入参也是同一片东西：`message.delta` 的载荷
    // 就是 core 的 `AgentNS.Delta`，原样交给 `applyChunk`，不必包成别的形状。
    // 用量与结束原因不在这里（它们不属于增量）：那条消息定下来时由 `message.changed` 整条带回来。
    applyChunk(message, payload.delta);
  }

  /** 一条消息该放进哪一栏：给了 `toolCallId` 就是那一栏，没给就是主线 */
  private columnOf(toolCallId: string | undefined): AgentNS.Message[] {
    if (toolCallId === undefined) return this.main;
    const existing = this.columns.get(toolCallId);
    if (existing) return existing;
    const created: AgentNS.Message[] = [];
    this.columns.set(toolCallId, created);
    return created;
  }

  private noteSnapshot(messages: readonly AgentNS.Message[]): void {
    this.fromSnapshot = new Set(messages.map((message) => message.id));
  }
}
