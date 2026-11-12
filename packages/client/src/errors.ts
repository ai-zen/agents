/**
 * 错误：一个 `ClientError`，两处来源，一套判据。
 *
 * ## 服务端回的错：一个字都不改写
 *
 * 错误帧里 `error.data` 携带三样东西（`packages/server/src/wire/errors.ts`）：
 * `code`（稳定业务码）、`message`（**已按这条连接的语言渲染好的人话**）、`detail`（结构化事实）。
 * 本文件把它们原样搬进 `ClientError`：`message` 可以直接上屏，`code` 用来分支，`detail` 用来做
 * 「该往哪个输入框填什么」这类动作。
 *
 * 客户端**不另写一份业务码 → 文案的表**，理由不是省事：那样同一句失败会有两种说法，而服务端
 * 那一份是按用户当前语言渲染的、客户端那一份不是 —— 于是换个语言连回来，一部分错误换了语言、
 * 另一部分没换。文案归服务端（PRD D8），这里只做搬运。
 *
 * ## 客户端自己造的错：只有服务端不在场时才有
 *
 * 连不上、握手超时、连接断了、拉起服务端失败 —— 这些处境服务端根本没法参与，没有 `data.message`
 * 可用，所以它们有自己的码与文案（{@link LocalErrorCode}）。这几句是全包里唯一由客户端产出的
 * 用户可见文本，收在一张表里，按语言取（缺省英文，与 D8 / R58 的口径一致）。
 */

import type { BizCode } from "@ai-zen/agents-server";

/**
 * 客户端自己产生的失败码。
 *
 * 与服务端业务码（`BizCode`）不重名：一眼能看出这句话是谁说的、要不要按「改输入」去处理。
 */
export type LocalErrorCode =
  /** 地址不是合法 URL / scheme 不认识 */
  | "bad_address"
  /** 还没握手成功就想发方法（服务端也会拒，这里在本地就挡住） */
  | "not_connected"
  /** 连接断了（在飞调用随之失败） */
  | "connection_lost"
  /** 本端主动 `close()` 之后又用它 */
  | "closed"
  /** 握手没在建连时限内完成 */
  | "handshake_timeout"
  /** 一次调用等超时了（服务端可能还在做，也可能已经不在了） */
  | "call_timeout"
  /** 客户端自己出了意外（不该发生的那一类；`detail.reason` 留着原始信息） */
  | "unexpected"
  /** 连不上这台服务端（含「显式地址那条路绝不拉起」时的连接被拒） */
  | "server_unavailable"
  /** 拉起了本地服务端，但到时限还没就绪 */
  | "server_did_not_start"
  /** 找不到要拉起的服务端入口（宿主没给 `serverEntry`，也没装那个私有包） */
  | "server_entry_missing"
  /** 单个附件超过上限（PRD D5：20MB/张；在 `asset.begin` 之前就拒） */
  | "asset_too_large"
  /** 一条消息的附件数超过上限（PRD D5：4 张/条；多出来的不静默丢，逐张给这个码） */
  | "asset_count_exceeded"
  /** 空文件（0 字节）没有可上传的内容 */
  | "asset_empty"
  /** 读不了要上传的文件（不存在、没权限……） */
  | "asset_unreadable"
  /** 认不出这个文件的类型，且调用方没给 mime */
  | "asset_mime_unknown";

/** 全部失败码：服务端的业务码，或客户端本地的码 */
export type ClientErrorCode = BizCode | LocalErrorCode;

/** 一份本地文案：`params` 里会被替换的只有 `{endpoint}` / `{dataRoot}` / `{log}` */
const LOCAL_TEXT: Record<LocalErrorCode, { zh: string; en: string }> = {
  bad_address: {
    zh: "不是合法的服务端地址：{endpoint}（要 ws:// 、wss:// 、http:// 或 https:// 开头的地址）",
    en: "Not a valid server address: {endpoint} (expected a ws://, wss://, http:// or https:// address)",
  },
  not_connected: {
    zh: "还没和服务端握手成功，这条连接不能发 {method}",
    en: "The connection has not finished its handshake, so {method} cannot be sent yet",
  },
  connection_lost: {
    zh: "与服务端（{endpoint}）的连接断了",
    en: "The connection to the server ({endpoint}) was lost",
  },
  closed: {
    zh: "这条连接已经关掉了",
    en: "This connection has already been closed",
  },
  handshake_timeout: {
    zh: "与服务端（{endpoint}）握手超时",
    en: "Timed out during the handshake with the server ({endpoint})",
  },
  call_timeout: {
    zh: "调用 {method} 超过 {timeoutMs} 毫秒没有回应",
    en: "{method} got no response within {timeoutMs}ms",
  },
  unexpected: {
    zh: "客户端出错：{reason}",
    en: "Client error: {reason}",
  },
  server_unavailable: {
    zh: "连不上服务端（{endpoint}）",
    en: "Could not reach the server ({endpoint})",
  },
  server_did_not_start: {
    zh: "本地服务端在 {timeoutMs} 毫秒内没有就绪（数据根 {dataRoot}，日志 {log}）",
    en: "The local server did not become ready within {timeoutMs}ms (data root {dataRoot}, log {log})",
  },
  server_entry_missing: {
    zh: "找不到要拉起的服务端入口：请让宿主给出 serverEntry，或确认已装 @ai-zen/agents-server",
    en: "No server entry to start: pass serverEntry from the host, or make sure @ai-zen/agents-server is installed",
  },
  asset_too_large: {
    zh: "图片太大（{size}），超过单张 {limit} 的上限",
    en: "The image is too large ({size}); the limit is {limit} per file",
  },
  asset_count_exceeded: {
    zh: "一条消息最多 {limit} 张图片",
    en: "A message can carry at most {limit} images",
  },
  asset_empty: {
    zh: "{name} 是空文件（0 字节），没有可上传的内容",
    en: "{name} is empty (0 bytes): there is nothing to upload",
  },
  asset_unreadable: {
    zh: "读不了 {path}：{reason}",
    en: "Could not read {path}: {reason}",
  },
  asset_mime_unknown: {
    zh: "认不出 {name} 的类型（请显式给出 mime）",
    en: "Cannot tell the type of {name} (pass an explicit mime)",
  },
};

