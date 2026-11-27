/**
 * 失败：一个 `ClientError`，两处来源，一套判据。
 *
 * 宿主那一侧出网的是两个码。宿主把它的 `HostError` 折成 tRPC 的形状再出网
 * （`packages/host/src/modules/api/errors.ts`）：`data.hostCode` 是宿主自己的码（`not_found` /
 * `busy` / …，语义层），`data.code` 是 tRPC 的码（`NOT_FOUND` / `CONFLICT` / …，传输层），
 * `message` 是已按当前语言渲染好的句子，`data.details` 是结构化事实（`HostError.details` 原样带
 * 出）。
 *
 * 能分支的只有 {@link HostErrorCode}：那八个码里有两对落到同一个 tRPC 码上（`busy` 与 `conflict`
 * 都是 `CONFLICT`，`not_available` 与 `not_found` 都是 `NOT_FOUND`），而「这段会话还在跑，等它
 * 停下来」与「有人先动了一步」对调用方是两件事。`data.code` 仍然跟着出网（tRPC 自己的机制按它
 * 走），它是 {@link TRPCErrorCode} 那一套，只在没有 `hostCode` 时拿来还原，比如还没升级的宿主。
 *
 * 客户端自己造的错只有宿主不在场时才有：连不上、握手超时、本端关掉、读不了要上传的文件。这些
 * 处境宿主根本没有参与，没有它渲染好的句子可用，所以它们有自己的码与文案
 * （{@link LocalErrorCode}）。两套码不重名：大写下划线是宿主的 tRPC 码，小写下划线是本地的，
 * 一眼能看出这句话是谁说的。
 */

import { isTRPCClientError } from "@trpc/client";

/**
 * 宿主自己那八个码 —— 唯一可以分支的一套。
 *
 * 从 `data.hostCode` 上还原（`packages/host/src/modules/api/errors.ts` 把它写在那一格）。八个码
 * 描述的是八件不同的事，其中两对在 tRPC 那一套里是同一个码（`busy` 与 `conflict`、`not_found`
 * 与 `not_available`），所以「等一下再试」与「这段会话还在跑」这类判断只能认这一套。
 *
 * 认不出的码照样递出去（`code` 上是个字符串）：宿主加了新码而客户端还不认识时，那个码比丢掉它
 * 有用，调用方按已知的码分支，其余落进 `default` 即可。
 */
export type HostErrorCode =
  /** `not_found`：这段会话、这条消息、这份 Asset 不在 */
  | "not_found"
  /** `invalid_params`：世界没毛病，给的东西不对（只认自己说过的话、档位表里没有这个档……） */
  | "invalid_params"
  /** `conflict`：有人先动了一步（改名撞车、版本已经换过） */
  | "conflict"
  /** `busy`：这段会话还在跑，等它停下来 */
  | "busy"
  /** `unsupported`：这一版不做这件事 */
  | "unsupported"
  /** `config_invalid`：配置里缺一格或指向了不存在的东西（比如这个 AgentDefinition 没有可用模型） */
  | "config_invalid"
  /** `not_available`：这一版不存在（换个版本再挑） */
  | "not_available"
  /** `unauthorized`：握手帧里的令牌验不过，或某次调用要求凭证 */
  | "unauthorized";

/**
 * 没有 `hostCode` 时能还原出来的那一套：tRPC 自己的码。
 *
 * 它落在两处：还没升级的宿主（只写 `data.code`），以及 tRPC 在调用方这一侧自己造的错（入参在边界
 * 上被拒、传输层的失败）。有它总比丢掉一个现成的码强，只是这一套里 `busy` 与 `conflict` 分不开、
 * `not_found` 与 `not_available` 也分不开，要分就得等宿主升级。
 */
export type TRPCErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "NOT_IMPLEMENTED"
  | "PRECONDITION_FAILED"
  | "INTERNAL_SERVER_ERROR";

/**
 * 客户端自己产生的失败码。
 *
 * 与宿主的码（{@link HostErrorCode}）不重名：一眼能看出这句话是谁说的。
 */
