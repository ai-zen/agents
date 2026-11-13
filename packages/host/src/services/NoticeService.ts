/**
 * 通知服务：一条**独立通道**（PRD F-I8），它不进消息流。
 *
 * 三件事在这里定死：
 *
 * 1. **持久化**（PRD L3）：通知落 `notices` 表，重启之后还在；永久通知的消失只有「手动清」
 *    这一条路径（`notice.dismiss` / `notice.clear`），带持续时间的到点自己消失。
 * 2. **持续时间的两套单位**（R15）：契约用**秒**（用户语义：「这条提示留 3 秒」），
 *    库里存**毫秒**（`notices.durationMs`）。换算只有本文件这一处 —— 别处再换一次，
 *    迟早有一条通知留 3 毫秒或 3 天。
 * 3. **存码不存句子**（D8 / architecture §6）：库里存的是「码 + 参数」，读出时按**调用方
 *    给的语言**渲染。语言挂在连接上，一条通知存死一种语言、换个语言连回来就错了。
 *
 * 语气三档 `info | warning | error`（R4）：「已保存」这种一秒提示是 `info` + 短 duration，
 * 不新增 success 档；`warning` / `error` 同时是宿主日志上浮的通道（PRD F-J2）。
 */

import { randomUUID } from "node:crypto";

import { DEFAULT_LANGUAGE, hasMessage, render } from "../i18n/index.js";
import type { Language, MessageKey } from "../i18n/index.js";
import type { ChatEventEmitter } from "../runtime/ChatRunner.js";
import type { NoticeRepository } from "../storage/NoticeRepository.js";
import type { Notice } from "../storage/types.js";
import { HostError } from "../wire/errors.js";
import { NOTICE_LEVELS } from "../wire/states.js";
import type {
  NoticeClearParams,
  NoticeClearResult,
  NoticeDismissParams,
  NoticeDismissResult,
  NoticeLevel,
  NoticeListParams,
  NoticeListResult,
  NoticeView,
} from "../wire/index.js";
import type { EventMap, EventName } from "../wire/events.js";
import type { LocalizedText, QuestionView } from "../wire/states.js";

/** 库里那条 `code` 认不出来时用的文案键（配置被手改坏、旧版本写进去的码） */
const UNKNOWN_CODE_KEY: MessageKey = "notice.unknown";

/** 造一条通知的入参（内部入口；`notice.*` 三个方法只读 / 只清） */
export interface NoticeCreateInput {
  level: NoticeLevel;
  /**
   * 文案键，同时作为出网的稳定码（`LocalizedText.code`）。
   *
   * 两者合一是有意的：通知的稳定码本来就是「哪句话」这件事，另起一套码只会多一张对照表。
   */
  code: MessageKey;
  params?: Record<string, unknown>;
  /** 秒；不给或给 `null` 表示永久，直到被手动清掉（PRD L3） */
  duration?: number | null;
  /** 与哪段对话有关；不给表示全局通知 */
  conversationId?: string | null;
}

export interface NoticeServiceDeps {
  notices: NoticeRepository;
  /** 推 `notice` 事件；不注入就不推（用例、或不需要在线推送的场合） */
  emit?: ChatEventEmitter;
  /** 时钟，测试注入用；缺省 `Date.now` */
  now?: () => number;
  /** 通知 id 的分配口，测试注入用；缺省 `crypto.randomUUID` */
  newId?: () => string;
}

/** 时间戳转 wire 上的 ISO 8601 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 库里的语气档位：认不出来就按 `info` 摆（手改坏的数据不该让整条列表读不出来） */
function toLevel(value: string): NoticeLevel {
  return (NOTICE_LEVELS as readonly string[]).includes(value) ? (value as NoticeLevel) : "info";
}

/**
 * 秒 → 毫秒（R15 的唯一一处换算）。
 *
 * 不是数字、负数、`NaN`、无穷大都按「参数不对」拒：这条通知要么留一段确定的时间，
 * 要么永久留着，不存在「留一段说不清多久」。
 */
function toDurationMs(duration: number | null | undefined, field: string): number | null {
  if (duration === undefined || duration === null) return null;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
    throw new HostError("invalid_params", {
      params: { field },
      detail: { field, reason: "not_a_duration", value: duration },
    });
  }
  return Math.round(duration * 1000);
}

/**
 * 一行库记录 → 契约上的 `NoticeView`（按给定语言渲染）。
 *
 * `duration` 在这里由毫秒换回秒：库里是机器口径，出网是用户口径。
 */
function toView(notice: Notice, language: Language): NoticeView {
  const params = notice.params ?? {};
  const known = hasMessage(notice.code);
  const messageKey: MessageKey = known ? (notice.code as MessageKey) : UNKNOWN_CODE_KEY;
  // 认不出来的码：把原码当参数交给兜底那句，用户至少能看到它是什么
  const renderParams = known ? params : { ...params, code: notice.code };
  const text: LocalizedText = {
    code: notice.code,
    messageKey,
    params: renderParams,
    message: render(language, messageKey, renderParams),
  };
  return {
    id: notice.id,
    level: toLevel(notice.level),
    duration: notice.durationMs === null ? null : notice.durationMs / 1000,
    text,
    conversationId: notice.conversationId,
    createdAt: iso(notice.createdAt),
  };
}

/** 按语言重渲染一句已存的文案（`messageKey` + `params` 都在 `LocalizedText` 里） */
export function relocalizeText(text: LocalizedText, language: Language): LocalizedText {
  const messageKey: MessageKey = hasMessage(text.messageKey) ? text.messageKey : UNKNOWN_CODE_KEY;
  return { ...text, message: render(language, messageKey, text.params) };
}

