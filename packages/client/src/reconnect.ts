/**
 * 重连的**策略**：重试几次、等多久、哪些失败不值得重试。
 *
 * ## 分工
 *
 * 「怎么重连」是连接层的事（`HostClient.reconnect()`：把手上那条 socket 掐掉，再等到一次调用
 * 调通），「要不要一直重试」是**调用方**的事 —— 不同前端对「试到什么时候」的答案不一样，包内
 * 不预设「失败三次就放弃」那种数（那是产品判断，不是传输事实）。
 *
 * 所以这个文件的默认策略是「**一直重试**」（{@link DEFAULT_RECONNECT_POLICY}：
 * `maxAttempts: Infinity`），调用方要给上限就传一个有限的数字。
 *
 * ## 哪些失败不值得重试
 *
 * 传输层的失败（连不上、断了、握手超时）重试有意义；**被宿主拒**（`unauthorized` / `invalid_params`，
 * 以及还没升级的宿主说的 `UNAUTHORIZED` / `BAD_REQUEST`）与**地址不合法**重试一万次也是同一个结果，
 * 无限重试只会把一条该上屏的错误藏进一个转圈的界面里。判据在 {@link isRetryableByDefault}，按码
 * 而不是按错误文本 —— 文本会变，码是契约。
 */

import { ClientError } from "./errors.js";

/** 重连的节奏与上限 */
export interface ReconnectPolicy {
  /** 最多试几次；`Number.POSITIVE_INFINITY` = 一直试（缺省，放弃与否由调用方决定） */
  maxAttempts: number;
  /** 第一次重试前等多久 */
  initialDelayMs: number;
  /** 退避的上限（等这么久之后不再按倍数涨） */
  maxDelayMs: number;
  /** 每次失败后的倍数 */
  factor: number;
  /** 这个失败要不要重试；缺省 {@link isRetryableByDefault} */
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * 缺省策略：**一直重试**，从 250ms 起按 2 倍退避、封顶 10 秒。
 *
 * 封顶那 10 秒是「别把断线的会话变成一台空转的机器」：桌面端可能挂一整天，无限退避会让下一次
 * 重试落到几小时之后，于是宿主早就回来了而界面还停在「重连中」。
 */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  maxAttempts: Number.POSITIVE_INFINITY,
  initialDelayMs: 250,
  maxDelayMs: 10_000,
  factor: 2,
};

/** 只有 `reconnect()` 这一件事是重连需要的（`HostClient` 满足它；用例也可以给一个假的） */
export interface Reconnectable {
  reconnect(): Promise<void>;
}

/** 一次失败之后要不要再试 */
export interface ReconnectAttempt {
  /** 第几次尝试（从 1 开始） */
  attempt: number;
  error: unknown;
  /** 这次之后等多久再试 */
  delayMs: number;
}

/** `reconnectUntilConnected` 的可注入项（等一等与「记一笔失败」） */
export interface ReconnectOptions {
  policy?: ReconnectPolicy;
  /** 等待；注入出来是为了让用例不必真等 */
  sleep?: (ms: number) => Promise<void>;
  /** 每次失败后调一次（调用方在这里把「第几次、为什么、多久后再试」显示出来） */
  onAttemptFailed?: (attempt: ReconnectAttempt) => void;
}

/**
 * 反复 `reconnect()` 直到连上（断线之后补什么由调用方决定：宿主有 `session.open`，一次取全）。
 *
 * 抛出的错误是**最后一次失败的那个**：调用方要显示的就是它（宿主的话术已经按连接语言渲染
 * 好了，本地那些也有文案）。不重试的失败当场抛出，不等满次数。
 */
export async function reconnectUntilConnected(
  target: Reconnectable,
  options: ReconnectOptions = {},
): Promise<void> {
  const policy = options.policy ?? DEFAULT_RECONNECT_POLICY;
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = policy.shouldRetry ?? isRetryableByDefault;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await target.reconnect();
      return;
    } catch (error) {
      if (!shouldRetry(error)) throw error;
      // 试满就放弃：`maxAttempts` 是「最多试几次」，`Infinity` 时这一支永远不成立
      if (attempt >= policy.maxAttempts) throw error;
      const delayMs = retryDelay(policy, attempt);
      options.onAttemptFailed?.({ attempt, error, delayMs });
      await sleep(delayMs);
    }
  }
}

/**
 * 第 `attempt` 次失败之后该等多久：`initialDelayMs * factor^(attempt-1)`，封顶 `maxDelayMs`。
 *
 * 单独导出是为了让「退避算得对不对」不必靠真等来测。
 */
export function retryDelay(policy: ReconnectPolicy, attempt: number): number {
  const steps = Math.max(0, attempt - 1);
  const delay = policy.initialDelayMs * Math.pow(policy.factor, steps);
  return Math.min(Math.max(policy.initialDelayMs, delay), policy.maxDelayMs);
}

/**
 * 缺省的可重试判据：按码判（不解析错误文本）。
 *
 * 被宿主拒的、地址错的、本端已经关掉的、找不到宿主入口的，都不重试；其余（连不上、断了、
 * 握手超时、拉起失败）都算「现在不行、等会儿可能行」。
 */
export function isRetryableByDefault(error: unknown): boolean {
  if (!(error instanceof ClientError)) return true;
  switch (error.code) {
    // 宿主的码，与还没升级的宿主说的 tRPC 码：同一件事的两种说法，都不重试
    case "unauthorized":
    case "UNAUTHORIZED":
    case "invalid_params":
    case "BAD_REQUEST":
    case "bad_address":
    case "closed":
    case "host_entry_missing":
      return false;
    default:
      return true;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