/**
 * 一次失败的完整描述。
 *
 * `message` 是**可以直接展示的那句话** —— 服务端回的错用它渲染好的文本，本地的错用上面那张表。
 * 调用方不需要（也不该）自己再拼一句。
 */
export class ClientError extends Error {
  /** 服务端业务码，或本地码（见 {@link LocalErrorCode}） */
  readonly code: ClientErrorCode;
  /** 结构化事实：哪个字段不对、还差什么（形状由各码约定，不要解析句子去猜） */
  readonly detail?: unknown;
  /** 渲染 `message` 用到的参数 */
  readonly params: Record<string, unknown>;
  /** JSON-RPC 数字码：只有服务端回的错才有（数字码只做粗分类，判伪看 `code`） */
  readonly rpcCode?: number;

  constructor(
    code: ClientErrorCode,
    message: string,
    options: { detail?: unknown; params?: Record<string, unknown>; rpcCode?: number } = {},
  ) {
    super(message);
    this.name = "ClientError";
    this.code = code;
    this.params = options.params ?? {};
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.rpcCode !== undefined) this.rpcCode = options.rpcCode;
  }

  /** 这句失败是不是服务端说的（有服务端渲染好的文案与业务码） */
  get fromServer(): boolean {
    return this.rpcCode !== undefined;
  }
}

/** 任意值是不是 `ClientError`（跨模块判实例用不到 `instanceof` 的场合） */
export function isClientError(value: unknown): value is ClientError {
  return value instanceof ClientError;
}

/**
 * 服务端错误帧 → `ClientError`。
 *
 * 三样原样搬：`data.code` → `code`、`data.message` → `message`、`data.detail` → `detail`。
 * `data` 缺字段时按 `internal` 兜底（与接线层的解析同口径），而不是让「半截错误」变成一条空消息。
 *
 * 认不出来的业务码**照样递出去**：服务端加了新码而客户端还不认识时，未知的码比丢掉的码有用。
 * 调用方按已知的码分支、其余落进 `default` 即可 —— 这里不维护第二份码表。
 */
export function fromServerError(error: {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}): ClientError {
  const data = (typeof error.data === "object" && error.data !== null ? error.data : {}) as Record<
    string,
    unknown
  >;
  const code = typeof data.code === "string" && data.code !== "" ? data.code : "internal";
  const message =
    typeof data.message === "string" && data.message !== ""
      ? data.message
      : typeof error.message === "string"
        ? error.message
        : "";
  const detail = data.detail;
  return new ClientError(code as ClientErrorCode, message, {
    params:
      typeof data.params === "object" && data.params !== null
        ? (data.params as Record<string, unknown>)
        : {},
    ...(detail !== undefined ? { detail } : {}),
    ...(typeof error.code === "number" ? { rpcCode: error.code } : {}),
  });
}

/** 一条本地失败：句子按语言从 {@link LOCAL_TEXT} 取 */
export function localError(
  code: LocalErrorCode,
  options: { language?: string; params?: Record<string, unknown>; detail?: unknown } = {},
): ClientError {
  const params = options.params ?? {};
  const text = LOCAL_TEXT[code];
  const template = usesChinese(options.language) ? text.zh : text.en;
  return new ClientError(code, fill(template, params), {
    params,
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
  });
}

/** 地址不合法（`parseAddress` 的出口） */
export function badAddress(input: string): ClientError {
  return localError("bad_address", { params: { endpoint: JSON.stringify(input) } });
}

/** 这条连接说的是不是中文（缺省英文，与 D8 / R58 一致） */
function usesChinese(language: string | undefined): boolean {
  return (language ?? "").trim().toLowerCase().startsWith("zh");
}

/** 把 `{name}` 换成 `params[name]`；缺的参数原样留着占位符（好过把 `undefined` 印到界面上） */
function fill(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
