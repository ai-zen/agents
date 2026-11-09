/**
 * 会话管理器 —— 服务端「活着的会话」与**事件流**的源头。
 *
 * ## 它管什么、不管什么
 *
 * 管：会话的创建/关闭、一轮对话的编号（`turnId`）、把 SDK 的事件翻译成协议事件
 * （阶段、正文增量、轮次收尾）、按阶段算出「谁还在跑」。
 *
 * 不管：Agent 怎么装配（配置、Scope、工具发现）——那由**组装根**通过 `createAgent`
 * 注入；也不管存档（那是 `SessionStore` 与客户端的落盘插件的事）。
 * 这条边界是为了让本文件可测：给一个假 Agent 就能跑完整个事件流程，不需要网络。
 *
 * ## 为什么事件出口是 `subscribe()` 而不是构造参数
 *
 * 一个会话可能被多个客户端看（终端 + 桌面端同时连）。广播是管理器的职责，
 * 「推给哪条连接」是守护进程的职责（它知道谁连着）。
 */

import { PhaseTracker, pendingToolCalls, type PhaseInfo } from "../progress/PhaseTracker.js";
import type { SessionRef, SessionStore } from "../store/SessionStore.js";
import { EventHub } from "../events/EventHub.js";
import { SessionHandoff, isHandoffAborted, type HandoffAgentLike } from "../handoff/SessionHandoff.js";
import {
  SESSION_EVENTS,
  type HandoffMode,
  type NoticeLevel,
  type ServerEvent,
  type SessionHandoffResult,
  type SessionMigrateResult,
  type SessionNoticeCode,
  type SessionSnapshotResult,
  type SessionSummary,
} from "../../protocol/sessions.js";

/**
 * 能跑一轮对话的 Agent 的最小面。
 *
 * 结构性类型（不是 SDK 的 `Agent`）：SDK 的 Agent 天然满足它，本包也不必把
 * core 的类型体系拖进来 —— 与本包 `PhaseMessageLike` 同一个理由、同一个 `*Like` 后缀。
 *
 * 不叫 `SessionAgent`：那读起来像「一种 Agent」，而它只是 Agent 的一个**面**（能跑会话）。
 */
export interface AgentLike {
  /** 当前消息列表。**可写**：续接存档时由会话管理器整体换成存档里的那份 */
  messages: unknown[];
  /** 最近一轮用量（SDK 的 Agent 有；假件可以不给） */
  readonly lastUsage?: unknown;
  /** 返回本轮产出（SDK 返回 `Message[]`）；会话管理器不看它，进展走事件 */
  send(input: string): Promise<unknown>;
  abort(): void;
  events: {
    on(event: string, handler: (payload: any) => void): void;
    off(event: string, handler: (payload: any) => void): void;
  };
}

export interface CreateAgentInput {
  workspaceId: string;
  /** 工作区路径（Agent 的 cwd：工具、相对路径都以它为基准） */
  path: string;
  agentId: string;
  /**
   * 交接/迁移进行中？装配方据此接上 `ContextGuardPlugin.isSuspended`。
   *
   * 不接的话，交接回合本身就是「上下文最满」的时刻，会被硬线直接掐死。
   */
  isHandoffBusy?: () => boolean;
  /**
   * 自动迁移的落地动作（**会话层提供**：存档、换 id、事件都在它手里）。
   *
   * 不给就不装自动迁移：没有交接能力时该让硬线拦，而不是让 SDK 去调一个不存在的服务。
   */
  autoMigrate?: () => Promise<void>;
}

/** `create()` 的入参：`agentId` / `sessionId` 都可省，前者补 `default`，后者由服务端分配 */
export interface SessionCreateInput {
  workspaceId: string;
  path: string;
  agentId?: string;
  sessionId?: string;
}

