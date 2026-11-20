/**
 * 问题服务：把「要不要交接 / 确认一下」变成**进程内对象**（PRD 4.10）。
 *
 * **题不落库。** 题的生命 = 这一段会话活着的这段时间，它的去处只有两个：**被答了**、
 * **这段会话没了（含意外死）**。没有「关掉」这个动作，没有「过期 / 被取消」两格 —— 所以这里
 * 没有存储层、没有状态机式的隐式转移，只有一张内存表（按 id 存题，按会话取的时候在它上面筛）。
 * 多端看到的是**同一个对象**（同一个进程里的同一个引用），所以「另一个窗口已经答过了」不需要
 * 任何同步通道；丢了的那一份只有跨重启。
 *
 * 四条贯穿本文件的边界：
 *
 * 1. **存码不存句子**（D8）：题里存的是文案键 + 参数 + 候选项的值，出口处按连接语言渲染。
 *    一条题存死一种语言，换个连接就错了。因为对象只活在内存里，这条路也不再需要「从库里读出来
 *    可能被改坏」的防御层 —— 写进对象的就是调用方给的那几个闭集类型。
 * 2. **答完之后接着往下走**：`answer` 的副作用是宿主自己做掉的。顺序见
 *    {@link QuestionService.answer}：**先答完，再判能不能立刻交接**。
 * 3. **答题不被「忙」拦住**（PRD 4.10）：忙不是答题的拒因 —— 那段正忙着就把「待交接」写在会话行
 *    上（`pendingHandoff`），等它闲下来再做。所以这里没有「非 idle 就 busy」那道前置检查。
 * 4. **死的那一刻跟着没**（`dropSession`）：会话没了（被删、被硬着陆、agent 自己停了），
 *    挂在上面的题一起清掉 —— 不存在「死会话上挂着的题」。退役不算没（那是换个 agent 接着干）。
 */

import { randomUUID } from "node:crypto";

import type { ConfigManager } from "@ai-zen/agents-sdk";

import { DEFAULT_LANGUAGE, render } from "../i18n/index.js";
import type { Language, MessageKey } from "../i18n/index.js";
import type { ChatEventEmitter } from "../runtime/ChatRunner.js";
import type { SessionRepository } from "../storage/SessionRepository.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import { HostError } from "../wire/errors.js";
import type {
  HandoffMode,
  HandoffRefusalReason,
  HandoffStartParams,
  LocalizedText,
  QuestionAnswer,
  QuestionAnswerParams,
  QuestionAnswerResult,
  QuestionEffects,
  QuestionKind,
  QuestionListParams,
  QuestionListResult,
  QuestionOption,
  QuestionState,
  QuestionView,
} from "../wire/index.js";
import { readUsage } from "./MessageService.js";

/** 一句话的「码 + 参数」（题里存的是它，出口处才渲染成一句人话） */
export interface LocalizedSource {
  messageKey: MessageKey;
  params?: Record<string, unknown>;
}

/** 一个候选答案的入参 */
export interface QuestionOptionInput {
  /** 提交回答时回传的值 */
  value: string;
  label: LocalizedSource;
  detail?: LocalizedSource | null;
}

/** 内部「问一个问题」的入口（交接线那一条） */
export interface AskQuestionInput {
  /** 挂在哪段会话上（问题总是为某一段会话停下来问的） */
  sessionId: string;
  kind: QuestionKind;
  prompt: LocalizedSource;
  options: QuestionOptionInput[];
  /**
   * 是否挡着这段会话（挡着时 `session.send` 会被拒，业务码 `question_pending`）。
   *
   * 缺省挡着：问题就是为「停下来问」而造的。
   */
  blocking?: boolean;
  /** 出网的稳定码；缺省用 `prompt.messageKey` */
  code?: string;
  /**
   * 与界面无关、但答完之后用得到的事实（例如「要接着建哪段会话」）。
   *
   * 它不是文案，不跟着语言变；也不是契约上的东西（客户端只看得到渲染好的句子与候选项），
   * 宿主答完后自己取用。
   */
  data?: Record<string, unknown>;
}

/** 回答时的现场事实：哪条连接答的、用哪种语言回话 */
export interface QuestionAnswerContext {
  language?: Language;
  /** 回答它的那条连接（多端时用来显示「别的窗口答了」） */
  answeredBy?: string | null;
}

