/**
 * code 为机器可读错误码（如 "CONFIG_READ_FAILED"），message 为人可读描述。
 */
export class SdkError extends Error {
  public readonly code: string;

  constructor(code: string, message: string, cause?: Error) {
    super(message);
    this.name = "SdkError";
    this.code = code;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * 上下文超限错误。由 ContextGuardPlugin 在请求前用来拼拒绝理由（返回它的 `message`）。
 *
 * 它自己不被抛出：钩子里抛错会穿到 `start()` 外面终止整个循环（agent 不再推进），所以
 * 护栏改成「返回字符串 = 拒这一次请求」（`onInnerLoopStart`）。拒绝理由只有字符串这一种
 * 形状，用量 / 阈值这两个字段便于就地拼文案。
 *
 * 触发条件通常是上下文 token 用量超过硬线（如读入超大文件），
 * 继续会话已无意义且会持续放大费用/延迟。
 */
export class ContextOverflowError extends Error {
  /** 触发拦截时的用量（usage.prompt_tokens） */
  public readonly promptTokens: number;
  /** 被越过的强行阻断阈值（`tokenThresholds.guard`，绝对值） */
  public readonly guardTokens: number;

  constructor(promptTokens: number, guardTokens: number) {
    super(
      `🛑 Context critically over the limit: ${promptTokens} tokens used, above the blocking threshold of ${guardTokens}.` +
        ` The session may have run away after reading an oversized file, so it has been interrupted — please inspect and start over.` +
        ` (If you really need a longer context, raise tokenThresholds.guard for this model in config.json.)`,
    );
    this.name = "ContextOverflowError";
    this.promptTokens = promptTokens;
    this.guardTokens = guardTokens;
  }
}
