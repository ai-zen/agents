/**
 * 服务端向客户端提问的那一半（`SessionManager` 拆出来的四块之一）。
 *
 * ## 管什么
 *
 * 「问一个问题并等回答」这件事本身的四条约束，以及自动迁移那条具体的提问
 * （「用哪种方式交接」）。四条约束写在 `askQuestion` 里，因为它们是**提问**的规矩，
 * 不是交接的规矩：
 *
 *   1. **没人在看就不问**（返回兜底值）；
 *   2. **先登记再发事件**（客户端可能在同一轮事件循环里就答了）；
 *   3. **等，但有时限**（`askTimeoutMs`，到点用兜底值收场）；
 *   4. **三个出口都清表**（答了 / 超时 / 被流程放行）—— 清表是「来晚了」的唯一判据。
 *
 * ## 为什么它能单独成一个类
 *
 * 它是四块里**唯一需要 `hub.watcherCount()`** 的：没人在看时提问只是把这一轮挂死。
 * 除此之外它只碰会话上的 `questions` / `questionSeq` 两个字段，不碰注册表、不碰存档。
 */

import type { EventHub } from "../../lib/events.js";
import {
  SESSION_EVENTS,
  SESSION_NOTICE_CODES,
  type HandoffMode,
  type NoticePayload,
  type SessionAnswerResult,
} from "@ai-zen/agents-protocol";
import type { AutoMigrateTriggerInfo } from "@ai-zen/agents-sdk";
import type { AskQuestionSpec, LiveSession } from "./LiveSession.js";

/** 等客户端回答「自动迁移用哪种方式交接」的上限：5 分钟 */
export const ASK_TIMEOUT_MS = 300_000;

export interface QuestionBrokerOptions {
  /**
   * 事件出口。
   *
   * 兼作「有没有人在看」的判据：`watcherCount()` 为 0 时**根本不问**（理由见
   * `askQuestion` 第 1 条）。这条判定只有这里用得到，所以不是会话层的通用设施。
   */
  hub: Pick<EventHub, "publish" | "watcherCount">;
  /** 等回答的上限（毫秒）。可注入：等 5 分钟才能验证的用例只能靠 `sleep`，那是把「超时」测成「时钟」 */
  askTimeoutMs?: number;
  /** 这段会话还在注册表里吗（问一个已经退场的会话没有意义） */
  isLive: (session: LiveSession) => boolean;
  /** 会话内通知的出口（会话可能已不在，「发不发」由持有注册表的那一方决定） */
  notice: (sessionId: string, notice: NoticePayload) => void;
}

export class QuestionBroker {
  private readonly hub: Pick<EventHub, "publish" | "watcherCount">;
  private readonly askTimeoutMs: number;

  constructor(private readonly options: QuestionBrokerOptions) {
    this.hub = options.hub;
    this.askTimeoutMs = options.askTimeoutMs ?? ASK_TIMEOUT_MS;
  }

