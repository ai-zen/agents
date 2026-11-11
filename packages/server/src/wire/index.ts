/**
 * 契约层出口。
 *
 * 客户端照这份形状接线；服务端接线层（`net/`）按 `MethodMap` 分发、按 `EventMap` 推送。
 * 这里只做再导出，不新增语义。
 */

export * from "./errors.js";
export * from "./states.js";
export * from "./methods.js";
export * from "./events.js";
export * from "./frames.js";
