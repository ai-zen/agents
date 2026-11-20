import { initTRPC } from "@trpc/server";

import type { Connection } from "../connection/registry.js";
import type { Translator } from "../i18n/index.js";
import { hostErrorFormatter } from "./errors.js";

/**
 * 一条 socket 一份上下文：tRPC 每条连接调一次 `createContext`，所以这里放的是连上来的那一刻
 * 建立的那条连接，不是任何一次请求的状态。语言不在这里 —— 它是用户级的全局设置，放在连接上
 * 就变成每条连接各一份快照。
 */
export interface HostContext {
  readonly connection: Connection;
}

/**
 * tRPC 的根，每个宿主一个。
 *
 * 它是个函数而不是模块级的常量，因为失败出网那一层要读翻译函数：语言在调用那一刻从配置里
 * 现读，把 `t` 存在这里当字段就是在造快照。
 */
export function createTrpc(t: Translator) {
  return initTRPC.context<HostContext>().create({ errorFormatter: hostErrorFormatter(t) });
}

export type Trpc = ReturnType<typeof createTrpc>;
