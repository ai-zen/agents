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
