import {
  DEFAULT_LANGUAGE,
  render,
  type Language,
  type MessageKey,
} from "../i18n/index.js";

/**
 * 业务码与错误类。
 *
 * 分工（PLAN §6）：JSON-RPC 的 `error.code` 是数字（协议层），`error.data` 里才是
 * 产品要用的三样东西 ——
 *   - `data.code`：**稳定业务码**，小写下划线，客户端据此分支（换文案不该改它）；
 *   - `data.message`：已按连接语言渲染好的人话（PRD D8：宿主自己做多语言）；
 *   - `data.detail` / `data.params`：结构化事实与渲染参数，让客户端不必解析句子去猜原因。
 *
 * 业务码本身只增不改语义：一个码的含义一旦发出去，客户端就可能已经按它写了分支。
 */

/**
 * 稳定业务码。命名小写下划线，客户端按它分支。
 *
 * 逐条对应的用户可见处境（文案见 `i18n/en.ts` 的 `error.*`）：
 */
export type BizCode =
  /** 凭证没被接受（含未 `hello` 就发别的请求） */
  | "unauthorized"
  /** 参数形状 / 取值不对（含帧解析失败的字段级原因） */
  | "invalid_params"
  /** 目标对象不存在（对话、消息、问题、附件……） */
  | "not_found"
  /**
   * 此刻不能动这段对话的记忆 —— 它正忙着。
   *
   * 判据是**现读 agent 那一格**（忙 / 闲 / 暂停），不是「宿主记着有人在跑」：忙的时候记忆
   * 不许从外面改（撤回、编辑、换记忆这类动作），要影响它只能投递。投递本身**不看**这一格 ——
   * 忙也照收（PRD 4.1 / PLAN §5.1）。
   */
  | "busy"
  /**
   * 目标对话存在，但它现在没有驱动者（死的）—— 外部来源不能唤醒死者，只有界面上的发送按钮
   * 能先复活再投（PRD 1.2）。
   *
   * 与 `busy` 同档：两者说的都是「这段对话此刻不接这一手」，区别只在那一格是忙还是死。
   */
  | "session_dead"
  /** 上传或请求体超限（PRD D5：图片 20MB/张） */
  | "payload_too_large"
  /** 协议里我们不用的那部分，或某个能力在本宿主不提供（PLAN A4） */
  | "unsupported"
  /** 宿主内部错误，细节只在日志里 */
  | "internal"
  /** 配置读得出来但用不了（PRD F-A8：结构化原因，能当场修） */
  | "config_invalid"
  /** MCP 服务器连不上或没响应（PRD F-G1） */
  | "mcp_unavailable"
  /** 目标模型不具备所需能力，例如读不了历史里的图片（PRD D20 / F-B8） */
  | "model_unsupported"
  /** 用户选择了不交接（PRD F-D2 的三个选项之一 / F-D7 取消不等于失败） */
  | "handoff_declined"
  /** 还有问题挂着没答，且它在挡着这段对话（PRD D22 / D23 / F-D10） */
  | "question_pending"
  /** 上下文到了硬线，本轮不再发出请求（PRD F-D1 / D23） */
  | "context_guard";

/** 全部业务码；用于校验与测试遍历 */
export const BIZ_CODES: readonly BizCode[] = [
  "unauthorized",
  "invalid_params",
  "not_found",
  "busy",
  "session_dead",
  "payload_too_large",
  "unsupported",
  "internal",
  "config_invalid",
  "mcp_unavailable",
  "model_unsupported",
  "handoff_declined",
  "question_pending",
  "context_guard",
];

/** 业务码 → 默认文案键（`HostError` 不指定 `messageKey` 时用它） */
const DEFAULT_MESSAGE_KEY: Record<BizCode, MessageKey> = {
  unauthorized: "error.unauthorized",
  invalid_params: "error.invalidParams",
  not_found: "error.notFound",
  busy: "error.busy",
  session_dead: "error.sessionDead",
  payload_too_large: "error.payloadTooLarge",
  unsupported: "error.unsupported",
  internal: "error.internal",
  config_invalid: "error.configInvalid",
  mcp_unavailable: "error.mcpUnavailable",
  model_unsupported: "error.modelUnsupported",
  handoff_declined: "error.handoffDeclined",
  question_pending: "error.questionPending",
  context_guard: "error.contextGuard",
};

/**
 * 业务码 → JSON-RPC 数字码。
 *
 * 标准里只有少数几个数字码有意义（-32700 解析、-32600 非法请求、-32601 无此方法、
 * -32602 参数、-32603 内部）；产品层面的处境统一落在 `-32000 .. -32099` 这段
 * 「实现自定义」区间，真伪以 `data.code` 为准（PLAN A4：不按标准的错误码空间走）。
 */