/**
 * 答完之后的副作用入口（交接那一步）。
 *
 * 类型故意只声明本服务用得到的那一部分（`started`）：交接服务返回的字段比这多，
 * 结构上照样满足，免得两个服务为了一个字段互相 import 具体类。
 *
 * 它**不等那一趟跑完**：交接一旦开始就回「开始了」，文档写到哪、有没有降级走通知（PRD 4.9）。
 */
export interface QuestionHandoffPort {
  start(params: HandoffStartParams, language?: Language): Promise<{ started: true }>;
}

/**
 * 「这段现在能不能立刻交接」的口（`ChatRunner.canHandoffNow`，全仓唯一一份判据）。
 *
 * 答完之后是**能就当场交接、不能就留待交接**：四个拒因原样进回执，客户端不必自己猜为什么
 * 没开始（`PLAN §5.2` / §5.3）。
 */
export interface QuestionHandoffAvailabilityPort {
  canHandoffNow(sessionId: string): { ok: true } | { ok: false; reason: HandoffRefusalReason };
}

/** 硬线判定口：这段会话现在是不是已经过了硬线 */
export interface QuestionGuardProbe {
  overGuard(sessionId: string): Promise<boolean>;
}

export interface QuestionServiceDeps {
  /**
   * 会话行：两处要用它 —— 待交接那一格（`pendingHandoff` 的写读）与「不交接」时关掉自动交接
   * 开关（PRD 4.10 的「答案的后果要落」）。题本身**不**经它落库。
   */
  sessions: SessionRepository;
  /** 能不能立刻交接（判据在 `ChatRunner.canHandoffNow`，这里只读）；不注入时按「能」处理 */
  availability?: QuestionHandoffAvailabilityPort;
  /** 硬线判定；不注入时按「没过线」处理 */
  guard?: QuestionGuardProbe;
  /** 交接入口（答完接着交接）；不注入时答完只改状态、不触发交接 */
  handoff?: QuestionHandoffPort;
  /** 推 `question` 事件（多端看到同一个）；推 `session.changed` 用同一个出口 */
  emit?: ChatEventEmitter;
  now?: () => number;
  newId?: () => string;
}

/** 交接问题的三个候选值：自交接 / 独立摘要 / 不交接 */
export const HANDOFF_OPTION_SELF = "self";
export const HANDOFF_OPTION_SUMMARY = "summary";
export const HANDOFF_OPTION_DECLINE = "decline";

/**
 * 一道题（进程内对象）。
 *
 * 存的都是「码 + 参数」，没有一句现成的话：渲染在出口处按连接语言做（D8）。
 */
interface QuestionRecord {
  id: string;
  sessionId: string;
  kind: QuestionKind;
  /** 出网的稳定码（缺省 = `prompt.messageKey`） */
  code: string;
  prompt: { messageKey: MessageKey; params: Record<string, unknown> };
  options: Array<{
    value: string;
    label: { messageKey: MessageKey; params: Record<string, unknown> };
    detail: { messageKey: MessageKey; params: Record<string, unknown> } | null;
  }>;
  /** 答完之后用得到的事实（不渲染、不出网） */
  data: Record<string, unknown>;
  blocking: boolean;
  /** 只有两格：挂着等人答 / 已经答了（没有「过期」「被取消」） */
  state: QuestionState;
  answer: { value: string; answeredBy: string | null; answeredAt: number } | null;
  createdAt: number;
  updatedAt: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 渲染一句话（键的类型本身就是闭集，不需要「认不出来退回哪句」那一层） */
function localizeText(
  code: string,
  source: { messageKey: MessageKey; params: Record<string, unknown> },
  language: Language,
): LocalizedText {
  return {
    code,
    messageKey: source.messageKey,
    params: source.params,
    message: render(language, source.messageKey, source.params),
  };
}

/** 对象 → 契约上的问题（按给定语言渲染） */
function toView(question: QuestionRecord, language: Language): QuestionView {
  const options: QuestionOption[] = question.options.map((option) => ({
    value: option.value,
    label: localizeText(question.code, option.label, language),
    detail: option.detail === null ? null : localizeText(question.code, option.detail, language),
  }));
  const answer: QuestionAnswer | null =
    question.answer === null
      ? null
      : {
          value: question.answer.value,
          answeredAt: iso(question.answer.answeredAt),
          answeredBy: question.answer.answeredBy,
        };
  return {
    id: question.id,
    sessionId: question.sessionId,
    kind: question.kind,
    state: question.state,
    prompt: localizeText(question.code, question.prompt, language),
    options,
    answer,
    blocking: question.blocking,
    createdAt: iso(question.createdAt),
    updatedAt: iso(question.updatedAt),
  };
}

export class QuestionService {
  private readonly sessions: SessionRepository;
  private readonly availability?: QuestionHandoffAvailabilityPort;
  private readonly guard?: QuestionGuardProbe;
  private readonly handoff?: QuestionHandoffPort;
  private readonly emit?: ChatEventEmitter;
  private readonly now: () => number;
  private readonly newId: () => string;
  /**
   * 挂着的那些题（按 id 索引，插入顺序即创建顺序）。
   *
   * 一张表就够：按会话取的时候在它上面筛（一段会话上同时挂着的题不会多）。不去维护第二张
   * 「会话 → 题」的索引 —— 两张表就有「哪一张才是真的」这个第二份事实。
   */
  private readonly questions = new Map<string, QuestionRecord>();

