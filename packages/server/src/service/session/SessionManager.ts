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
import {
  SESSION_EVENTS,
  type SessionEvent,
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
}

interface LiveSession {
  id: string;
  workspaceId: string;
  agentId: string;
  agent: AgentLike;
  turnId: number;
  phase: PhaseTracker;
  /** 本轮是否已经出过错（`error` 与 `finally` 都会到，收尾只报一次） */
  turnFailed: { code: string; message: string } | null;
  turnSettled: boolean;
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

export class SessionManager {
  private readonly createAgent: (input: CreateAgentInput) => Promise<AgentLike>;
  private readonly nextSessionId: () => string;
  private readonly storeFactory: SessionManagerOptions["storeFor"];
  private readonly sessions = new Map<string, LiveSession>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();

  constructor(options: SessionManagerOptions) {
    this.createAgent = options.createAgent;
    this.nextSessionId = options.nextSessionId ?? defaultNextSessionId;
    this.storeFactory = options.storeFor;
  }

  /** 整份快照：客户端（重）连上来时一次拿全，不用先从事件流里攒 */
  async snapshot(sessionId: string): Promise<SessionSnapshotResult> {
    const session = this.require(sessionId);
    return {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
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
  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: SessionCreateInput): Promise<{ sessionId: string; agentId: string }> {
    const agentId = input.agentId || "default";
    const sessionId = input.sessionId || this.nextSessionId();
    if (this.sessions.has(sessionId)) {
      throw codedError("session-exists", `session already exists: ${sessionId}`);
    }

    const agent = await this.createAgent({ workspaceId: input.workspaceId, path: input.path, agentId });

    // 续接：这个 id 的工作区存档里有记录，就把它的消息装进 Agent。
    // 服务端是唯一真相源 —— 客户端只给 id，不搬消息。
    const store = await this.storeFor(input.workspaceId);
    if (store) {
      const record = await store.read(sessionId);
      if (record && record.messages.length > 0) agent.messages = [...record.messages];
    }

    const session: LiveSession = {
      id: sessionId,
      workspaceId: input.workspaceId,
      agentId,
      agent,
      turnId: 0,
      phase: new PhaseTracker(),
      turnFailed: null,
      turnSettled: true,
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
    session.turnId += 1;
    session.turnFailed = null;
    session.turnSettled = false;

    session.phase.connecting();
    this.emitPhase(session);

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
    session.detach();
    this.sessions.delete(sessionId);
    return true;
  }

  /** 收摊：摘掉所有事件、清空会话（守护进程退出时调用） */
  dispose(): void {
    for (const session of this.sessions.values()) session.detach();
    this.sessions.clear();
    this.listeners.clear();
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

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 一个订阅方（某条连接）写失败不该影响别的客户端收到事件
      }
    }
  }

  private require(sessionId: string): LiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw codedError("unknown-session", `unknown session: ${sessionId}`);
    return session;
  }

  /** 存档工厂：没注入则续接与 save 都不可用 */
  private async storeFor(workspaceId: string): Promise<SessionStore | undefined> {
    return this.storeFactory ? await this.storeFactory(workspaceId) : undefined;
  }
}
