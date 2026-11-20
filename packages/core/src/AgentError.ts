/**
 * core 往外给的错误。四个码，每一个都在描述**世界**里发生了什么（逐条见下面的联合）。
 *
 * 后两个的区别是调用方唯一需要分的那一刀：**等一等再投**（`input_paused`）与**改投别处**
 *（`closed`）。压成一个码的话，投递方只能拿「再试一次」去撞一个永远不会再收的队列。
 *
 * ## 一个类、一个实例、两个地方用
 *
 * `failed` 事件的载荷，和那条消息的 `error` 字段，是**同一个实例**。不另造一个形状 ——
 * 否则「事件里看到的」和「消息上存的」迟早会漂成两份。
 *
 * ## 为什么不归厂商语义
 *
 * core 只归自己知道的那个维度（错在哪一段）。可否重试、401 是不是「密钥错了」、
 * 该不该退避 —— 三样都是产品策略，一旦写进来，core 就得懂网络、懂厂商、懂幂等。
 *
 * ## 什么不走这个类
 *
 * 「在活着的 agent 上调 `runOnce()`」「`runOnce()` 时没有燃料」这类**写错代码**，
 * 直接抛裸 `Error`。这几个码是给「会挂到 `message.error`、会落库、读回来要能
 * `instanceof` 重建」的错误用的；笔误不配有这套要被序列化的形状。
 */
export type AgentErrorCode =
  /** 没连上 / 没拿到回应 */
  | "request-failed"
  /** 拿到了回应，但流断了或回应不合规 */
  | "stream-failed"
  /** agent 已经终结（`stop()` / `kill()` 动过）：再等也不会有人来取 */
  | "closed"
  /** 输入闸暂时关着（`pauseInput()` 之后、`resumeInput()` 之前）：等一等还能投 */
  | "input_paused";

export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string, options?: { cause?: unknown }) {
    // 原始错误挂在原生 `cause` 上，不另起一格
    super(message, options);
    this.name = "AgentError";
    this.code = code;
  }

  /**
   * 落库用：`{ code, message }` 就够重建。
   *
   * `stack` 与 `cause` 由写库的人自己决定要不要存 —— 它们都可能是任意形状，
   * core 不规定序列化口径（那是宿主的财产）。
   */
  toJSON(): { code: AgentErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }

  /** 从库里的行读回来：`instanceof` 重新成立，`cause` 需要的话由调用方补 */
  static fromJSON(value: { code: AgentErrorCode; message: string }): AgentError {
    return new AgentError(value.code, value.message);
  }
}