  constructor(deps: QuestionServiceDeps) {
    this.sessions = deps.sessions;
    this.availability = deps.availability;
    this.guard = deps.guard;
    this.handoff = deps.handoff;
    this.emit = deps.emit;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * 问一个问题（内部入口）。
   *
   * 直接造对象 + 推 `question` 事件：没有「先落库再读回来」那一趟，所以也不会有
   * 「刚插进去就不见了」这种中间态。题挂着期间它挡着这段会话（`blocking`），
   * `session.send` 由 {@link assertSendable} 拒。
   *
   * 入参不做形状校验：`kind` 与 `messageKey` 的类型本身就是闭集（`QuestionKind` /
   * `MessageKey`），候选项是常量字面量。
   */
  async ask(input: AskQuestionInput, language: Language = DEFAULT_LANGUAGE): Promise<QuestionView> {
    const createdAt = this.now();
    const question: QuestionRecord = {
      id: this.newId(),
      sessionId: input.sessionId,
      kind: input.kind,
      code: input.code ?? input.prompt.messageKey,
      prompt: { messageKey: input.prompt.messageKey, params: input.prompt.params ?? {} },
      options: input.options.map((option) => ({
        value: option.value,
        label: { messageKey: option.label.messageKey, params: option.label.params ?? {} },
        detail:
          option.detail === undefined || option.detail === null
            ? null
            : { messageKey: option.detail.messageKey, params: option.detail.params ?? {} },
      })),
      data: input.data ?? {},
      // 缺省挡着：问题就是为「停下来问」而造的
      blocking: input.blocking ?? true,
      state: "pending",
      answer: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.questions.set(question.id, question);

    const view = toView(question, language);
    this.emit?.("question", { question: view, at: iso(createdAt) });
    return view;
  }

  /**
   * 到交接线时问「自交接 / 独立摘要 / 不交接」。
   *
   * 触发点在**会话停下之后**：这里只负责把问题摆出来，不参与任何流式过程。
   * `percent` 是给人看的那个数（用量 / 交接线）。
   */
  async askHandoff(
    input: {
      sessionId: string;
      promptTokens: number;
      handoffTokens: number;
      blocking?: boolean;
    },
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<QuestionView> {
    const percent =
      input.handoffTokens > 0
        ? Math.min(999, Math.round((input.promptTokens / input.handoffTokens) * 100))
        : 100;
    return await this.ask(
      {
        sessionId: input.sessionId,
        kind: "handoff",
        code: "question.handoff.prompt",
        prompt: { messageKey: "question.handoff.prompt", params: { percent } },
        options: [
          {
            value: HANDOFF_OPTION_SELF,
            label: { messageKey: "question.handoff.self" },
            detail: { messageKey: "question.handoff.selfDetail" },
          },
          {
            value: HANDOFF_OPTION_SUMMARY,
            label: { messageKey: "question.handoff.summary" },
            detail: { messageKey: "question.handoff.summaryDetail" },
          },
          { value: HANDOFF_OPTION_DECLINE, label: { messageKey: "question.handoff.decline" } },
        ],
        blocking: input.blocking ?? true,
      },
      language,
    );
  }

  /**
   * 这段会话上的题（按创建顺序）。
   *
   * `sessionId` **必填**：没有「全库问题列表」这种读法（PRD 4.10 的「明确不做」）——
   * 题只属于某一段会话，问「全库有什么题」是为了持久化才存在的形状。也没有 `state` 过滤：
   * 客户端要的那句话就是「这段现在有没有一道题」。
   */
  async list(
    params: QuestionListParams,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<QuestionListResult> {
    const sessionId = params.sessionId;
    return {
      questions: this.questionsOf(sessionId).map((question) => toView(question, language)),
    };
  }

  /**
   * 这段会话上还挂着的题有几道（侧栏摘要的 `hasPendingQuestion`）。
   *
   * 现读内存：题不落库，所以**不能**问库（问了永远得 0）。
   */
  countPending(sessionId: string): number {
    return this.questionsOf(sessionId).filter((question) => question.state === "pending").length;
  }

  /** 这段会话上还挂着、且正在挡着它的那些题（`session.send` 的前置检查用它） */
  async blockingQuestions(sessionId: string): Promise<QuestionView[]> {
    return this.questionsOf(sessionId)
      .filter((question) => question.state === "pending" && question.blocking)
      .map((question) => toView(question, DEFAULT_LANGUAGE));
  }

  /**
   * 有挡着的问题就拒绝（宿主也拒绝）。
   *
   * 只在真有 `blocking` 的问题时抛 `question_pending`，并把那条问题的提问当参数带上：
   * 用户看到的是「哪个问题在挡着」，不是一句抽象的「还有问题没答」。
   */
  async assertSendable(sessionId: string): Promise<void> {
    const blocking = await this.blockingQuestions(sessionId);
    const first = blocking[0];
    if (!first) return;
    throw new HostError("question_pending", {
      params: { question: first.prompt.message },
      detail: { sessionId, questionId: first.id, kind: first.kind },
    });
  }

  /**
   * 回答一个问题（PRD 4.10）。
   *
   * 顺序是刻意的，别调换：
   *
   *   1. 题不存在 → `not_found`；值不在候选里 → `invalid_params`；已经答过 → 回当前状态、
   *      **不重复副作用**（多端同时点，后到的那一端看到的是「已经答了」）；
   *   2. 越过硬线却选了「就在这段里继续」→ `context_guard`，**题仍挂着**；
   *   3. **先把题标成已答并推事件** —— 答题本身不被「忙」拦住（PRD 4.10）；
   *   4. 再看答完之后该发生什么（{@link applyEffects}）：能立刻交接就当场交接，不能就在会话行上
   *      留一条待交接，等下一次变闲再做。
   *
   * 没有「非 idle 就 busy」那道前置检查：那道检查会把「题答了但交接还没做」这个中间态变成
   * 用户必须重答一次的错误。忙不忙只影响第 4 步**怎么落地**，不影响题能不能被答。
   */
  async answer(
    params: QuestionAnswerParams,
    context: QuestionAnswerContext = {},
  ): Promise<QuestionAnswerResult> {
    const language = context.language ?? DEFAULT_LANGUAGE;
    const question = this.requireQuestion(params.questionId);
    const value = typeof params.value === "string" ? params.value.trim() : "";
    if (value.length === 0) {
      throw new HostError("invalid_params", {
        params: { field: "value" },
        detail: { field: "value", reason: "empty" },
      });
    }

    if (question.state !== "pending") {
      // 已经在别处答过：不报错、不重复触发副作用，回当前状态
      return { question: toView(question, language), effects: noEffects(null) };
    }
    const chosen = question.options.find((option) => option.value === value);
    if (!chosen) {
      throw new HostError("invalid_params", {
        params: { field: "value" },
        detail: {
          field: "value",
          value,
          options: question.options.map((option) => option.value),
        },
      });
    }

    const sessionId = question.sessionId;
    const handoffMode = handoffModeOf(question.kind, value);
    // 越线之后仍然选「就在这段里继续」：宿主也拒，题继续挂着等人处理
    if (question.kind === "handoff" && handoffMode === null && this.guard) {
      if (await this.guard.overGuard(sessionId)) {
        throw new HostError("context_guard", {
          detail: {
            sessionId,
            questionId: question.id,
            reason: "over_guard",
            nextStep: "handoff",
          },
        });
      }
    }

    const answeredAt = this.now();
    question.state = "answered";
    question.answer = { value, answeredBy: context.answeredBy ?? null, answeredAt };
    question.updatedAt = answeredAt;

    const view = toView(question, language);
    this.emit?.("question", { question: view, at: iso(answeredAt) });

    const effects = await this.applyEffects(
      {
        kind: question.kind,
        value,
        handoffMode,
        sessionId,
      },
      language,
    );
    return { question: view, effects };
  }

  /**
   * 答完之后接着往下走（PRD 4.10 / `PLAN §5.2`）—— 只在题已经标成 `answered` 之后才跑。
   *
   * 三种情形：
   *
   * - **选了交接（自交接 / 独立摘要）**：读 `canHandoffNow`（全仓唯一一份判据）——
   *   能就当场 `handoff.start`（关输出闸在批头，不是这里的事）；**不能就不交接**，把 mode 写进
   *   会话行的 `pendingHandoff`，等下一次变闲再做。回执里那一格 `handoffDeferredReason` 说清
   *   为什么没开始；`null` 表示「要么当场开始了、要么这道题不需要交接」。
   * - **选了「不交接」**：把这段会话的自动交接开关关掉（PRD 4.10 的「答案的后果要落」）——
   *   否则下一次撞线又问一遍，等于没记住。关掉是写会话行，所以顺手推一条
   *   `session.changed(settings_changed)`：别的窗口的状态栏得跟着变。
   * - 别的种类（`confirmation`）：没有后续动作。
   *
   * 不等交接跑完：回执只有「开始了 / 留了待交接」，文档写到哪走通知（PRD 4.9）。
   */
  private async applyEffects(
    input: {
      kind: QuestionKind;
      value: string;
      handoffMode: HandoffMode | null;
      sessionId: string;
    },
    language: Language,
  ): Promise<QuestionEffects> {
    if (input.kind !== "handoff") return noEffects(null);

    if (input.handoffMode === null) {
      // 「不交接」：关掉自动交接开关，以后不问（PRD 4.10）
      const offAt = this.now();
      await this.sessions.setAutoHandoff(input.sessionId, false, offAt);
      // 开关是会话行上的一格，别的窗口的状态栏上必须看得见它变了。
      //
      // 同一个理由与写法照 `ChatRunner.beginHandoff`：这一格是本服务的动作，而会话行是异步读的
      // ——推送这一拍拿不到 `workspaceId`，就照实给 `null`（载荷里那一格本来就可空，客户端拿
      // `sessionId` 定位，不靠 `workspaceId`）。
      this.emit?.("session.changed", {
        sessionId: input.sessionId,
        workspaceId: null,
        change: "settings_changed",
        at: iso(offAt),
      });
      return noEffects(null);
    }

    if (!this.handoff) return noEffects(null);

    const availability = this.availability?.canHandoffNow(input.sessionId) ?? { ok: true };
    if (!availability.ok) {
      // 这段不闲（或没有 agent / 闸关着 / 已在交接）：留一条待交接，等下一次变闲再做
      await this.writePendingHandoff(input.sessionId, input.handoffMode);
      return { handoffStarted: false, handoffDeferredReason: availability.reason };
    }

    await this.handoff.start(
      {
        sessionId: input.sessionId,
        mode: input.handoffMode,
        then: "new_session",
      },
      language,
    );
    return { handoffStarted: true, handoffDeferredReason: null };
  }

  /**
   * 这段会话**没了**：挂在上面的题一起清掉，会话行上的待交接也一并清。
   *
   * 三条路共用这一个入口：真死（core 的 `stopped` / `killed`、投递撞上一个已经关门的 agent）
   * 与会话被删 —— 那三条都在 `ChatRunner` 报「死」那一拍，由接线层按 `kind` 分过来。所以这里
   * 是「题的生命 = 这段会话活着的这段时间」的落点：不存在「死会话上挂着的题」，也不必为它复活谁。
   *
   * **退役不走这里**：改配置 / 改模型 / 改思考档 / 装配事实变化之后旧 agent 退役、新 agent 重建，
   * 会话接着往下走 —— 题与待交接原样留着（清掉它们等于用户改了个模型就丢了正在等的那道题）。
   *
   * **不推事件**：「题没了」这件事由 `session.changed`（`agent_gone` / `deleted`）说，
   * 多推一条只会让客户端去处理一个它没有槽位的东西。
   *
   * 清会话行那一步对「会话已被删」是空操作（行本来就不在了），不需要分支。
   */
  async dropSession(sessionId: string): Promise<void> {
    for (const [id, question] of this.questions) {
      if (question.sessionId === sessionId) this.questions.delete(id);
    }
    await this.sessions.setPendingHandoff(sessionId, null);
  }

  /**
   * 会话行上的待交接 mode（`null` = 没有待交接）。
   *
   * 它是「答完之后这段不闲」留下的那一笔：读它的是 `app.ts` 的 `runPendingHandoff`（变闲那一拍），
   * 交接真的开始之后由那里清掉；接不了就原样留着，下一次变闲再看。
   */
  async readPendingHandoff(sessionId: string): Promise<HandoffMode | null> {
    const session = await this.sessions.get(sessionId);
    return session?.pendingHandoff ?? null;
  }

  /** 写下待交接（`null` = 清掉）。会话已经不在了就是空操作（`setPendingHandoff` 回 0） */
  async writePendingHandoff(sessionId: string, mode: HandoffMode | null): Promise<void> {
    await this.sessions.setPendingHandoff(sessionId, mode);
  }

  /** 这段会话上的题（创建顺序） */
  private questionsOf(sessionId: string): QuestionRecord[] {
    const found: QuestionRecord[] = [];
    for (const question of this.questions.values()) {
      if (question.sessionId === sessionId) found.push(question);
    }
    return found;
  }

  /** 按 id 找题（不存在就是 `not_found`） */
  private requireQuestion(questionId: string): QuestionRecord {
    const id = typeof questionId === "string" ? questionId.trim() : "";
    const question = id.length === 0 ? undefined : this.questions.get(id);
    if (!question) {
      throw new HostError("not_found", {
        params: { entity: "question" },
        detail: { questionId },
      });
    }
    return question;
  }
}

/**
 * 没有后续动作。
 *
 * `deferredReason` 只在「该交接但当时不能」时才有值（`canHandoffNow` 那四个词之一）；
 * 当场开始了、或者这道题根本不需要交接，都是 `null`。
 */
function noEffects(deferredReason: HandoffRefusalReason | null): QuestionEffects {
  return { handoffStarted: false, handoffDeferredReason: deferredReason };
}

/** 这个候选值要不要交接、用哪种执行者（只有交接问题有这一层语义） */
function handoffModeOf(kind: QuestionKind, value: string): HandoffMode | null {
  if (kind !== "handoff") return null;
  if (value === HANDOFF_OPTION_SELF) return "self";
  if (value === HANDOFF_OPTION_SUMMARY) return "summary";
  return null;
}

/**
 * 按配置与历史算「这段会话是不是已经过了硬线」。
 *
 * 硬线先看**会话行上的覆盖值**（`guardThreshold`），没有就看模型（`tokenThresholds.guard`）；
 * 与 `app.ts` 变闲那一拍取的是同一条事实（最后一条带用量的消息的 `prompt_tokens`），只是那边
 * 读内存、这里读库。两处都是现读会话行：那一列改了不必重建 agent（PRD 1.4）。
 */
export function createSessionGuardProbe(deps: {
  sessions: SessionRepository;
  messages: MessageRepository;
  configManager: ConfigManager;
}): QuestionGuardProbe {
  return {
    async overGuard(sessionId: string): Promise<boolean> {
      const session = await deps.sessions.get(sessionId);
      if (!session) return false;
      const config = await deps.configManager.read();
      const model = config.models.find((candidate) => candidate.id === session.modelId);
      const guardThreshold = session.guardThreshold ?? model?.tokenThresholds.guard ?? 0;
      if (guardThreshold <= 0) return false;

      const rows = await deps.messages.listBySession(sessionId);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        const usage = row ? readUsage(row.data) : null;
        if (usage) return usage.prompt_tokens >= guardThreshold;
      }
      return false;
    },
  };
}
