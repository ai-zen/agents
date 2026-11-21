import { initTRPC } from "@trpc/server";
import { z } from "zod";

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
 * 握手帧带的那几格。
 *
 * 令牌从这里上来而不是从 URL 查询串：查询串会进访问日志、进浏览器历史，而这一格只在连接建立
 * 时过一遍线。tRPC 客户端与此处的约定是「连接时先送 `connectionParams`」，服务端因此不需要
 * 猜客户端用的是哪种 WebSocket 实现 —— 浏览器里设不了请求头。
 */
export const connectionParams = z.object({ token: z.string() });

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