export type LocalErrorCode =
  /** 地址不是合法 URL / scheme 不认识 */
  | "bad_address"
  /** 连不上这台宿主（socket 都没开成） */
  | "host_unavailable"
  /** 连上了，但限时内没调通任何一次调用（令牌不对、宿主还没起来都可能是它） */
  | "handshake_timeout"
  /** 连过之后连接断了（在飞调用随之失败） */
  | "connection_lost"
  /** 本端主动 `close()` 之后又用它 */
  | "closed"
  /** 客户端自己出了意外（不该发生的那一类；`detail.reason` 留着原始信息） */
  | "unexpected"
  /** 拉起了本地宿主，但到时限还没就绪 */
  | "host_did_not_start"
  /** 拉起的那个子进程自己退了（npx 装不上、入口起不来）；`reason` 是它最后一行输出 */
  | "host_launch_failed"
  /** 宿主以升级为理由退出之后，按 pin 重拉的那一次仍然以升级为理由退出 */
  | "host_upgrade_failed"
  /** 调用方取消了这次拉起（Ctrl+C 杀掉了那个子进程） */
  | "host_launch_cancelled"
  /** 既没给宿主入口，也没给该让 npx 拉的版本范围（本机拉起无从下手） */
  | "host_version_range_missing"
  /** 找不到要拉起的宿主入口（调用方没给 `hostEntry`，本机也没装那个私有包） */
  | "host_entry_missing"
  /** 读不了要上传的文件（不存在、没权限……） */
  | "asset_unreadable";

/** 全部失败码：宿主那八个码、没有 `hostCode` 时的 tRPC 码，或客户端本地的码 */
export type ClientErrorCode = HostErrorCode | TRPCErrorCode | LocalErrorCode;

/** 一份本地文案：模板里的 `{name}` 按 `params` 替换，缺参数时占位符原样留着 */
const LOCAL_TEXT: Record<LocalErrorCode, { zh: string; en: string }> = {
  bad_address: {
    zh: "不是合法的宿主地址：{endpoint}（要 ws:// 、wss:// 、http:// 或 https:// 开头的地址）",
    en: "Not a valid host address: {endpoint} (expected a ws://, wss://, http:// or https:// address)",
  },
  host_unavailable: {
    zh: "连不上宿主（{endpoint}）",
    en: "Could not reach the host ({endpoint})",
  },
  handshake_timeout: {
    zh: "与宿主（{endpoint}）握手超时：{timeoutMs} 毫秒内没有一次调用成功",
    en: "Timed out during the handshake with the host ({endpoint}): no call succeeded within {timeoutMs}ms",
  },
  connection_lost: {
    zh: "与宿主（{endpoint}）的连接断了",
    en: "The connection to the host ({endpoint}) was lost",
  },
  closed: {
    zh: "这条连接已经关掉了",
    en: "This connection has already been closed",
  },
  unexpected: {
    zh: "客户端出错：{reason}",
    en: "Client error: {reason}",
  },
  host_did_not_start: {
    zh: "本地宿主在 {timeoutMs} 毫秒内没有就绪（数据根 {dataRoot}，日志 {log}）",
    en: "The local host did not become ready within {timeoutMs}ms (data root {dataRoot}, log {log})",
  },
  host_entry_missing: {
    zh: "找不到要拉起的宿主入口：调用方没给 hostEntry，本机也没装 @ai-zen/agents-host",
    en: "No host entry to start: hostEntry was not given, and @ai-zen/agents-host is not installed here",
  },
  host_launch_failed: {
    zh: "拉起本机宿主失败：{reason}（日志 {log}）",
    en: "Could not start the local host: {reason} (log {log})",
  },
  host_upgrade_failed: {
    zh: "宿主升级之后没有进入服务：按 pin 重拉的那一次仍然以升级为理由退出（{reason}，日志 {log}）",
    en: "The host did not come up after the upgrade: the relaunch exited for an upgrade again ({reason}, log {log})",
  },
  host_launch_cancelled: {
    zh: "已取消：本机宿主没有拉起来",
    en: "Cancelled: the local host was not started",
  },
  host_version_range_missing: {
    zh: "不知道该拉哪一版宿主：既没给宿主入口（hostEntry），也没给版本范围（versionRange）",
    en: "Nothing says which host to start: neither hostEntry nor versionRange was given",
  },
  asset_unreadable: {
    zh: "读不了 {path}：{reason}",
    en: "Could not read {path}: {reason}",
  },
};

/**
 * 一次失败的完整描述。
 *
 * `message` 是可以直接展示的那句话：宿主回的错用它渲染好的文本，本地的错用上面那张表。调用方
 * 不需要（也不该）自己再拼一句。
 */
export class ClientError extends Error {
  /** 宿主那个码（{@link HostErrorCode}）、没有 `hostCode` 时的 tRPC 码，或本地码（{@link LocalErrorCode}） */
  readonly code: ClientErrorCode;
  /** 结构化事实：哪个字段不对、还差什么（形状由各码约定，不要解析句子去猜） */
  readonly detail?: unknown;
  /** 渲染 `message` 用到的参数 */
  readonly params: Record<string, unknown>;

