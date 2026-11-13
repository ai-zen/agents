/**
 * JSON-RPC 2.0 帧的**判别与构造**（形状来自宿主契约，这里只有运行期的分类）。
 *
 * 为什么本文件不 import 宿主的运行期导出（`parseFrame` / `okResponse` / `notification`）：
 * `@ai-zen/agents-host` 的包根会把整个宿主（单根、SQLite worker、SDK 装配）一起拉进产物。
 * 客户端只要类型，所以帧形状用 `import type` 拿，判别与拼装自己写这几十行。
 *
 * 入站只可能是两种东西：
 *   1. **通知**（有 `method`、没有 `id`）：宿主推的事件，`method` 就是事件名（`EventMap` 的键）；
 *   2. **响应**（没有 `method`、有 `id`，带 `result` 或 `error` 恰有其一）。
 * 客户端发来的请求方向不存在（宿主不向客户端发请求），所以两种之外的一律忽略。
 */

import type {
  JsonRpcErrorFrame,
  JsonRpcId,
  JsonRpcNotificationFrame,
  JsonRpcRequestFrame,
  JsonRpcSuccessFrame,
} from "@ai-zen/agents-host";

/** 一条入站帧的三种可能，分好类再交给 `Client` */
export type IncomingFrame =
  | { kind: "notification"; frame: JsonRpcNotificationFrame }
  | { kind: "success"; frame: JsonRpcSuccessFrame }
  | { kind: "error"; frame: JsonRpcErrorFrame };

/** 一条出站请求（`id` 由 `Client` 分配） */
export function requestFrame(id: JsonRpcId, method: string, params: unknown): JsonRpcRequestFrame {
  // `params` 为 `undefined` 时 JSON 里不留这个键（`JSON.stringify` 会整键丢掉），消息就只剩
  // `{jsonrpc, id, method}` —— 宿主解析时按 `{}` 处理
  return { jsonrpc: "2.0", id, method, params };
}

/** 一条出站帧 → 要写进 socket 的字符串 */
export function encodeFrame(frame: JsonRpcRequestFrame): string {
  return JSON.stringify(frame);
}

/**
 * 一条入站文本 → 分类后的帧；不是合法 JSON / 不是对象 / 既不像通知也不像响应时返回 `null`。
 *
 * 返回 `null` 而不是抛错：WS 已经给了消息边界，坏了这一条不影响下一条，而这条连接上没有任何
 * 一条请求需要为它失败。
 */
export function parseIncoming(text: string): IncomingFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0") return null;

  // 通知：有 `method`，且 `id` 缺失或为 `null`
  if (typeof value.method === "string" && value.method !== "") {
    if (value.id === undefined || value.id === null) {
      return { kind: "notification", frame: value as unknown as JsonRpcNotificationFrame };
    }
    // 宿主不会向客户端发请求（`id` + `method` 同时出现）：不认识，当噪声丢掉
    return null;
  }

  if (!isId(value.id)) return null;

  if ("error" in value) {
    return { kind: "error", frame: value as unknown as JsonRpcErrorFrame };
  }
  if ("result" in value) {
    return { kind: "success", frame: value as unknown as JsonRpcSuccessFrame };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
