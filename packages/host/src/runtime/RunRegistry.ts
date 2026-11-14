/**
 * `RunRegistry` —— 「这段对话正在跑哪一轮」的唯一一处（architecture §4 / PRD D14）。
 *
 * 为什么要有它：一段对话同时跑一轮（PRD D14）。再来请求时**直接拒**并说明「正忙」，
 * 不排队也不自动打断 —— 中止是用户的显式动作，只有用户能按。
 *
 * 为什么它是注册表而不是散在服务里的布尔：服务层要问「现在忙不忙」，接线层的
 * `conversation.abort` 要找到那一轮去中止；两处问的必须是同一份事实，所以只留一处
 * （`isRunning` 只有这里一个实现，见 PRD D14）。服务层只需要窄接口 `RunsView`，
 * 本类结构上就满足它，不必包一层。
 *
 * 环的内存真相在 `ChatRunner` 那一轮自己手里（消息、生成态），本文件只记「谁在跑」——
 * 跑的内容不往这里存第二份。
 */

import { HostError } from "../wire/errors.js";
import type { Clock } from "./ScopeRegistry.js";
import { systemClock } from "./ScopeRegistry.js";

/** 一轮的开始时刻与中止状态：`list()` 与重连快照要用的最小事实 */
export interface RunSummary {
  conversationId: string;
  /** ISO 8601 */
  startedAt: string;
  /** 用户是否已经要求中止（中止请求已送达，那一轮还没结算） */
  aborted: boolean;
}

/**
 * 一轮的句柄：拿到它的人可以中止这一轮。
 *
 * 中止是注册表转达给执行者的（`onAbort`）：注册表不认识 Agent，执行者才认识；
 * 这样「谁在跑」与「怎么停」各自只有一处。
 */
export interface RunHandle extends RunSummary {
  /** 用户是否已经要求中止 */
  readonly aborted: boolean;
  /**
   * 要求中止。
   *
   * 重复调用无副作用；中止之后仍然等执行者写库、结算才算真正结束（`finish` 由执行者叫）。
   */
  abort(reason?: string): void;
  /**
   * 登记中止时要做什么（执行者在这里挂 `agent.abort()`）。返回取消登记的函数。
   *
   * 允许在 `abort()` 之后才登记：那样会立刻执行一次，免得「中止来得太早」被丢掉。
   */
  onAbort(listener: (reason: string | undefined) => void): () => void;
}

/** 服务层要用窄接口：只问忙不忙（`RunRegistry` 直接满足，不必适配） */
export interface RunsView {
  isRunning(conversationId: string): boolean;
}

/** 一轮的内部记录 */
class Run implements RunHandle {
  readonly conversationId: string;
  readonly startedAt: string;
  /** 中止原因（用户没给就是 undefined） */
  abortReason: string | undefined;
  private abortRequested = false;
  private readonly abortListeners = new Set<(reason: string | undefined) => void>();

  constructor(conversationId: string, clock: Clock) {
    this.conversationId = conversationId;
    this.startedAt = new Date(clock.now()).toISOString();
  }

  get aborted(): boolean {
    return this.abortRequested;
  }

  abort(reason?: string): void {
    if (this.abortRequested) return;
    this.abortRequested = true;
    this.abortReason = reason;
    for (const listener of [...this.abortListeners]) listener(reason);
  }

  onAbort(listener: (reason: string | undefined) => void): () => void {
    this.abortListeners.add(listener);
    // 中止已经发生过了：登记得太晚也要收到，否则执行者会一直以为没人叫它停
    if (this.abortRequested) listener(this.abortReason);
    return () => {
      this.abortListeners.delete(listener);
    };
  }

  summary(): RunSummary {
    return {
      conversationId: this.conversationId,
      startedAt: this.startedAt,
      aborted: this.abortRequested,
    };
  }
}

export interface RunRegistryOptions {
  /** 计时入口，缺省真实时钟（`startedAt` 与测试里的假时间用它） */
  clock?: Clock;
}

export class RunRegistry implements RunsView {
  private readonly runs = new Map<string, Run>();
  private readonly clock: Clock;

  constructor(options: RunRegistryOptions = {}) {
    this.clock = options.clock ?? systemClock;
  }

  /**
   * 占位：这段对话开始跑一轮。
   *
   * 已经在跑就抛 `HostError("busy")` —— PRD D14：直接拒并说明「正忙」，不排队、不自动打断。
   * `detail` 带上「上一次是什么时候开始的」，让界面能说清「它在忙什么」而不是干巴巴一句忙。
   */
  start(conversationId: string): RunHandle {
    const existing = this.runs.get(conversationId);
    if (existing) {
      throw new HostError("busy", {
        detail: { conversationId, startedAt: existing.startedAt, aborted: existing.aborted },
      });
    }
    const run = new Run(conversationId, this.clock);
    this.runs.set(conversationId, run);
    return run;
  }

  /** 结算：这一轮结束（正常、出错、被中止都走这里）。返回是否真的有这一轮 */
  finish(conversationId: string): boolean {
    return this.runs.delete(conversationId);
  }

  /** 这段对话现在忙不忙 —— 服务层注入的就是这个方法 */
  isRunning(conversationId: string): boolean {
    return this.runs.has(conversationId);
  }

  /**
   * 某段对话这一轮的摘要（`conversation.list` 的「在跑」那一格用它）；没在跑时 `null`。
   *
   * 与 {@link list} 同一份内容，只是一次只问一段：列表要为每段对话问一次，扫一遍全体
   * 会让「翻一页侧栏」变成 N×N。
   */
  summary(conversationId: string): RunSummary | null {
    return this.runs.get(conversationId)?.summary() ?? null;
  }

  /** 当前在跑的全部轮次（根对象判「能不能退出」时用） */
  list(): RunSummary[] {
    return [...this.runs.values()].map((run) => run.summary());
  }

  /**
   * 按对话中止（接线层的 `conversation.abort` 用）：返回是否真的有在跑的一轮。
   *
   * `false` 表示本来就没在跑 —— 那不是错误，客户端只是按了一下没东西可停的按钮。
   */
  abort(conversationId: string, reason?: string): boolean {
    const run = this.runs.get(conversationId);
    if (!run) return false;
    run.abort(reason);
    return true;
  }

  /** 正在跑的轮次数量 */
  size(): number {
    return this.runs.size;
  }
}
