/**
 * 问题服务：把「要不要交接 / 要不要登记这个目录 / 确认一下」变成**对象**（PRD D22 / F-I9）。
 *
 * 一个问题的四件事实都在这里：有 id、有状态、有生命周期、可持久化。多端看到的是同一个
 * 对象（库里那一行），所以「另一个窗口已经答过了」这件事不需要另开一条同步通道 ——
 * 第二次拉 `question.list` 就能看到状态变了。
 *
 * 三条贯穿本文件的边界：
 *
 * 1. **存码不存句子**（D8）：`questions.payload` 里存的是文案键 + 参数 + 候选项的值，
 *    读出时按调用方给的语言渲染。一条问题存死一种语言，换个连接就错了。
 * 2. **答完之后接着往下走**（D22）：`answer` 的副作用是宿主自己做掉的 —— 答「自交接 /
 *    独立摘要」就当场开始交接，客户端不必再发一次 `handoff.start`。
 * 3. **越线两端都拒绝时问题继续挂着**（D23 / F-D10）：答不下去的那些路径（对话正在跑、
 *    已经过了硬线而用户选了「就在这段里继续」）都不动这一行状态，所以问题不会被悄悄关掉。
 *    本文件里没有「自动过期」「答错一次就作废」这类隐式转移。
 */

import { randomUUID } from "node:crypto";

import type { ConfigManager } from "@ai-zen/agents-sdk";

import { DEFAULT_LANGUAGE, hasMessage, render } from "../i18n/index.js";
import type { Language, MessageKey } from "../i18n/index.js";
import type { ChatEventEmitter } from "../runtime/ChatRunner.js";
import type { RunsView } from "../runtime/RunRegistry.js";
import type { ConversationRepository } from "../storage/ConversationRepository.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import type { QuestionPatch, QuestionRepository } from "../storage/QuestionRepository.js";
import type { Question } from "../storage/types.js";
import { HostError } from "../wire/errors.js";
import type {
  HandoffStartParams,
  LocalizedText,
  QuestionAnswer,
  QuestionAnswerParams,
  QuestionAnswerResult,
  QuestionKind,
  QuestionListParams,
  QuestionListResult,
  QuestionOption,
  QuestionState,
  QuestionView,
} from "../wire/index.js";
import { readUsage } from "./MessageService.js";

/** 一句话的「码 + 参数」（库里存的是它，读出时才渲染成一句人话） */
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

