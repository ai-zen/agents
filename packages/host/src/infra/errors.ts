/**
 * 宿主的失败分两种，只有一种是这个类：
 *
 * - **跨 wire 的失败**（会回给客户端）→ `HostError`：`code` 给客户端做条件判断、给日志分类，
 *   `message` 是按当前语言渲染好的一句成品，`details` 只在客户端确实要据此分支时才有。
 * - **宿主自己的运行事故**（启动、文件、磁盘）→ 英文 `Error` + `cause`，只进日志。
 *
 * `code` 说的是世界的状态，不是入参的形状——形状由边界上的 schema 声明，到这里一律已经成立。
 */
export type ErrorCode = "not_found" | "invalid_params" | "busy" | "unsupported" | "config_invalid";

export class HostError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