  /**
   * 问客户端一个问题，等它的答案（`session.answer`）。四条规矩见文件头。
   *
   * 「没人在看就不问」为什么是**兜底而不是等**：发出去没人看得见，等一个不会来的答案
   * 只是把这一轮挂死（客户端已退出，而会话仍在服务端活着）。
   */
  async askQuestion(session: LiveSession, spec: AskQuestionSpec): Promise<string | null> {
    if (this.hub.watcherCount() === 0) return spec.fallback;

    const questionId = `q-${++session.questionSeq}`;
    const answer = new Promise<string | null>((resolve) => {
      session.questions.set(questionId, { resolve, fallback: spec.fallback });
    });

    this.hub.publish({
      event: SESSION_EVENTS.question,
      sessionId: session.id,
      questionId,
      kind: spec.kind,
      input: spec.input,
      ...(spec.options ? { options: spec.options } : {}),
      params: spec.params ?? {},
      allowSkip: spec.allowSkip ?? false,
      fallback: spec.fallback,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<string | null>((resolve) => {
      timer = setTimeout(() => resolve(spec.fallback), this.askTimeoutMs);
    });
    try {
      return await Promise.race([answer, timedOut]);
    } finally {
      clearTimeout(timer);
      session.questions.delete(questionId);
    }
  }

  /**
   * 问客户端「这次自动迁移用哪种方式交接」；返回 `null` = 用户选择不交接。
   *
   * 把「用哪种方式交接」这个三选一（自己写 / 独立摘要 / 不交接）交给用户。谁来写交接文档是
   * **用户的决定**（保真 vs 便宜、要不要现在就走），服务端替他选 `self`，等于把他没有的
   * 能力当成他的选择 —— 这正是「基础交互被前后端分离改掉」的那类回归。
   *
   * 本方法只负责两件事：把触发时的两个数（`promptTokens` / `handoffTokens`）交给
   * {@link askQuestion}，并把答案翻译成 `HandoffMode | null`。提问本身的四条约束
   * （没人在看就不问 / 先登记再发 / 有时限 / 三个出口都清表）在 `askQuestion` 里，
   * 不在这里重写一遍——那是一处会与实现无关地漂的副本。
   *
   * 兜底是 `null`（本次不交接）而不是 `self`：迁移要不要现在做，是用户的决定；服务端替他
   * 选 `self`，等于把「用户没有的能力」当成「用户的选择」。上下文继续长由硬线护栏兜。
   */
  async askHandoffMode(
    session: LiveSession,
    info: AutoMigrateTriggerInfo,
  ): Promise<HandoffMode | null> {
    const choice = await this.askQuestion(session, {
      kind: "handoff-mode",
      input: "select",
      // 选项 id 就是 `HandoffMode` 的字面量：文案由客户端按 `kind + id` 查词典
      options: ["self", "summary"],
      params: { promptTokens: info.promptTokens, handoffTokens: info.handoffTokens },
      allowSkip: true,
      // **兜底是「什么都不做」**：迁移要不要现在做、用哪种方式，是用户的决定。服务端替他
      // 选 `self`，等于把「用户没有的能力」当成「用户的选择」。不迁移时上下文继续长，
      // 由硬线护栏兜。
      fallback: null,
    });

    if (choice === "self" || choice === "summary") return choice;

    // 跳过（用户选的 / 兜底走到这儿）：说一句「本次没迁」，否则用户只会看到上下文继续涨
    this.noticeIfAlive(session, {
      level: "info",
      code: SESSION_NOTICE_CODES.migrationSkipped,
    });
    return null;
  }

  /**
   * 认领一个回答（`session.answer`）。
   *
   * 三种结果各有含义，不能混（见 `SessionManager.answer`）：会话不存在 → `unknown-session`；
   * 问题不在表里 → `{ answered: false }`，**不是参数错，是来晚了**；认领成功 → `{ answered: true }`。
   */
  answer(session: LiveSession, questionId: string, choice: string | null): SessionAnswerResult {
    const pending = session.questions.get(questionId);
    if (!pending) return { answered: false };
    // 先摘表再 resolve：同一个 questionId 的第二次回答必须落进「来晚了」那条分支，
    // 而不是把同一个问题答两遍（第二遍的 promise 已经没人等了）
    session.questions.delete(questionId);
    pending.resolve(choice);
    return { answered: true };
  }

  /**
   * 把挂着的提问全部按**各自的**兜底放行。
   *
   * 什么时候需要它：会话被关了（`close` / `dispose`）、或这一轮已经收尾 —— 这两种情况下
   * 不会再有回答进来，而 `askHandoffMode` 那边还挂着一个 promise。不放行它，那一轮就要
   * 白等到 5 分钟超时，期间这段会话一直占着闸门（后面的 `send` 全报 `turn-busy`）。
   *
   * 每个问题按**它自己的**兜底收场：用统一值会出事 —— 交接类问题的兜底是「什么都不做」，
   * 而「流程结束了」并不意味着用户表达了「这次不交接」以外的东西，由提问方决定。
   *
   * 用兜底而不是「跳过」这个理由也在这里：关闭/收尾是**流程**结束了，不是用户表达了
   * 「这次不交接」；真到了迁移那一步，如果会话已经不在，`autoMigrate` 会自己打住。
   */
  release(session: LiveSession): void {
    if (session.questions.size === 0) return;
    // 先清表再 resolve：resolve 会让提问方继续跑（可能立即发起新的提问）
    const pending = [...session.questions.values()];
    session.questions.clear();
    for (const question of pending) question.resolve(question.fallback);
  }

  /**
   * 发一条会话内通知，但会话可能已经不在（提问方被放行后继续跑的那一刻常见）。
   *
   * 不是在吞错 `notice()` 的错误：「会话已经没了」对这条路径是**正常结局**，而不是异常。
   */
  private noticeIfAlive(session: LiveSession, notice: NoticePayload): void {
    if (!this.options.isLive(session)) return;
    this.options.notice(session.id, notice);
  }
}
