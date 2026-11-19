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
 * 上下文超限错误。由 ContextGuardPlugin 在请求前**用来拼拒绝理由**。
 *
 * 注意：它现在不再被抛出。core 重写之后，钩子里的异常会穿到 `start()` 外面把整个循环
 * 打死（agent 变成僵尸），所以护栏改成「返回字符串 = 拒这一圈」（`onInnerLoopStart`），
 * 理由那句文案就来自这个类的 `message`。结构化字段（用量 / 阈值）**没有通道交出去**——
 * 拒绝理由只有字符串这一种形状；宿主若必须按数字渲染文案，需要 core 提供带结构载荷的
 * `denied`。
 *
 * 触发条件通常是上下文 token 用量超过硬线（如读入超大文件），
 * 继续会话已无意义且会持续放大费用/延迟，故由上层向用户显式报错。
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