export interface SessionManagerOptions {
  /** 造一个能跑一轮对话的 Agent。装配细节全在注入方，本包不碰配置与 Scope */
  createAgent: (input: CreateAgentInput) => Promise<AgentLike>;
  /**
   * 新会话的 id 生成器（客户端没指定时用）。
   *
   * 默认按与存档文件名同一套格式：`chat_YYYY_MM_DD_HH_mm_ss` —— 活会话与存档共用
   * 一个 id，续接时不会出现「内存叫 sess_3、盘上叫 chat_2026…」这种两套编号。
   */
  nextSessionId?: () => string;
  /**
   * 某个工作区的会话存档（续接与 `session.save` 用）。不注入则两者都不可用。
   *
   * 注入成**函数**而不是实例：一个进程服务多个工作区，每个工作区一份存档。
   */
  storeFor?: (workspaceId: string) => SessionStore | Promise<SessionStore>;
  /**
   * 让装配方丢掉某个工作区缓存的 Scope（配置可能已变）。
   * 不注入则 `reload()` 仍会重建 Agent，但沿用旧 Scope —— 端点凭据这类改动不会生效。
   */
  invalidateScope?: (workspacePath: string) => Promise<void>;
  /**
   * 事件出口。不注入则自建一个（单测方便）；组装根会传自己的，
   * 这样**全局通知**也能走同一条推送线。
   */
  hub?: EventHub;
  /**
   * 交接需要的路径根（`aiZenDir` / `homeDir`）。不注入则 `handoff` / `migrate` 明确报
   * `no-handoff` —— 交接要读磁盘上的 `handoff` Skill，本层不自己猜路径。
   */
  handoff?: { aiZenDir: string; homeDir: string };
}

interface LiveSession {
  id: string;
  workspaceId: string;
  /** 工作区路径：重建 Agent（reload）时要再交给装配方 */
  path: string;
  agentId: string;
  agent: AgentLike;
  turnId: number;
  phase: PhaseTracker;
  /** 本轮是否已经出过错（`error` 与 `finally` 都会到，收尾只报一次） */
  turnFailed: { code: string; message: string } | null;
  turnSettled: boolean;
  /**
   * 这一轮的收尾由交接/迁移方法自己负责（见 `settleTurn`）。
   *
   * 交接回合本身也是一次 `agent.send()`，SDK 会照常发 `finally`；不拦一下，
   * `self` 模式会在文档还没校验、历史还没剔除时就宣布本轮结束。
   */
  settleDeferred: boolean;
  /** 交接服务（首次交接时创建；持有取消句柄，见 `handoffOf`） */
  handoff: SessionHandoff | null;
  detach: () => void;
}

/**
 * 默认的会话 id：`chat_YYYY_MM_DD_HH_mm_ss`。
 *
 * 与存档文件名的格式一致（同一个 id 既标识内存里的会话，也是落盘的文件名）。
 * 同一秒内连开两个会话会撞 id —— 撞了就由 `create()` 回 `session-exists`，
 * 不靠“再猜一个后缀”掩盖（客户端本来就会带上自己的 id）。
 */
function defaultNextSessionId(): string {
  return `chat_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "_")}`;
}

/** 带机器可判别 code 的错误（守护进程原样回给客户端） */
function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error as Error & { code: string };
}

/**
 * 会话管理器只持有 Agent「能跑一轮」那一面（`AgentLike`，为了能用假件测完整个事件流）；
 * 交接需要更宽的那面（定义模板、工具表、`use()`）—— 同一个对象，只是视图不同。
 *
 * 收在这里而不是散在调用点：这一句在说「真件必须满足交接的要求」，散开就成了隐式约定。
 */
function asHandoffAgent(agent: AgentLike): HandoffAgentLike {
  return agent as unknown as HandoffAgentLike;
}

/**
 * 当前 Agent 绑定的模型 id。
 *
 * 真相源是 Agent 定义（`definition.modelId`），不是会话 —— 会话不记模型；
 * 与会话相关但不在 `AgentLike` 里，所以还是「同一个对象、更宽的视图」。
 */
function modelIdOf(agent: AgentLike): string {
  const definition = (agent as { definition?: { modelId?: unknown } }).definition;
  return typeof definition?.modelId === "string" ? definition.modelId : "";
}

