import type { Language } from "../i18n/index.js";
import { HostError, jsonRpcCode, toErrorData, type ErrorData } from "./errors.js";
import type { EventName, EventPayload } from "./events.js";

/**
 * JSON-RPC 2.0 帧（PLAN A4）。
 *
 * 以标准为底，产品形状长在 `params` / `result`。标准里对我们有负担的部分不用，
 * 具体是：
 *   - **批量请求**：帧是数组时直接拒（`unsupported`）—— 一条连接上并发靠多条请求就够，
 *     批量会带来「数组里部分成功」这种没法向用户解释的结果；
 *   - 强制错误码空间：数字码只做粗分类，真伪看 `error.data.code`（见 `errors.ts`）；
 *   - 「通知必须无 id」：标准里带 id 的帧就是请求，而我们出网的通知不带 id（客户端也不需要回什么）。
 *
 * 宿主入站只用到 request 与 notification；response 两种是客户端解析回包时用的，守卫与解析
 * 一并在这一份里给全，客户端直接复用（不另拄一份）。
 */

/** 请求 id：字符串或数字（宿主分配或回显客户端给的；`null` 只出现在错误响应里） */
export type JsonRpcId = string | number;

/** 请求帧（要回一个响应） */
export interface JsonRpcRequestFrame {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

/** 通知帧（不需要响应） */
export interface JsonRpcNotificationFrame {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** 错误对象：数字码 + 一句短描述 + `data`（业务码、人话、结构化事实） */
export interface JsonRpcError {
  code: number;
  message: string;
  data: ErrorData;
}

/** 成功响应帧 */
export interface JsonRpcSuccessFrame {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

/** 错误响应帧；`id` 为 `null` 表示「连 id 都没解析出来」 */
export interface JsonRpcErrorFrame {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcError;
}

/** 两种响应帧 */
export type JsonRpcResponseFrame = JsonRpcSuccessFrame | JsonRpcErrorFrame;

/**
 * 解析后的帧：分好类、参数已挑出来。
 *
 * 分四类而不是三类：`response`（成功）与 `error`（错误响应）是客户端解析回包时要分别处置的
 * 两种，形状都保留。
 */
export type Frame =
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "response"; id: JsonRpcId; result: unknown }
  | { kind: "error"; id: JsonRpcId | null; error: JsonRpcError };

// ---------------------------------------------------------------------------
// 守卫
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function hasProtocol(value: Record<string, unknown>): boolean {
  return value.jsonrpc === "2.0";
}

/** 是不是请求帧 */
export function isRequestFrame(value: unknown): value is JsonRpcRequestFrame {
  if (!isRecord(value)) return false;
  if (!hasProtocol(value)) return false;
  return typeof value.method === "string" && value.method !== "" && isId(value.id);
}

/** 是不是通知帧（无 id，或 id 为 null —— 后者在标准里含糊，按通知处理） */
export function isNotificationFrame(value: unknown): value is JsonRpcNotificationFrame {
  if (!isRecord(value)) return false;
  if (!hasProtocol(value)) return false;
  if (typeof value.method !== "string" || value.method === "") return false;
  return value.id === undefined || value.id === null;
}

/** 是不是成功响应帧（含 `result`） */
export function isSuccessFrame(value: unknown): value is JsonRpcSuccessFrame {
  if (!isRecord(value)) return false;
  if (!hasProtocol(value)) return false;
  return isId(value.id) && "result" in value && !("error" in value);
}

/** 是不是错误响应帧（含 `error`） */
export function isErrorFrame(value: unknown): value is JsonRpcErrorFrame {
  if (!isRecord(value)) return false;
  if (!hasProtocol(value)) return false;
  const id = value.id;
  if (!(id === null || isId(id))) return false;
  return isRecord(value.error);
}

/** 是不是任一方向的响应帧 */
export function isResponseFrame(value: unknown): value is JsonRpcResponseFrame {
  return isSuccessFrame(value) || isErrorFrame(value);
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function invalidFrame(detail: unknown, field: string): HostError {
  return new HostError("invalid_params", {
    params: { field },
    detail,
  });
}

/**
 * 把一条入站消息解析成 `Frame`。
 *
 * 三种拒绝各有稳定业务码：
 *   - 不是合法 JSON / 不是对象 → `invalid_params`（`detail.reason` 说明是哪一步坏的）；
 *   - 数组（批量请求）→ `unsupported`，`detail.reason` 为 `batch_not_supported`；
 *   - 缺 `jsonrpc` / 缺 `method` / id 类型不对 → `invalid_params`，`detail.field` 指出字段。
 */
export function parseFrame(input: unknown): Frame {
  let value: unknown = input;

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw invalidFrame(
        { reason: "not_json", text: error instanceof Error ? error.message : String(error) },
        "jsonrpc",
      );
    }
  }

