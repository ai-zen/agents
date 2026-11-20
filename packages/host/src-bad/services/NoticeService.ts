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
 * 3. **存码不存句子**（D8 / PLAN §8）：库里存的是「码 + 参数」，读出时按**调用方
 *    给的语言**渲染。语言挂在连接上，一条通知存死一种语言、换个语言连回来就错了。
 *
 * 语气四档 `info | success | warning | error`（PRD 4.9）：信息 / 成功 / 警告 / 错误，
 * 「已保存」这种一秒提示归 `success` 并配一个很短的 duration；`warning` / `error` 同时是
 * 宿主日志上浮的通道（PRD F-J2）—— 但那一条链路在本文件之外：日志只出记录，
 * 「要不要变成通知」由接线处判（`app.ts` 的 `shouldNotifyFromLog`），本模块不认识日志。
 *
 * 语气取值只认 `NOTICE_LEVELS` 这一份（`wire/states.ts`）：`create()` 按它校验，不在这里另写
 * 一份白名单；读出时按列原样给 —— 那一列只有 `create()` 写，越不了档。
 */

import { randomUUID } from "node:crypto";

import type { LogSink } from "@ai-zen/agents-logger";

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
  NoticeOrigin,
  NoticeView,
} from "../wire/index.js";
import type { EventMap, EventName } from "../wire/events.js";
import type { LocalizedText, QuestionView } from "../wire/states.js";

/**
 * 库里那条 `code` 在文案字典里查不到时用的兜底键。
 *
 * `notices` 的行比写它的代码活得久 —— 永久通知（`duration: null`）落库之后一直躺着等人手动
 * 清，而文案键会随功能一起被删（`notice.*` 历史上就删过一批）。读的那一刻认不出这个码，
 * 用户至少能看到「有一条通知（{code}）」，而不是整个列表读崩或者这条静默消失。
 */
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
  /** 与哪段会话有关；不给表示全局通知 */
  sessionId?: string | null;
  /** 谁让它出现的；缺省 `app` */
  origin?: NoticeOrigin;
  /**
   * 要不要落库；缺省 `true`。
   *
   * `false` 只推给**当时在线**的连接：不入库、不重放，`notice.list` 里也看不到它。
   * 日志上浮的那批就是这种（一条日志不值得占一行库记录，更不该重启之后又弹一次）。
   */
  persist?: boolean;
}

export interface NoticeServiceDeps {
  notices: NoticeRepository;
  /** 推 `notice` 事件；不注入就不推（用例、或不需要在线推送的场合） */
  emit?: ChatEventEmitter;
  /**
   * 本模块自己那一格日志（接线处给的是 `withSource("notice")` 的那份）。
   *
   * 带给它是有原因的：这个来源写出去的东西**不转通知**，于是「通知失败 → 日志 → 通知」
   * 那个环绕不过来（判据在 `app.ts` 的 `shouldNotifyFromLog`）。
   */
  logger: LogSink;
  /** 时钟，测试注入用；缺省 `Date.now` */
  now?: () => number;
  /** 通知 id 的分配口，测试注入用；缺省 `crypto.randomUUID` */
  newId?: () => string;
}