export class SessionManager {
  private readonly createAgent: (input: CreateAgentInput) => Promise<AgentLike>;
  private readonly nextSessionId: () => string;
  private readonly storeFactory: SessionManagerOptions["storeFor"];
  private readonly invalidateScope: SessionManagerOptions["invalidateScope"];
  private readonly handoffOptions: SessionManagerOptions["handoff"];
  private readonly sessions = new Map<string, LiveSession>();
  private readonly hub: EventHub;
  /** 自建的 hub 由自己清理；外面传进来的归外面管 */
  private readonly ownsHub: boolean;

  constructor(options: SessionManagerOptions) {
    this.createAgent = options.createAgent;
    this.nextSessionId = options.nextSessionId ?? defaultNextSessionId;
    this.storeFactory = options.storeFor;
    this.invalidateScope = options.invalidateScope;
    this.handoffOptions = options.handoff;
    this.hub = options.hub ?? new EventHub();
    this.ownsHub = !options.hub;
  }

  /** 整份快照：客户端（重）连上来时一次拿全，不用先从事件流里攒 */
  async snapshot(sessionId: string): Promise<SessionSnapshotResult> {
    const session = this.require(sessionId);
    return {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      modelId: modelIdOf(session.agent),
      turnId: session.turnId,
      phase: this.visiblePhase(session),
      messages: [...session.agent.messages],
      ...(session.agent.lastUsage !== undefined ? { lastUsage: session.agent.lastUsage } : {}),
    };
  }

  /** 把当前会话写进工作区存档，并把它设为「上一轮会话」 */
  async save(sessionId: string): Promise<{ saved: boolean; sessionId: string }> {
    const session = this.require(sessionId);
    const store = await this.storeFor(session.workspaceId);
    if (!store) throw codedError("no-store", `no session store for workspace ${session.workspaceId}`);

    await store.write({ id: session.id, agentId: session.agentId, messages: session.agent.messages });
    await store.setLastSession(session.id);
    return { saved: true, sessionId: session.id };
  }

  /**
   * 另存为指定 id（`/save <名字>`）：写新档、删旧档、活会话换键。
   *
   * 与 {`migrate`} 的区别：这是**同一段对话**换个名字，所以 `turnId` 不动；
   * 删旧档是必须的 —— 同一份对话在 `/load` 列表里出现两条，用户分不清哪条是新的。
   */
  async saveAs(sessionId: string, id: string): Promise<{ saved: boolean; sessionId: string }> {
    const session = this.require(sessionId);
    const store = await this.storeFor(session.workspaceId);
    if (!store) throw codedError("no-store", `no session store for workspace ${session.workspaceId}`);
    // 目标 id 已被另一段活会话占着：不静默顶掉它
    if (id !== session.id && this.sessions.has(id)) {
      throw codedError("session-exists", `session already exists: ${id}`);
    }

    const previousId = session.id;
    await store.write({ id, agentId: session.agentId, messages: session.agent.messages });
    await store.setLastSession(id);
    if (id !== previousId) await store.remove(previousId);

    this.sessions.delete(previousId);
    session.id = id;
    this.sessions.set(id, session);
    if (id !== previousId) {
      this.emit({ event: SESSION_EVENTS.idChanged, from: previousId, sessionId: id });
    }
    return { saved: true, sessionId: id };
  }

