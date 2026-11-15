/**
 * `RunRegistry` —— 「这段对话正在跑哪一轮」的唯一一处（PLAN §4 / PRD D14）。
 *
 * 为什么要有它：一段对话同时只跑一轮（PRD D14 的前半句）。这一条仍然是本注册表给出的
 * **硬保证** —— 交接回合、撤回、问题答复都靠它在「这段对话现在不能动」时说清正忙
 * （`start()` 撞上在跑的一轮就抛 `busy`）。
 *
 * 但「跑中再发一句话」不走这一道（PRD D14 的后半句）：`conversation.send` 在受理那一刻就
 * 分流到 `ChatRunner.enqueue`，把那一句排进**正在跑的那一轮**的 inbox，回执 `queued: true`。
 * 那不是绕过本注册表 —— 那条路上这一轮**已经在跑**，压根不会走到 `start()`，注册表里记的
 * 始终还是同一轮。
 *
 * `busy` 因此只剩兜底（PRD D14 末段）：收尾竞态（这一轮已经跑完、正在写库结算），以及
 * **别的动作**撞上在跑的一轮（见下一节）。它不是「跑中发送」的答复。
 *
 * ## 为什么它是注册表，而不是散在服务里的布尔
 *
 * 服务层要问「现在忙不忙」，接线层的 `conversation.abort` 要找到那一轮去中止；两处问的必须
 * 是同一份事实，所以只留一处（`isRunning` 只有这里一个实现，见 PRD D14）。服务层只需要窄
 * 接口 `RunsView`，本类结构上就满足它，不必包一层。
 *
 * ## 它为什么不是排队执行器（也不能改成那个）
 *
 * 「用户跑中再发一句话」那条口子走的是 core 的 inbox，不是这里（PRD D14：
 * `conversation.send` → `ChatRunner.enqueue` → 那一轮 agent 的 `deliver`）。这一条仍然是
 * 一道**硬保证**：交接回合、撤回、问题答复都靠 `busy` 这一支把「这段对话现在不能动」说清楚
 * （`HandoffService` / `ConversationService.revert` / `QuestionService.answer`）。把这里改成
 * 「来一个排一个」，等于把「先来后到」那套语义摊到这三个调用方头上，而它们要的是一个当下的
 * 「不行」。同理，`conversation.send` 的排队分支也只对**正在跑的那一轮**说话：拿不到那一轮
 * 就回老路径，不在这里排一个跨轮次的全局队列。
 *
 * 一轮的内存真相在 `ChatRunner` 那一轮自己手里（消息、生成态），本文件只记「谁在跑」——
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
   * 已经在跑就抛 `HostError("busy")` —— PRD D14 里这一支只剩兜底。`detail` 带上「上一次
   * 是什么时候开始的」，让界面能说清「它在忙什么」而不是干巴巴一句忙。
   *
   * 「用户跑中再发一句话」不经过这一道：那条口子在 `conversation.send` 就分流到
   * `ChatRunner.enqueue` 了（D14），压根不会走到 `start()`。这里抛 `busy` 的几种情形都是
   * **别的动作**撞上了正在跑的一轮（交接、撤回、答问题），以及排队分支自己兜底之后的那个
   * `send`（装配窗口等超了上界、或者这一轮正在收尾）。
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