/** 按语言重渲染一个问题的提示与候选（多端各自的语言，PRD D8） */
function relocalizeQuestion(question: QuestionView, language: Language): QuestionView {
  return {
    ...question,
    prompt: relocalizeText(question.prompt, language),
    options: question.options.map((option) => ({
      ...option,
      label: relocalizeText(option.label, language),
      detail: option.detail === null ? null : relocalizeText(option.detail, language),
    })),
  };
}

/**
 * 事件出网前的按连接本地化（`WsHub` 的 `localizeEvent` 注入点）。
 *
 * 事件是在产生的现场按缺省语言渲染的，而语言挂在连接上，所以出网前要把 `notice` 与
 * `question` 这两类载荷里的人话换成这条连接的语言；其余事件没有文案，原样返回。
 */
export type EventLocalizer = <E extends EventName>(
  event: E,
  payload: EventMap[E],
  language: Language,
) => EventMap[E];

/** 造上面那个本地化器（接线层把它注入 `WsHub` 的 `localizeEvent`） */
export function createEventLocalizer(): EventLocalizer {
  return <E extends EventName>(event: E, payload: EventMap[E], language: Language): EventMap[E] => {
    if (event === "notice") {
      const noticePayload = payload as unknown as EventMap["notice"];
      const notice = noticePayload.notice;
      const localized: EventMap["notice"] = {
        ...noticePayload,
        notice: { ...notice, text: relocalizeText(notice.text, language) },
      };
      return localized as unknown as EventMap[E];
    }
    if (event === "question") {
      const questionPayload = payload as unknown as EventMap["question"];
      const localized: EventMap["question"] = {
        ...questionPayload,
        question: relocalizeQuestion(questionPayload.question, language),
      };
      return localized as unknown as EventMap[E];
    }
    return payload;
  };
}

export class NoticeService {
  private readonly notices: NoticeRepository;
  private readonly emit?: ChatEventEmitter;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: NoticeServiceDeps) {
    this.notices = deps.notices;
    this.emit = deps.emit;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * 发一条通知（内部入口）。
   *
   * 落库 → 推 `notice` 事件 → 返回渲染好的视图。落库在推送之前：推送只对在线连接有意义
   * （D5：断线即作废），而库里的那条是重连之后还能看到的真相（L3）。
   */
  async create(input: NoticeCreateInput, language: Language = DEFAULT_LANGUAGE): Promise<NoticeView> {
    if (!(NOTICE_LEVELS as readonly string[]).includes(input.level)) {
      throw new HostError("invalid_params", {
        params: { field: "level" },
        detail: { field: "level", value: input.level, levels: NOTICE_LEVELS },
      });
    }
    if (!hasMessage(input.code)) {
      throw new HostError("invalid_params", {
        params: { field: "code" },
        detail: { field: "code", reason: "unknown_message_key", value: input.code },
      });
    }

    const durationMs = toDurationMs(input.duration, "duration");
    const params: Record<string, unknown> = { ...(input.params ?? {}) };

    const id = this.newId();
    const createdAt = this.now();
    const row: Notice = {
      id,
      level: input.level,
      code: input.code,
      params: Object.keys(params).length > 0 ? params : null,
      durationMs,
      conversationId: input.conversationId ?? null,
      createdAt,
    };
    await this.notices.create(row);

    const notification = toView(row, language);
    this.emit?.("notice", { notice: notification, at: iso(createdAt) });
    return notification;
  }

  /**
   * 日志上浮（PRD F-J2：warn / error 也要上通知栏）。
   *
   * 没有持续时间 = 永久：界面上的一闪而过不适合承载「宿主出了什么事」，
   * 这类通知要留到用户看过并手动清掉。
   */
  async log(
    level: Extract<NoticeLevel, "warning" | "error">,
    summary: string,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<NoticeView> {
    return await this.create(
      {
        level,
        code: level === "warning" ? "notice.logWarning" : "notice.logError",
        params: { summary },
        duration: null,
      },
      language,
    );
  }

  /**
   * 现在该显示的通知（PRD L3）。
   *
   * 先清掉已经到点的（`deleteExpired`），再按「永久 + 还没到点」读一遍：只按时间过滤而不清，
   * 表会一直涨；只清不按时间过滤，同一毫秒内到点的那条仍会被读出来。
   */
  async list(params: NoticeListParams = {}, language: Language = DEFAULT_LANGUAGE): Promise<NoticeListResult> {
    const now = this.now();
    await this.notices.deleteExpired(now);
    const active = await this.notices.listActive(now);

    const views = active
      .map((notice) => toView(notice, language))
      .filter((view) => (params.level === undefined ? true : view.level === params.level))
      .filter((view) =>
        params.conversationId === undefined ? true : view.conversationId === params.conversationId,
      );
    return { notices: views };
  }

  /**
   * 清掉一条（PRD L3：永久通知唯一能消失的方式）。
   *
   * 已经不存在时回 `dismissed: false`（这次有没有真的改动库），与 `notice.clear` 的口径一致。
   */
  async dismiss(params: NoticeDismissParams): Promise<NoticeDismissResult> {
    const id = typeof params.noticeId === "string" ? params.noticeId.trim() : "";
    if (id.length === 0) {
      throw new HostError("invalid_params", {
        params: { field: "noticeId" },
        detail: { field: "noticeId", reason: "empty" },
      });
    }
    const changes = await this.notices.clear(id);
    return { dismissed: changes > 0 };
  }

  /** 清掉一批（不给 `conversationId` 就清全部） */
  async clear(params: NoticeClearParams = {}): Promise<NoticeClearResult> {
    if (params.conversationId === undefined) {
      const cleared = await this.notices.clearAll();
      return { cleared };
    }
    const cleared = await this.notices.clearByConversation(params.conversationId);
    return { cleared };
  }
}