  /**
   * 自动迁移 —— 由 SDK 的 `AutoMigratePlugin` 在**一轮内部**（`onAfterSend`）触发。
   *
   * 与手动 `migrate()` 的三点不同：
   *   1. **不新开一轮**（外面那一轮还没结束，`turnId` 不动）；
   *   2. 收尾仍归外面那一轮 —— 这里只把 `settleDeferred` 拿住，避免嵌套交接回合的
   *      SDK `finally` 把整轮提前结束；
   *   3. 没有返回值可给：客户端靠 `session.idChanged` 事件得知换了 id。
   *
   * 必须能存档：prune 之后旧历史只存在于存档里，存不下去就别动手。
   */
  private async autoMigrate(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    // 交接已在跑（插件自己的 `busy` 检查漏了一次）：不重复迁移，也不报错
    if (!session || session.settleDeferred) return;

    // 先占坑再 await：下面每一条 await 都是让出点，并发进来的第二次调用会看到
    // `settleDeferred` 已经为真 —— 不占坑就是「两个迁移同时跑」，SDK 那边会直接抛
    // “A handoff is already in progress”
    session.settleDeferred = true;
    const previousId = session.id;
    try {
      const store = await this.storeFor(session.workspaceId);
      if (!store) {
        throw codedError("no-store", `no session store for workspace ${session.workspaceId}`);
      }

      await store.write({
        id: previousId,
        agentId: session.agentId,
        messages: [...session.agent.messages],
      });
      await store.setLastSession(previousId);
      this.notice(previousId, {
        level: "info",
        code: "handoffArchived",
        params: { sessionId: previousId },
      });

      await this.handoffOf(session).migrate(asHandoffAgent(session.agent));
      await this.adopt(session, store);
    } finally {
      session.settleDeferred = false;
    }
  }

  /**
   * 只产出交接文档（`/handoff`）：写文档，**不动会话**（不换 id、不剔历史）。
   *
   * 和 `send()` 一样按「一轮」记账：先把 `turnId` 进一格，交接回合的阶段与增量就都
   * 归在这一轮上，客户端不用另开一套「非对话回合」的渲染。区别只在收尾由本方法负责
   * （`settleDeferred`）—— 否则文档还没校验完，SDK 的 `finally` 就已宣布本轮结束。
   */
  async handoff(sessionId: string, mode?: HandoffMode): Promise<SessionHandoffResult> {
    const session = this.requireIdle(sessionId);
    this.beginTurn(session);
    session.settleDeferred = true;
    try {
      const outcome = await this.handoffOf(session).handoff(asHandoffAgent(session.agent), mode);
      return {
        sessionId: session.id,
        handoffPath: outcome.handoffPath,
        mode: outcome.mode,
        messages: [...session.agent.messages],
      };
    } catch (error) {
      throw this.failHandoff(session, error);
    } finally {
      session.settleDeferred = false;
      this.settleTurn(session);
    }
  }

  /**
   * 交接 + 开新会话（`/migrate`）：写文档、剔除历史、**换 sessionId**。
   *
   * 三步顺序是定死的：
   *   1. 先把旧会话存进存档（**交接回合之前**的完整历史）。存不下去就在这里打住，
   *      此时内存里什么都还没动；反过来「先 prune 再存」则是文档写了、历史没了；
   *   2. 交接（SDK 负责：写文档、校验、降级、剔除历史、注入断点）；
   *   3. 收尾（发在旧 id 上）→ 换 id 并落盘新会话。
   *
   * `turnId` 是**会话内**的轮次编号，换 id 后继续递增 —— 不清零。不清零是因为自动迁移
   * 发生在**一轮内部**：那一轮还没收尾，把计数归零会让它的 `turn.end` 带一个客户端
   * 从没见过的编号（它会在旧轮次上一直等下去）。
   *
   * 第 3 步把「收尾」放在「换 id」之前：客户端先看到旧会话这一轮结束，再收到响应里的
   * 新 id，两次`session.phase`/`turn.end` 的 `sessionId` 才不会指向一个它还不知情的会话。
   */
  async migrate(sessionId: string, mode?: HandoffMode): Promise<SessionMigrateResult> {
    const session = this.requireIdle(sessionId);
    const store = await this.storeFor(session.workspaceId);
    // 迁移必须能存档：prune 之后旧历史只存在于存档里（内存里只剩模板 + 断点）
    if (!store) throw codedError("no-store", `no session store for workspace ${session.workspaceId}`);

    this.beginTurn(session);
    session.settleDeferred = true;
    try {
      const previousId = session.id;
      await store.write({
        id: previousId,
        agentId: session.agentId,
        messages: [...session.agent.messages],
      });
      await store.setLastSession(previousId);
      this.notice(previousId, {
        level: "info",
        code: "handoffArchived",
        params: { sessionId: previousId },
      });

      const outcome = await this.handoffOf(session).migrate(asHandoffAgent(session.agent), mode);

      session.settleDeferred = false;
      this.settleTurn(session);

      const nextId = await this.adopt(session, store);
      return {
        sessionId: nextId,
        handoffPath: outcome.handoffPath,
        mode: outcome.mode,
        messages: [...session.agent.messages],
      };
    } catch (error) {
      throw this.failHandoff(session, error);
    } finally {
      session.settleDeferred = false;
      this.settleTurn(session);
    }
  }

