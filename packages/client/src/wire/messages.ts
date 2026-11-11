/**
 * 消息层的**运行期**部分：版本号常量与两个帧判定。
 *
 * 形状在 `src/protocol/messages.ts`（纯类型）；这里放实现。两侧各自有一份
 * （`packages/client/src/wire/messages.ts`）—— 协议只共享类型，不共享代码。
 */

import type { HelloRequest, ProtocolVersion, RequestFrame } from "@ai-zen/agents-server/protocol";

/** 协议版本：任何不兼容的字段变化都要 +1，两端必须一致 */
export const PROTOCOL_VERSION = 1 satisfies ProtocolVersion;

/** 首帧是不是 `hello`（连接处理的第一道判断） */
export function isHelloRequest(frame: unknown): frame is HelloRequest {
  const value = frame as Partial<HelloRequest> | null | undefined;
  return Boolean(value && value.kind === "hello" && typeof value.protocol === "number");
}

export function isRequestFrame(frame: unknown): frame is RequestFrame {
  const value = frame as Partial<RequestFrame> | null | undefined;
  return Boolean(
    value &&
    typeof value.id === "number" &&
    Number.isFinite(value.id) &&
    typeof value.method === "string" &&
    value.method.length > 0,
  );
}