const JSON_RPC_CODE: Record<BizCode, number> = {
  invalid_params: -32602,
  internal: -32603,
  unauthorized: -32001,
  not_found: -32004,
  busy: -32005,
  payload_too_large: -32006,
  unsupported: -32601,
  config_invalid: -32008,
  mcp_unavailable: -32009,
  model_unsupported: -32010,
  handoff_declined: -32011,
  question_pending: -32012,
  context_guard: -32013,
  session_dead: -32014,
};

/** 业务码对应的 JSON-RPC 数字码 */
export function jsonRpcCode(code: BizCode): number {
  return JSON_RPC_CODE[code];
}

/** 业务码对应的默认文案键 */
export function defaultMessageKey(code: BizCode): MessageKey {
  return DEFAULT_MESSAGE_KEY[code];
}

/** 运行时判断一个值是不是已知业务码 */
export function isBizCode(value: unknown): value is BizCode {
  return typeof value === "string" && (BIZ_CODES as readonly string[]).includes(value);
}

/**
 * 错误帧里 `error.data` 的形状。
 *
 * 客户端读 `code` 分支、显示 `message`、按 `detail` 做「该往哪个输入框填什么」这类动作。
 */
export interface ErrorData {
  /** 稳定业务码 */
  code: BizCode;
  /** 已按连接语言渲染的人话 */
  message: string;
  /** 结构化事实：哪个字段不对、还差什么（形状由各码约定，客户端不解析句子） */
  detail?: unknown;
  /** 渲染 `message` 用到的参数，客户端如需自己重排文案可直接用 */
  params: Record<string, unknown>;
}

/** 构造 `HostError` 的可选项 */
export interface HostErrorOptions {
  /** 文案键；缺省按 `code` 取（见 `defaultMessageKey`） */
  messageKey?: MessageKey;
  /** 渲染参数（`{name}` 形式占位） */
  params?: Record<string, unknown>;
  /** 结构化事实 */
  detail?: unknown;
  /** 原始错误，留给日志 */
  cause?: unknown;
}

/**
 * 宿主抛给接线的错误：带业务码、文案键与渲染参数，出网时按连接语言渲染。
 *
 * 业务层只管用码与参数描述「哪里不对」，不拼句子、不碰语言 —— 语言是连接的事。
 */
export class HostError extends Error {
  readonly code: BizCode;
  readonly messageKey: MessageKey;
  readonly params?: Record<string, unknown>;
  readonly detail?: unknown;

  constructor(code: BizCode, options: HostErrorOptions = {}) {
    const messageKey = options.messageKey ?? defaultMessageKey(code);
    // `Error.message` 只给日志和调试看：固定用默认语言渲染一份，免得日志里出现空消息
    super(render(DEFAULT_LANGUAGE, messageKey, options.params));
    this.name = "HostError";
    this.code = code;
    this.messageKey = messageKey;
    this.params = options.params;
    this.detail = options.detail;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  /** 渲染成错误帧里的 `data`（PRD D8：按连接语言出人话） */
  toErrorData(language: Language = DEFAULT_LANGUAGE): ErrorData {
    const params = this.params ?? {};
    const data: ErrorData = {
      code: this.code,
      message: render(language, this.messageKey, params),
      params,
    };
    if (this.detail !== undefined) {
      data.detail = this.detail;
    }
    return data;
  }

  /** 换一条更适合当前上下文的文案键（例如带上具体实体名），返回新实例 */
  withMessage(messageKey: MessageKey, params?: Record<string, unknown>): HostError {
    return new HostError(this.code, {
      messageKey,
      params: params ?? this.params,
      detail: this.detail,
      cause: this.cause,
    });
  }

  /** 追加结构化事实后返回新实例 */
  withDetail(detail: unknown): HostError {
    return new HostError(this.code, {
      messageKey: this.messageKey,
      params: this.params,
      detail,
      cause: this.cause,
    });
  }

  /** 判断任意值是不是 `HostError`（跨模块实例判断用不到 `instanceof` 的场合） */
  static is(value: unknown): value is HostError {
    return value instanceof HostError;
  }
}

/**
 * 把任意抛出物收敛成 `ErrorData`。
 *
 * 接线层只会写一次 `catch`，其它错误（`TypeError`、SDK 抛的、字符串）都在这里被兜成
 * `internal`，原始信息进 `detail.reason` 供排查 —— 于是界面上是一句人话，而不是一堆堆栈。
 */
export function toErrorData(error: unknown, language: Language = DEFAULT_LANGUAGE): ErrorData {
  if (HostError.is(error)) return error.toErrorData(language);
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: "internal",
    message: render(language, "error.internal"),
    params: {},
    detail: { reason },
  };
}