  /**
   * 按磁盘上的（新）配置与 Agent 定义重建 Agent，**保留当前消息**。
   *
   * 用在「`/config` 改了端点凭据」「`agent.model.set` 换了模型」之后：Scope 持有配置
   * 快照，不连带重建就还是旧的那份（CLI 时代 `resetScope()` 的存在就是这个原因）。
   */
  async reload(sessionId: string): Promise<SessionSnapshotResult> {
    const session = this.require(sessionId);
    const messages = [...session.agent.messages];

    session.detach();
    await this.invalidateScope?.(session.path);
    const agent = await this.createAgent({
      workspaceId: session.workspaceId,
      path: session.path,
      agentId: session.agentId,
      // 重建后插件要接回同一套让行/自动迁移：它们也是 Agent 装配的一部分
      isHandoffBusy: () => session.settleDeferred,
      autoMigrate: () => this.autoMigrate(session.id),
    });
    agent.messages = messages;

    session.agent = agent;
    session.turnFailed = null;
    session.turnSettled = true;
    session.phase.reset();
    session.detach = this.attachEvents(session);

    return await this.snapshot(sessionId);
  }

  /** 某个工作区下已存档的会话（按写入时间倒序，只有 id） */
  async listSaved(workspaceId: string): Promise<SessionRef[]> {
    const store = await this.storeFor(workspaceId);
    if (!store) throw codedError("no-store", `no session store for workspace ${workspaceId}`);
    return await store.list();
  }

  /**
   * 撤回：删掉 `index` 起的消息，**并立即落盘**。
   *
   * 落盘不是可选项：只改内存的话，存档里仍留着被撤回的消息，下次 `/load` 或重启
   * 就“复活”（TUI 时代踩过这个坑）。所以先确认有存档可写，再动消息 —— 避免
   * “改了一半、存不下去”。
   */
  async rollback(
    sessionId: string,
    index: number,
  ): Promise<{ removed: number; prompt: string; messages: unknown[] }> {
    const session = this.require(sessionId);
    const store = await this.storeFor(session.workspaceId);
    if (!store) throw codedError("no-store", `no session store for workspace ${session.workspaceId}`);

    const messages = session.agent.messages;
    if (!Number.isInteger(index) || index < 0 || index >= messages.length) {
      throw codedError("bad-index", `index ${index} is out of range (0..${messages.length - 1})`);
    }

    const removedMessages = messages.splice(index);
    session.agent.messages = messages;
    await store.write({ id: session.id, agentId: session.agentId, messages });
    await store.setLastSession(session.id);

    // 预填输入框用：被删掉的第一条用户消息（原文，不做任何“备注剥离”）
    const firstUser = removedMessages.find(
      (message) => (message as { role?: unknown } | null)?.role === "user",
    ) as { content?: unknown } | undefined;

    return {
      removed: removedMessages.length,
      prompt: typeof firstUser?.content === "string" ? firstUser.content : "",
      messages: [...messages],
    };
  }

  /** 订阅事件；返回取消订阅的函数（连接断开时调用） */
  subscribe(listener: (event: ServerEvent) => void): () => void {
    return this.hub.subscribe(listener);
  }

  /**
   * 发一条**对话内**通知（绑会话）。
   *
   * 会话不存在就直接抛：发一条没有归属的通知，客户端既贴不到会话上、也没法清理。
   * 全局通知不归这里管 —— 那是服务本身的事，由组装根直接往 hub 里发。
   */
  notice(
    sessionId: string,
    notice: { level: NoticeLevel; code: SessionNoticeCode; params?: Record<string, unknown> },
  ): void {
    const session = this.require(sessionId);
    this.hub.publish({
      event: SESSION_EVENTS.notice,
      sessionId: session.id,
      ...notice,
    });
  }

