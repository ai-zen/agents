/**
 * 包出口（`main` / `types` 都指这里）。
 *
 * 三件东西：
 *   1. 起服务的入口：`createHost` / `HostApp` —— 别的进程（桌面端、脚本）可以把宿主
 *      当库用，与命令行启动的是**同一个**单根，不各写一套组装。
 *   2. 契约：`wire` 的全部类型与方法表，客户端照着接线，不必再抄一份形状。
 *   3. 路径与监听来源：`resolvePaths` / `resolveListenTarget` —— 客户端与宿主读同一份数据根
 *      规则，才不会出现「服务在 A、客户端看 B」。
 *
 * 这里只做再导出，不新增语义，也不导出任何单例。
 */

export { createHost, resolveHostVersion, HostApp } from "./app.js";
export type { ExitFacts, ExitHook, ExitReason, HostAppOptions } from "./app.js";

export {
  DEFAULT_PORT,
  LOOPBACK_HOST,
  PUBLIC_HOST,
  isValidPort,
  resolveDataRoot,
  resolveListenTarget,
  resolvePaths,
} from "./config.js";
export type { ListenTarget, ListenTargetInput, HostPaths } from "./config.js";

// `run/host.json` 的形状：连接层要读这个文件，字段名是同一份真相（PRD D25），
// 所以这里把它导出去，让客户端 `Pick` 本类型而不是自己重声明一份字段。
export type { HostFileInfo } from "./net/discovery.js";

export * from "./wire/index.js";