  constructor(
    code: ClientErrorCode,
    message: string,
    options: { detail?: unknown; params?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ClientError";
    this.code = code;
    this.params = options.params ?? {};
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

/** 任意值是不是 `ClientError`（跨模块判实例用不到 `instanceof` 的场合） */
export function isClientError(value: unknown): value is ClientError {
  return value instanceof ClientError;
}

/**
 * 任意抛出物 → `ClientError`。这是「tRPC 的错 → 能分支的码」的唯一实现处。
 *
 * 三种来源，三种落法：
 *   · 宿主回的错：`data.hostCode` 是它自己的码（{@link HostErrorCode}），
 *     `message` 是它渲染好的那句，`data.details` 进 `detail`；
 *   · 客户端自己抛的（本端关掉、地址不合法……）：tRPC 把它包了一层，从 `cause` 里取回原物；
 *   · 其余（连接断了、没有回包）：tRPC 说的是传输层的事实，那句英文原样留着当 `message`，这里
 *     编一句中文只会把「谁说的」搅浑。
 */
export function fromTRPCError(error: unknown): ClientError {
  if (error instanceof ClientError) return error;

  if (isTRPCClientError(error)) {
    const hostError = hostErrorOf(error.data);
    if (hostError) {
      return new ClientError(hostError.code as HostErrorCode, error.message, {
        ...(hostError.details === undefined ? {} : { detail: hostError.details }),
      });
    }
    const cause: unknown = error.cause;
    if (cause instanceof ClientError) return cause;
    return new ClientError("connection_lost", error.message, {
      detail: { reason: error.message },
    });
  }

  const reason = error instanceof Error ? error.message : String(error);
  return localError("unexpected", { params: { reason }, detail: { reason } });
}

/**
 * 一条本地提醒：不拦流程，只让人看见。
 *
 * 与失败分开的理由：坏掉的升级 pin 只让「这一次拉哪一版」退回版本范围，拉起照旧进行。把它抛成
 * 错会让一次本来能成功的拉起直接失败，而把它吞掉则会让「升过的版本自己退回去了」永远没有解释。
 */
export interface LocalWarning {
  /** 提醒的种类 */
  code: LocalWarningCode;
  /** 可以直接展示的那句话（已按语言渲染） */
  message: string;
  /** 结构化事实：哪一份文件、坏在哪一格 */
  detail?: unknown;
}

/** 客户端自己产生的提醒码（只有它一条：目前没有第二件事需要「说出来但不拦」） */
export type LocalWarningCode = "version_pin_broken";

/** 提醒的模板，口径同 {@link LOCAL_TEXT} */
const LOCAL_WARNING_TEXT: Record<LocalWarningCode, { zh: string; en: string }> = {
  version_pin_broken: {
    zh: "升级 pin（{path}）读不懂，这次按版本范围拉起",
    en: "The upgrade pin ({path}) cannot be used; this launch falls back to the version range",
  },
};

/** 一条本地提醒：句子按语言从 {@link LOCAL_WARNING_TEXT} 取 */
export function localWarning(
  code: LocalWarningCode,
  options: { language?: string; params?: Record<string, unknown>; detail?: unknown } = {},
): LocalWarning {
  const params = options.params ?? {};
  const text = LOCAL_WARNING_TEXT[code];
  const template = usesChinese(options.language) ? text.zh : text.en;
  return {
    code,
    message: fill(template, params),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
  };
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

/**
 * 一个 tRPC 错误形状里宿主写进去的那个码与那几格。
 *
 * 两格都有时先看 `hostCode`、再看 `code`：前者是宿主自己的码（语义层，那八个），后者是 tRPC 的码
 * （传输层，没升级的宿主只写它）。这个优先级在类型上没法表达（两格在线上都是字符串），只写在
 * 下面那个 `??` 的次序里。两者都没有、或不是字符串时返回 `null`。
 *
 * `code` 在 tRPC 的类型里是个数字（它的数字码表），而宿主那一层故意把它换成了码的名字
 * （`NOT_FOUND` 这种，见它自己的错误格式化那一层）。两者对不上是那一步的本意，所以这里读的是运行
 * 期的字符串，不按类型走。
 */
function hostErrorOf(data: unknown): { code: string; details?: unknown } | null {
  if (data === null || typeof data !== "object") return null;
  const shape = data as { hostCode?: unknown; code?: unknown; details?: unknown };
  const code = named(shape.hostCode) ?? named(shape.code);
  if (code === null) return null;
  return shape.details === undefined ? { code } : { code, details: shape.details };
}

/** 线上那一格是不是一个非空的码名 */
function named(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 这条连接说的是不是中文（缺省英文） */
function usesChinese(language: string | undefined): boolean {
  return (language ?? "").trim().toLowerCase().startsWith("zh");
}

/** 把 `{name}` 换成 `params[name]`；缺的参数原样留着占位符（好过把 `undefined` 印到界面上） */
function fill(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