  async create(input: SessionCreateInput): Promise<{ sessionId: string; agentId: string }> {
    const sessionId = input.sessionId || this.nextSessionId();
    if (this.sessions.has(sessionId)) {
      throw codedError("session-exists", `session already exists: ${sessionId}`);
    }

    // 续接：这个 id 在工作区存档里有记录，就把它的消息装进 Agent。
    // 服务端是唯一真相源 —— 客户端只给 id，不搬消息。
    const store = await this.storeFor(input.workspaceId);
    const record = store ? await store.read(sessionId) : null;

    // Agent 也跟着存档走：`/load` 只拿到一个 id（列表不解析存档内容），
    // 存档里记着这段会话是哪个 Agent 跑的 —— 不传就沿用它，而不是默默换成 `default`。
    const agentId = input.agentId || record?.agentId || "default";
    const agent = await this.createAgent({
      workspaceId: input.workspaceId,
      path: input.path,
      agentId,
      // 交接/迁移中让护栏让行：此刻这段会话还没注册（返回 false），正好
      isHandoffBusy: () => this.sessions.get(sessionId)?.settleDeferred ?? false,
      // 自动迁移：SDK 的插件在**一轮内部**触发，落地动作必须回到会话层
      autoMigrate: () => this.autoMigrate(sessionId),
    });
    if (record && record.messages.length > 0) agent.messages = [...record.messages];

    const session: LiveSession = {
      id: sessionId,
      workspaceId: input.workspaceId,
      path: input.path,
      agentId,
      agent,
      turnId: 0,
      phase: new PhaseTracker(),
      turnFailed: null,
      turnSettled: true,
      settleDeferred: false,
      handoff: null,
      detach: () => {},
    };
    session.detach = this.attachEvents(session);
    this.sessions.set(sessionId, session);
    return { sessionId, agentId };
  }

  /**
   * 开始一轮：立刻返回 `turnId`，结果与过程全部走事件。
   *
   * 不 `await agent.send()` 的原因见协议文件头：一轮可能跑几分钟，等它回来客户端
   * 就没东西可渲染。失败也走事件（`turn.end` 带 `ok:false`），不靠这一个 promise。
   */
  send(sessionId: string, content: string): { turnId: number } {
    const session = this.require(sessionId);
    // 交接/迁移进行中：再起一轮会同用一个 `turnId`，事件没任何办法归轮
    if (session.settleDeferred) {
      throw codedError("handoff-in-flight", `session ${sessionId} is handing off`);
    }
    this.beginTurn(session);

    void session.agent.send(content).catch((error: any) => {
      // `send()` 自己抛错（不是事件通道里的 error）：当作本轮失败收尾
      this.failTurn(session, {
        code: error?.code ?? "internal",
        message: error?.message ?? String(error),
      });
    });
    return { turnId: session.turnId };
  }

