/**
 * SDK 统一错误模型。
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
 * 上下文超限错误。由 ContextGuardPlugin 在请求前抛出，用于中断对话。
 * 触发条件通常是上下文 token 用量超过硬线（如读入超大文件），
 * 继续对话已无意义且会持续放大费用/延迟，故由上层捕获后向用户显式报错。
 */
export class ContextOverflowError extends Error {
  /** 触发中断时的刚用量（usage.prompt_tokens） */
  public readonly promptTokens: number;
  /** 被越过的强行阻断阈值（`tokenThresholds.guard`，绝对值） */
  public readonly guardTokens: number;

  constructor(promptTokens: number, guardTokens: number) {
    super(
      `🛑 Context critically over the limit: ${promptTokens} tokens used, above the blocking threshold of ${guardTokens}.` +
        ` The conversation may have run away after reading an oversized file, so it has been interrupted — please inspect and start over.` +
        ` (If you really need a longer context, raise tokenThresholds.guard for this model in config.json.)`,
    );
    this.name = "ContextOverflowError";
    this.promptTokens = promptTokens;
    this.guardTokens = guardTokens;
  }
}
