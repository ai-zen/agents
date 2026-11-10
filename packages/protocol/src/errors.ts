/**
 * 错误码表 —— 客户端据 `code` 分支的那批字面量，只在这里声明一次。
 *
 * ## 为什么它是协议的一部分
 *
 * 这些码会原样出现在 `{ ok: false, error: { code, message } }` 帧里，客户端靠它决定
 * 「是改请求（`bad-params` / `bad-index`）、还是重试（`turn-busy`）、还是换一段会话
 * （`session-missing` / `unknown-session`）」。既然它是**线上事实**，就不能散在各处的裸字符串：
 * 服务端写错一个字母，客户端的分支就永远不命中，而症状是「界面上什么反应都没有」。
 *
 * 曾经的状况正是这样：19 个码散成裸字符串、`codedError` 有六份逐字相同的拷贝，而
 * notice code 早就有表 —— 同一个问题一半有答案、一半没有。现在两边都只剩一份。
 *
 * ## 只增不改语义
 *
 * 一个码一旦发出去就是协议的一部分：改它的值等于让老客户端的 `switch` 落到 `default`。
 * 要换语义就新增一个码。
 *
 * ## 为什么 `CodedError` 是 `Error & { code }` 而不是一个类
 *
 * 抛错的是六个服务模块，它们各自 `throw`；用 `instanceof` 收口会让「不是本包造的错误」
 * 全被漏掉（例如 SDK 抛出来的、带同样 `code` 形状的错误）。判断靠 `isCodedError` 的结构
 * 检查，跨包、跨版本都成立。
 */

/** 线上错误码：值就是帧里 `error.code` 的字面量（`as const` 让每个值成为独立类型） */
export const ERROR_CODES = {
  /** 这个工作区没有可用的会话存档目录（`storeFor` 返回了空）——服务端装配出了问题 */
  noStore: "no-store",
  /** 工作区 id 不存在（盘上没有它的 `workspace.json`） */
  unknownWorkspace: "unknown-workspace",
  /** 这段会话正有一轮在跑，这个动作不能与它并发（改名 / 撤回 / 换 Agent …） */
  turnInFlight: "turn-in-flight",
  /** 会话 id 已经存在（`session.create` / `saveAs` 不静默顶掉） */
  sessionExists: "session-exists",
  /** 参数形状不对（客户端唯一需要区分的那一类：它得改请求，不是重试） */
  badParams: "bad-params",
  /** 会话不存在（既不在内存里、也不在存档里） */
  sessionMissing: "session-missing",
  /** 项目作用域的操作没有给 `workspaceId`（那不是「空清单」，是调用方漏了参数） */
  workspaceRequired: "workspace-required",
  /** 记录里的工作区路径在盘上不存在（`mv` / `rm` 过） */
  workspacePathMissing: "workspace-path-missing",
  /** 同一路径已经注册过另一个工作区 */
  workspaceExists: "workspace-exists",
  /** 会话 id 在内存里找不到活会话（多用于「它已经退场了」） */
  unknownSession: "unknown-session",
  /** 模型 id 在配置里不存在 */
  unknownModel: "unknown-model",
  /** Agent 定义不存在 */
  unknownAgent: "unknown-agent",
  /** 这一段会话已经有一轮在跑（`session.send` 等入口的并发拦截） */
  turnBusy: "turn-busy",
  /** 子 Agent 不在这段会话的这一轮里（轮末会丢弃它们） */
  subAgentMissing: "sub-agent-missing",
  /** 还没有用户消息，交接没有内容可写 */
  nothingToHandoff: "nothing-to-handoff",
  /** 这台服务端没有配置交接能力（缺 `handoff` 依赖） */
  noHandoff: "no-handoff",
  /** 交接正在进行中，这个动作不能插进去 */
  handoffInFlight: "handoff-in-flight",
  /** 交接被中止（用户取消 / 会话退场） */
  handoffAborted: "handoff-aborted",
  /** 消息下标越界（`session.rollback` 不静默截断） */
  badIndex: "bad-index",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 带机器可判别 `code` 的错误 —— 帧层原样把 `code` 递给客户端 */
export interface CodedError extends Error {
  code: ErrorCode;
}

/**
 * 造一个带码的错误。
 *
 * 不用 `class`：六个服务模块各自 `throw`，而跨包/跨版本时 `instanceof` 会漏（同一个码
 * 可能由别的实现抛出）。形状统一就够了，见文件头最后一段。
 */
export function codedError(code: ErrorCode, message: string): CodedError {
  // `Object.assign` 直接把 `code` 挂上去，返回值天然是 `Error & { code }`：
  // 不用 `as` 断言（`Error` 上本来没有 `code`，硬断不过类型检查），也不改错误原型。
  return Object.assign(new Error(message), { code });
}

/** `value` 是不是一个带已知错误码的错误（跨包边界也成立，不看原型链） */
export function isCodedError(value: unknown): value is CodedError {
  if (!(value instanceof Error)) return false;
  const code = (value as Error & { code?: unknown }).code;
  return typeof code === "string" && isErrorCode(code);
}

/**
 * 取错误码；不是本表里的码就返回 `undefined`。
 *
 * 契约的读端：客户端拿到一个错误之后**唯一的**判断入口（而不是自己去摸 `.code` 再转字面量）。
 */
export function codeOf(value: unknown): ErrorCode | undefined {
  return isCodedError(value) ? value.code : undefined;
}

/** 运行时判定一个字面量是不是本表的码（`ERROR_CODES` 的值的集合） */
const ERROR_CODE_SET = new Set<string>(Object.values(ERROR_CODES));

function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODE_SET.has(value);
}
