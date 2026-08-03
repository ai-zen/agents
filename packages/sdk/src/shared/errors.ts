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
 * 触发条件通常是上下文 token 用量远超阈值（如读入超大文件），
 * 继续对话已无意义且会持续放大费用/延迟，故由上层捕获后向用户显式报错。
 */
export class ContextOverflowError extends Error {
  /** 触发中断时的刚用量（usage.prompt_tokens） */
  public readonly promptTokens: number;
  /** 配置的告警阈值（maxTokens） */
  public readonly maxTokens: number;
  /** 实际生效的硬上限（maxTokens × ratio，越界即中断） */
  public readonly threshold: number;
  /** 超出比例（如 1.2 表示 20%） */
  public readonly ratio: number;

  constructor(
    promptTokens: number,
    maxTokens: number,
    ratio: number,
  ) {
    const threshold = maxTokens * ratio;
    super(
      `🛑 上下文严重超限：已用 ${promptTokens} token，超过硬上限 ${threshold}（${Math.round((ratio - 1) * 100)}%，配置上限 ${maxTokens}）。` +
        `当前对话可能因读入超大文件而失控，已中断，请检查并重新开始。`,
    );
    this.name = "ContextOverflowError";
    this.promptTokens = promptTokens;
    this.maxTokens = maxTokens;
    this.threshold = threshold;
    this.ratio = ratio;
  }
}