/** 内部「问一个问题」的入口（交接线、登记项目、二次确认都走它） */
export interface AskQuestionInput {
  /** 挂在哪段对话上（问题总是为某一段对话停下来问的） */
  conversationId: string;
  kind: QuestionKind;
  prompt: LocalizedSource;
  options: QuestionOptionInput[];
  /**
   * 是否挡着这段对话（挡着时 `conversation.send` 会被拒，业务码 `question_pending`）。
   *
   * 缺省按种类定：交接确认与不可撤销动作的确认挡着对话，登记项目不挡 —— 后者与某一段
   * 对话的生成无关，挡了就变成「必须先答一个跟这次发送没关系的问题」。
   */
  blocking?: boolean;
  /** 出网的稳定码；缺省用 `prompt.messageKey` */
  code?: string;
  /**
   * 与界面无关、但答完之后用得到的事实（例如「哪个目录待登记」、要接着建哪段对话）。
   *
   * 存进 `questions.payload.data`：它不是文案，不跟着语言变；也不是契约上的东西（客户端
   * 只看得到渲染好的句子与候选项），宿主答完后自己取用。
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
 * 类型故意只声明本服务用得到的那一部分（`newConversationId`）：交接服务返回的字段比这多，
 * 结构上照样满足，免得两个服务为了一个字段互相 import 具体类。
 */
export interface QuestionHandoffPort {
  start(
    params: HandoffStartParams,
    language?: Language,
  ): Promise<{ newConversationId: string | null }>;
}

/** 硬线判定口：这段对话现在是不是已经过了硬线（PRD F-D1 / D23） */
export interface QuestionGuardProbe {
  overGuard(conversationId: string): Promise<boolean>;
}

export interface QuestionServiceDeps {
  questions: QuestionRepository;
  /** 「这段对话正在跑一轮」的唯一真相；不注入时按「没在跑」处理 */
  runs?: RunsView;
  /** 硬线判定；不注入时按「没过线」处理 */
  guard?: QuestionGuardProbe;
  /** 交接入口（答完接着交接，D22）；不注入时答完只改状态、不触发交接 */
  handoff?: QuestionHandoffPort;
  /** 推 `question` 事件（多端看到同一个，D22） */
  emit?: ChatEventEmitter;
  now?: () => number;
  newId?: () => string;
}

/** 交接问题的三个候选值（F-D2：自交接 / 独立摘要 / 不交接） */
export const HANDOFF_OPTION_SELF = "self";
export const HANDOFF_OPTION_SUMMARY = "summary";
export const HANDOFF_OPTION_DECLINE = "decline";

/** 库里那条 payload 解出来的形状（`questions.payload` 的 JSON） */
interface StoredPayload {
  code: string;
  prompt: { messageKey: string; params: Record<string, unknown> };
  options: Array<{
    value: string;
    label: { messageKey: string; params: Record<string, unknown> };
    detail: { messageKey: string; params: Record<string, unknown> } | null;
  }>;
  blocking: boolean;
  /** 答完之后用得到的事实（不渲染、不出网） */
  data: Record<string, unknown>;
}

/** 回答的稳定值（`questions.answer` 的 JSON） */
interface StoredAnswer {
  value: string;
  answeredBy: string | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 缺省挡不挡着对话：问题就是为「停下来问」而造的，默认挡着，除非创建时显式说不管 */
function defaultBlocking(_kind: QuestionKind): boolean {
  return true;
}

/** 一个 JSON 值是不是普通对象（解析库里的列用） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 库里那列 JSON → 打字过的载荷。
 *
 * 读不出来时给一份「只有码、没有候选」的形状而不是抛错：一行被手改坏的提问不该让整个
 * `question.list` 打不开，界面上至少能显示 id 与状态。
 */
function toStoredPayload(value: unknown, fallbackCode: string): StoredPayload {
  if (!isRecord(value)) {
    return {
      code: fallbackCode,
      prompt: { messageKey: "question.blocking", params: {} },
      options: [],
      blocking: false,
      data: {},
    };
  }
  const prompt = isRecord(value.prompt) ? value.prompt : {};
  const options = Array.isArray(value.options) ? value.options : [];
  return {
    code: typeof value.code === "string" ? value.code : fallbackCode,
    prompt: {
      messageKey: typeof prompt.messageKey === "string" ? prompt.messageKey : "question.blocking",
      params: isRecord(prompt.params) ? prompt.params : {},
    },
    options: options.filter(isRecord).map((option) => ({
      value: typeof option.value === "string" ? option.value : "",
      label: isRecord(option.label)
        ? {
            messageKey:
              typeof option.label.messageKey === "string"
                ? option.label.messageKey
                : "question.blocking",
            params: isRecord(option.label.params) ? option.label.params : {},
          }
        : { messageKey: "question.blocking", params: {} },
      detail: isRecord(option.detail)
        ? {
            messageKey:
              typeof option.detail.messageKey === "string"
                ? option.detail.messageKey
                : "question.blocking",
            params: isRecord(option.detail.params) ? option.detail.params : {},
          }
        : null,
    })),
    blocking: value.blocking === true,
    data: isRecord(value.data) ? value.data : {},
  };
}

/** 库里那列 answer 的 JSON → 打字过的回答 */
function toStoredAnswer(value: unknown): StoredAnswer | null {
  if (!isRecord(value) || typeof value.value !== "string") return null;
  return {
    value: value.value,
    answeredBy: typeof value.answeredBy === "string" ? value.answeredBy : null,
  };
}

/** 渲染一句话（键认不出来时退回「被这个问题挡住了」那句，至少说明有东西在等回答） */
function localizeText(
  code: string,
  source: { messageKey: string; params: Record<string, unknown> },
  language: Language,
): LocalizedText {
  const messageKey: MessageKey = hasMessage(source.messageKey)
    ? source.messageKey
    : "question.blocking";
  return {
    code,
    messageKey,
    params: source.params,
    message: render(language, messageKey, source.params),
  };
}

/** 一行库记录 → 契约上的问题对象（按给定语言渲染） */
function toView(question: Question, language: Language): QuestionView {
  const payload = toStoredPayload(question.payload, `question.${question.kind}`);
  const answer = toStoredAnswer(question.answer);
  const options: QuestionOption[] = payload.options.map((option) => ({
    value: option.value,
    label: localizeText(payload.code, option.label, language),
    detail: option.detail === null ? null : localizeText(payload.code, option.detail, language),
  }));
  const view: QuestionView = {
    id: question.id,
    conversationId: question.conversationId,
    kind: question.kind as QuestionKind,
    state: question.state as QuestionState,
    prompt: localizeText(payload.code, payload.prompt, language),
    options,
    answer:
      answer === null
        ? null
        : ({
            value: answer.value,
            answeredAt: iso(question.answeredAt ?? question.updatedAt),
            answeredBy: answer.answeredBy,
          } satisfies QuestionAnswer),
    blocking: payload.blocking,
    createdAt: iso(question.createdAt),
    updatedAt: iso(question.updatedAt),
  };
  return view;
}

export class QuestionService {
  private readonly questions: QuestionRepository;
  private readonly runs?: RunsView;
  private readonly guard?: QuestionGuardProbe;
  private readonly handoff?: QuestionHandoffPort;
  private readonly emit?: ChatEventEmitter;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: QuestionServiceDeps) {
    this.questions = deps.questions;
    this.runs = deps.runs;
    this.guard = deps.guard;
    this.handoff = deps.handoff;
    this.emit = deps.emit;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * 问一个问题（内部入口）。
   *
   * 先落库再推事件：库里那一行是「多端看同一个」的真相（D22），推送只是提醒在线的那几个
   * 窗口去拉（L5 断线即作废）。
   *
   * 入参不做形状校验：`kind` 与两个 `messageKey` 的类型本身就是闭集（`QuestionKind` /
   * `MessageKey`），而这里只有 `askHandoff` 一个调用方，候选项是常量字面量。
   */
  async ask(
    input: AskQuestionInput,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<QuestionView> {
    const payload: StoredPayload = {
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
      blocking: input.blocking ?? defaultBlocking(input.kind),
      data: input.data ?? {},
    };

    const id = this.newId();
    const createdAt = this.now();
    await this.questions.create({
      id,
      conversationId: input.conversationId,
      kind: input.kind,
      payload,
      state: "pending",
      createdAt,
    });

    const stored = await this.questions.get(id);
    if (!stored) {
      throw new HostError("internal", { detail: { reason: "question vanished after insert", id } });
    }
    const view = toView(stored, language);
    this.emit?.("question", { question: view, at: iso(createdAt) });
    return view;
  }

  /**
   * 到交接线时问「自交接 / 独立摘要 / 不交接」（PRD F-D2 / D22）。
   *
   * 触发点在**对话停下之后**：这里只负责把问题摆出来，不参与任何流式过程。
   * `percent` 是给人看的那个数（用量 / 交接线），数字本身留在库里与状态里。
   */
  async askHandoff(
    input: {
      conversationId: string;
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
        conversationId: input.conversationId,
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
   * 列出问题（PRD D22：多端看同一个）。
   *
   * `conversationId` 可选（R61）：给了就只看那段对话的；不给就看全库（含没挂对话的那些，
   * 例如「要不要把这个目录登记成项目」）。`state` 两种情况下都生效。
   */
  async list(
    params: QuestionListParams = {},
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<QuestionListResult> {
    const conversationId =
      typeof params.conversationId === "string" ? params.conversationId.trim() : "";
    const rows =
      conversationId.length > 0
        ? await this.questions.listByConversation(conversationId, params.state)
        : await this.questions.listAll(params.state);
    return { questions: rows.map((row) => toView(row, language)) };
  }

  /** 这段对话上还挂着、且正在挡着它的那些问题（`conversation.send` 的前置检查用它） */
  async blockingQuestions(conversationId: string): Promise<QuestionView[]> {
    const rows = await this.questions.listByConversation(conversationId, "pending");
    return rows
      .map((row) => toView(row, DEFAULT_LANGUAGE))
      .filter((view) => view.blocking);
  }

  /**
   * 有挡着的问题就拒绝（PRD D23 / F-D10 的「宿主也拒绝」）。
   *
   * 只在真有 `blocking` 的问题时抛 `question_pending`，并把那条问题的提问当参数带上：
   * 用户看到的是「哪个问题在挡着」，不是一句抽象的「还有问题没答」。
   */
  async assertSendable(conversationId: string): Promise<void> {
    const blocking = await this.blockingQuestions(conversationId);
    const first = blocking[0];
    if (!first) return;
    throw new HostError("question_pending", {
      params: { question: first.prompt.message },
      detail: { conversationId, questionId: first.id, kind: first.kind },
    });
  }

  /**
   * 回答一个问题（PRD D22 / F-I9）。
   *
   * 顺序是刻意的：
   *   1. 已经答过 / 已失效的直接回当前状态（多端同时点，后到的那一端看到的是「已经答了」，
   *      不重复触发副作用）；
   *   2. 值不在候选里 → `invalid_params`；
   *   3. 对话正在跑一轮 → `busy`（D22：交接在对话停下之后触发，不在流式中途）；
   *   4. 过了硬线又选了「就在这段里继续」 → `context_guard`，**问题继续挂着**（D23）；
   *   5. 改状态 → 该交接就当场交接。
   *
   * 第 3、4 两步都在写状态之前返回，所以「答不下去」不会把问题弄成一个半答的中间态。
   */
  async answer(
    params: QuestionAnswerParams,
    context: QuestionAnswerContext = {},
  ): Promise<QuestionAnswerResult> {
    const language = context.language ?? DEFAULT_LANGUAGE;
    const question = await this.requireQuestion(params.questionId);
    const value = typeof params.value === "string" ? params.value.trim() : "";
    if (value.length === 0) {
      throw new HostError("invalid_params", {
        params: { field: "value" },
        detail: { field: "value", reason: "empty" },
      });
    }

    const payload = toStoredPayload(question.payload, `question.${question.kind}`);
    if (question.state !== "pending") {
      // 已经在别处答过（或已作废）：不报错、不重复触发副作用，回当前状态
      return { question: toView(question, language), effects: noEffects() };
    }
    const chosen = payload.options.find((option) => option.value === value);
    if (!chosen) {
      throw new HostError("invalid_params", {
        params: { field: "value" },
        detail: { field: "value", value, options: payload.options.map((option) => option.value) },
      });
    }

    const conversationId = question.conversationId;
    if (this.runs?.isRunning(conversationId) === true) {
      throw new HostError("busy", {
        detail: { conversationId, questionId: question.id, reason: "turn_in_flight" },
      });
    }

    const kind = question.kind as QuestionKind;
    const handoffMode = handoffModeOf(kind, value);
    const continuesHere = kind === "handoff" && handoffMode === null;
    if (continuesHere && this.guard) {
      if (await this.guard.overGuard(conversationId)) {
        // D23：越过硬线，宿主也拒绝；这一行**不动**，问题继续挂着等人处理
        throw new HostError("context_guard", {
          detail: {
            conversationId,
            questionId: question.id,
            reason: "over_guard",
            nextStep: "handoff",
          },
        });
      }
    }

    const answeredAt = this.now();
    const answer: StoredAnswer = { value, answeredBy: context.answeredBy ?? null };
    const patch: QuestionPatch = {
      state: "answered",
      answer,
      answeredAt,
      updatedAt: answeredAt,
    };
    await this.questions.update(question.id, patch);

    const answeredRow = await this.questions.get(question.id);
    const view = toView(answeredRow ?? question, language);
    this.emit?.("question", { question: view, at: iso(answeredAt) });

    const effects = await this.applyEffects(
      { kind, value, handoffMode, conversationId, data: payload.data },
      language,
    );
    return { question: view, effects };
  }

  /**
   * 显式取消一个问题（生命周期里的 `cancelled`）。
   *
   * 只有调用方明确要关掉时才用（例如对话被删、工作流换了方向）。没有任何自动取消的路径 ——
   * 越线拒绝之后问题要继续挂着（D23），所以「答不下去」与「关掉它」是两件事。
   */
  async cancel(questionId: string, language: Language = DEFAULT_LANGUAGE): Promise<QuestionView> {
    const question = await this.requireQuestion(questionId);
    const cancelledAt = this.now();
    await this.questions.update(question.id, { state: "cancelled", updatedAt: cancelledAt });
    const row = await this.questions.get(question.id);
    const view = toView(row ?? question, language);
    this.emit?.("question", { question: view, at: iso(cancelledAt) });
    return view;
  }

  /**
   * 答完之后接着往下走：交接（D22）。
   *
   * 只在问题已经落成 `answered` 之后才跑：答不下去的那些情况（越线、对话在跑）
   * 在写状态之前就返回了，所以这里不需要再判断一遍。
   */
  private async applyEffects(
    input: {
      kind: QuestionKind;
      value: string;
      handoffMode: "self" | "summary" | null;
      conversationId: string;
      data: Record<string, unknown>;
    },
    language: Language,
  ): Promise<QuestionAnswerResult["effects"]> {
    if (input.kind !== "handoff" || input.handoffMode === null || !this.handoff) {
      return noEffects();
    }
    try {
      const started = await this.handoff.start(
        {
          conversationId: input.conversationId,
          mode: input.handoffMode,
          then: "new_conversation",
        },
        language,
      );
      return { handoffStarted: true, newConversationId: started.newConversationId };
    } catch (error) {
      // 用户取消了交接（F-D7：回到交接前，不重试、不报错）：问题已答，只是没有交出文档
      if (HostError.is(error) && error.code === "handoff_declined") {
        return noEffects();
      }
      throw error;
    }
  }

  private async requireQuestion(questionId: string): Promise<Question> {
    const id = typeof questionId === "string" ? questionId.trim() : "";
    const row = id.length === 0 ? undefined : await this.questions.get(id);
    if (!row) {
      throw new HostError("not_found", {
        params: { entity: "question" },
        detail: { questionId },
      });
    }
    return row;
  }
}

/** 没有副作用 */
function noEffects(): QuestionAnswerResult["effects"] {
  return { handoffStarted: false, newConversationId: null };
}

/** 这个候选值要不要交接、用哪种执行者（只有交接问题有这一层语义） */
function handoffModeOf(kind: QuestionKind, value: string): "self" | "summary" | null {
  if (kind !== "handoff") return null;
  if (value === HANDOFF_OPTION_SELF) return "self";
  if (value === HANDOFF_OPTION_SUMMARY) return "summary";
  return null;
}

/**
 * 按配置与历史算「这段对话是不是已经过了硬线」。
 *
 * 硬线跟着模型走（`tokenThresholds.guard`，D27），用量取最近一条带用量的消息：
 * 与 `conversation.state` 里那份 `ContextState` 是同一个口径（都看 `usage.prompt_tokens`）。
 */
export function createConversationGuardProbe(deps: {
  conversations: ConversationRepository;
  messages: MessageRepository;
  configManager: ConfigManager;
}): QuestionGuardProbe {
  return {
    async overGuard(conversationId: string): Promise<boolean> {
      const conversation = await deps.conversations.get(conversationId);
      if (!conversation) return false;
      const config = await deps.configManager.read();
      const model = config.models.find((candidate) => candidate.id === conversation.modelId);
      const guardThreshold = model?.tokenThresholds.guard ?? 0;
      if (guardThreshold <= 0) return false;

      const rows = await deps.messages.listByConversation(conversationId);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        const usage = row ? readUsage(row.data) : null;
        if (usage) return usage.prompt_tokens >= guardThreshold;
      }
      return false;
    },
  };
}