  if (Array.isArray(value)) {
    throw new HostError("unsupported", {
      params: { what: "batch requests" },
      detail: { reason: "batch_not_supported", count: value.length },
    });
  }

  if (!isRecord(value)) {
    throw invalidFrame({ reason: "not_an_object" }, "jsonrpc");
  }

  if (!hasProtocol(value)) {
    throw invalidFrame({ reason: "bad_protocol", got: value.jsonrpc ?? null }, "jsonrpc");
  }

  if (typeof value.method === "string") {
    if (value.method === "") {
      throw invalidFrame({ reason: "empty_method" }, "method");
    }
    const params = value.params ?? {};
    if (isId(value.id)) {
      return { kind: "request", id: value.id, method: value.method, params };
    }
    if (value.id === undefined || value.id === null) {
      return { kind: "notification", method: value.method, params };
    }
    throw invalidFrame({ reason: "bad_id", got: value.id }, "id");
  }

  if ("error" in value) {
    const error = value.error;
    if (!isRecord(error)) {
      throw invalidFrame({ reason: "bad_error_object" }, "error");
    }
    return { kind: "error", id: isId(value.id) ? value.id : null, error: parseErrorObject(error) };
  }

  if ("result" in value) {
    if (!isId(value.id)) {
      throw invalidFrame({ reason: "bad_id", got: value.id ?? null }, "id");
    }
    return { kind: "response", id: value.id, result: value.result };
  }

  throw invalidFrame({ reason: "neither_method_nor_result" }, "method");
}

/** 解析入站的错误对象；字段缺失时按 `internal` 兜底，让解析不至于半路炸掉 */
function parseErrorObject(value: Record<string, unknown>): JsonRpcError {
  const code = typeof value.code === "number" && Number.isFinite(value.code) ? value.code : -32603;
  const message = typeof value.message === "string" ? value.message : "";
  const data = isRecord(value.data) ? (value.data as unknown as ErrorData) : null;
  return { code, message, data: data ?? { code: "internal", message, params: {} } };
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

/** 成功响应 */
export function okResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessFrame {
  return { jsonrpc: "2.0", id, result };
}

/**
 * 错误响应。
 *
 * `error.message` 与 `error.data.message` 都是**按连接语言渲染好的那句话**：前者满足标准
 * 对「一句短描述」的要求，后者是客户端真正显示的东西（PRD D8）。
 * 传入非 `HostError` 时会被收敛成 `internal`（`detail.reason` 留着原始信息）。
 */
export function errResponse(
  id: JsonRpcId | null,
  error: unknown,
  language: Language,
): JsonRpcErrorFrame {
  const data = toErrorData(error, language);
  // 数字码表与 errors.ts 同源，一处维护
  const numericCode = HostError.is(error) ? jsonRpcCode(error.code) : -32603;
  return {
    jsonrpc: "2.0",
    id,
    error: { code: numericCode, message: data.message, data },
  };
}

/** 通知帧：宿主推送事件用（`notification("state", payload)`） */
export function notification<E extends EventName>(
  event: E,
  payload: EventPayload<E>,
): JsonRpcNotificationFrame {
  return { jsonrpc: "2.0", method: event, params: payload };
}