  cancel(sessionId: string): { cancelled: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session) return { cancelled: false };
    // 先掐交接：它挂在模型请求/工具上，服务自己持有的那个句柄是唯一入口；
    // `agent.abort()` 负责立即断正在流的那一轮（两者都要，顺序与 CLI 一致）
    session.handoff?.abort();
    session.agent.abort();
    return { cancelled: true };
  }

  /**
   * 列出某个工作区下活着的会话。
   *
   * `workspaceId` 必填：会话是工作区的**下级对象**，不提供「跨工作区全量列」——
   * 那种调用要么是调用方漏了上下文，要么就是在把一个工作区的界面喂另一个工作区的数据。
   */
  list(workspaceId: string): SessionSummary[] {
    return [...this.sessions.values()]
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => ({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        agentId: session.agentId,
        turnId: session.turnId,
        phase: this.visiblePhase(session),
      }));
  }

  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.handoff?.abort();
    session.detach();
    this.sessions.delete(sessionId);
    return true;
  }

  /** 收摊：摘掉所有事件、清空会话（守护进程退出时调用） */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.handoff?.abort();
      session.detach();
    }
    this.sessions.clear();
    if (this.ownsHub) this.hub.clear();
  }

  // ==================================================================
  // SDK 事件 → 协议事件
  // ==================================================================

  private attachEvents(session: LiveSession): () => void {
    const { events } = session.agent;

    const onOpen = () => {
      session.phase.opened();
      this.emitPhase(session);
    };

    const onChunk = (receiver: any) => {
      const chunk = receiver?.chunk ?? receiver;
      session.phase.delta(chunk);
      this.emitPhase(session);

      const delta = chunk?.choices?.[0]?.delta;
      const text = typeof delta?.content === "string" ? delta.content : "";
      const reasoning = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
      if (!text && !reasoning) return;
      this.emit({
        event: SESSION_EVENTS.delta,
        sessionId: session.id,
        turnId: session.turnId,
        text,
        reasoning,
      });
    };

    const onParsed = (receiver: any) => {
      session.phase.streamEnded(receiver?.message ?? receiver);
      this.emitPhase(session);
    };

    // 工具跑完一个就报一次：并行时先完成的那个从「等待」里消失，
    // 否则界面会一直念着已经结束的工具名
    const onToolCallEnd = () => this.emitPhase(session);

    const onError = (error: any) => {
      this.failTurn(session, {
        code: error?.code ?? "internal",
        message: error?.message ?? String(error),
      });
    };

    const onFinally = () => this.settleTurn(session);

    events.on("open", onOpen);
    events.on("chunk-parsed", onChunk);
    events.on("parsed", onParsed);
    events.on("tool-call-end", onToolCallEnd);
    events.on("error", onError);
    events.on("finally", onFinally);

    return () => {
      events.off("open", onOpen);
      events.off("chunk-parsed", onChunk);
      events.off("parsed", onParsed);
      events.off("tool-call-end", onToolCallEnd);
      events.off("error", onError);
      events.off("finally", onFinally);
    };
  }

  /** 失败即收尾（`error` 之后 SDK 仍会发 `finally`，靠 `turnSettled` 去重） */
  private failTurn(session: LiveSession, failure: { code: string; message: string }): void {
    session.turnFailed = failure;
    this.settleTurn(session);
  }

  private settleTurn(session: LiveSession): void {
    if (session.turnSettled) return;
    // 交接/迁移进行中：这一轮的收尾归方法自己的 promise（见 `settleDeferred`）
    if (session.settleDeferred) return;
    session.turnSettled = true;

    session.phase.reset();
    this.emitPhase(session);
    this.emit({
      event: SESSION_EVENTS.turnEnd,
      sessionId: session.id,
      turnId: session.turnId,
      ok: session.turnFailed === null,
      ...(session.turnFailed ? { error: session.turnFailed } : {}),
    });
  }

  // ==================================================================
  // 内部
  // ==================================================================

  /**
   * 对外报的阶段要**再筛一遍**「谁还在跑」。
   *
   * 状态机只知道「这一轮都调了哪些工具」，而工具是并发跑的：结果消息一到终态，
   * 那个名字就该从等待里消失。不做这一步，界面会一直念着已经跑完的工具。
   */
  private visiblePhase(session: LiveSession): PhaseInfo | null {
    const phase = session.phase.phase;
    if (!phase || phase.kind !== "tool-waiting" || !phase.calls) return phase;
    const pending = pendingToolCalls(phase.calls, session.agent.messages as any[]);
    return { ...phase, tools: pending.map((call) => call.name) };
  }

  private emitPhase(session: LiveSession): void {
    this.emit({
      event: SESSION_EVENTS.phase,
      sessionId: session.id,
      turnId: session.turnId,
      phase: this.visiblePhase(session),
    });
  }

  private emit(event: ServerEvent): void {
    this.hub.publish(event);
  }

  private require(sessionId: string): LiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw codedError("unknown-session", `unknown session: ${sessionId}`);
    return session;
  }

  /**
   * 开一轮：报新 `turnId`、清失败标记、进入 `connecting`。
   *
   * `send` 与 `handoff`/`migrate` 共用：交接回合也要算一轮，事件才能归轮。
   */
  private beginTurn(session: LiveSession): void {
    session.turnId += 1;
    session.turnFailed = null;
    session.turnSettled = false;
    session.phase.connecting();
    this.emitPhase(session);
  }

  /**
   * 交接的前提：这段会话得处于空闲、且真的有过对话。
   *
   * 两条都是「不满足就说不」而不是兜底：正在跑一轮时交接，两边的消息会同时往
   * `agent.messages` 里塞；空会话交接到的是模板消息，白烧一次模型调用。
   */
  private requireIdle(sessionId: string): LiveSession {
    const session = this.require(sessionId);
    if (!session.turnSettled) {
      throw codedError("turn-in-flight", `session ${sessionId} has a turn in flight`);
    }
    const hasUserMessage = session.agent.messages.some(
      (message) => (message as { role?: unknown } | null)?.role === "user",
    );
    if (!hasUserMessage) {
      throw codedError("nothing-to-handoff", `session ${sessionId} has no user message yet`);
    }
    return session;
  }

  /**
   * 这段会话的交接服务（按需创建，一个会话一个实例）。
   *
   * 实例跨调用复用而不是每次新建：它持有 `busy` 与取消句柄（`session.cancel` 扳的就是
   * 它），SDK 侧按 Agent 注册的交接守卫也不该每次调用都重新挂一遍。
   */
  private handoffOf(session: LiveSession): SessionHandoff {
    if (!this.handoffOptions) {
      throw codedError("no-handoff", "handoff is not configured on this server");
    }
    session.handoff ??= new SessionHandoff({
      ...this.handoffOptions,
      workspacePath: session.path,
      notice: (notice) => this.notice(session.id, notice),
    });
    return session.handoff;
  }

  /**
   * 迁移后换 id：新会话立即落盘，再把活会话从旧键挪到新键。
   *
   * 顺序是「先写盘、再换键」：写失败时注册表还在旧 id 上，客户端收到的错误与它看到的
   * 状态才一致；反过来会出现「响应说迁移失败、会话其实已经改名」这种谁也修不了的状态。
   *
   * 换完发 `session.idChanged`：自动迁移发生在一轮内部，客户端没有响应可接，
   * 只能靠这条事件把后续请求与事件过滤切到新 id。
   */
  private async adopt(session: LiveSession, store: SessionStore): Promise<string> {
    const previousId = session.id;
    const nextId = this.nextSessionId();
    if (this.sessions.has(nextId)) {
      throw codedError("session-exists", `session already exists: ${nextId}`);
    }

    await store.write({ id: nextId, agentId: session.agentId, messages: session.agent.messages });
    await store.setLastSession(nextId);

    this.sessions.delete(previousId);
    session.id = nextId;
    this.sessions.set(nextId, session);
    this.emit({ event: SESSION_EVENTS.idChanged, from: previousId, sessionId: nextId });
    return nextId;
  }

  /**
   * 交接/迁移失败（含用户取消）：记下本轮失败并让调用方决定怎么报。
   *
   * 取消不是失败：SDK 已经把会话回退到交接前（截掉交接回合、删掉半成品文档），
   * 这里只发一条 `turnAborted` 通知，把机器可判的 `handoff-aborted` 回给客户端。
   */
  private failHandoff(session: LiveSession, error: unknown): unknown {
    if (isHandoffAborted(error)) {
      this.notice(session.id, { level: "info", code: "turnAborted" });
      session.turnFailed = { code: "aborted", message: "handoff cancelled" };
      return codedError("handoff-aborted", "handoff cancelled");
    }
    const failure = error as { code?: unknown; message?: unknown } | null;
    session.turnFailed = {
      code: typeof failure?.code === "string" ? failure.code : "internal",
      message: typeof failure?.message === "string" ? failure.message : String(error),
    };
    return error;
  }

  /** 存档工厂：没注入则续接与 save 都不可用 */
  private async storeFor(workspaceId: string): Promise<SessionStore | undefined> {
    return this.storeFactory ? await this.storeFactory(workspaceId) : undefined;
  }
}