/** 时间戳转 wire 上的 ISO 8601 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
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
    // 这一列只有 `create()` 写，而它在写之前已按 `NOTICE_LEVELS` 校过（不合法当场 `invalid_params`），
    // 所以库里的值越不了档 —— 读的时候不再判一次，也不准备「认不出来」的降级
    level: notice.level as NoticeLevel,
    duration: notice.durationMs === null ? null : notice.durationMs / 1000,
    text,
    sessionId: notice.sessionId,
    createdAt: iso(notice.createdAt),
    // 同理：只写 `log` / `app` 两档（`NoticeOrigin`），库里不会有第三种
    origin: notice.origin as NoticeOrigin,
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
  private readonly logger: LogSink;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: NoticeServiceDeps) {
    this.notices = deps.notices;
    this.emit = deps.emit;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * 发一条通知（内部入口）。
   *
   * 落库 → 推 `notice` 事件 → 返回渲染好的视图。落库在推送之前：推送只对在线连接有意义，
   * 而库里的那条是重连之后还能看到的真相（L3）。
   *
   * `persist: false` 那一档（日志上浮来的）跳过落库：它只属于**当时在线**的那些连接，
   * 不入库、不重放，`notice.list` 里也看不到 —— 为一条日志占一行库记录，代价是重启之后
   * 它又弹一次。
   */
  async create(
    input: NoticeCreateInput,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<NoticeView> {
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
      sessionId: input.sessionId ?? null,
      origin: input.origin ?? "app",
      createdAt,
    };
    if (input.persist ?? true) await this.notices.create(row);

    const notification = toView(row, language);
    this.emit?.("notice", { notice: notification, at: iso(createdAt) });
    return notification;
  }

  /**
   * 现在该显示的通知（PRD L3 / 4.9）。
   *
   * 先清掉已经到点的（`deleteExpired`），再按「永久 + 还没到点」读一遍：只按时间过滤而不清，
   * 表会一直涨；只清不按时间过滤，同一毫秒内到点的那条仍会被读出来。
   *
   * **按会话列 = 那一段的 + 全局的**：全局通知不属于任何会话，所以任何界面都得给
   * （PRD 4.9：「它不属于任何一段，所以任何界面都得给」）。只列那段自己的，用户就只在
   * 某一段会话里看得到「配置坏了」这类整机的事，换个会话又看不见了 —— 它凭什么叫全局。
   */
  async list(
    params: NoticeListParams = {},
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<NoticeListResult> {
    const now = this.now();
    await this.notices.deleteExpired(now);
    const active = await this.notices.listActive(now);

    const views = active
      .map((notice) => {
        // 库里那条码在文案字典里查不到：`toView` 会换成兜底那句，但那是屏上的一副面孔，
        // 查库的人得知道「这里有一条认不出的码」。这个来源（`notice`）写出去的记录不转通知，
        // 所以这一句不会把环绕回来。
        if (!hasMessage(notice.code)) {
          this.logger.warn("通知的文案码在字典里查不到，按兜底文案显示", {
            noticeId: notice.id,
            code: notice.code,
          });
        }
        return toView(notice, language);
      })
      .filter((view) => (params.level === undefined ? true : view.level === params.level))
      .filter((view) =>
        params.sessionId === undefined
          ? true
          : // 那一段的 + 全局的：`null` 是不属于任何会话的那些，哪儿都得看得见
            view.sessionId === params.sessionId || view.sessionId === null,
      );
    return { notices: views };
  }

  /**
   * 清掉一条（PRD L3：永久通知唯一能消失的方式）。
   *
   * `noticeId` 非空这一条由 `noticeDismissParams` 在 `WsHub` 那一处校过（reason 就是它报的
   * `empty`），这里只拿它清库。
   *
   * 已经不存在时回 `dismissed: false`（这次有没有真的改动库），与 `notice.clear` 的口径一致。
   */
  async dismiss(params: NoticeDismissParams): Promise<NoticeDismissResult> {
    const changes = await this.notices.clear(params.noticeId);
    return { dismissed: changes > 0 };
  }

  /**
   * 清掉一批（PRD 4.9 的三个粒度里的后两个）。
   *
   * - 给了 `sessionId`：**只清挂在那段会话上的**；
   * - 没给：清全部。
   *
   * 与 `list` 有意不同，别以为是漏改：列「那段会话的」要把全局的一起列出来（全局通知
   * 不属于任何会话，所以任何界面都得给），而清「那段会话的」只清真挂在那段上的 ——
   * 全局通知不属于那段，顺手把它清了就变成「清全部」了，而清全部必须由调用方明说。
   */
  async clear(params: NoticeClearParams = {}): Promise<NoticeClearResult> {
    if (params.sessionId === undefined) {
      const cleared = await this.notices.clearAll();
      return { cleared };
    }
    const cleared = await this.notices.clearBySession(params.sessionId);
    return { cleared };
  }
}
