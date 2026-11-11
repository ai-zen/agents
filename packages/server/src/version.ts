/**
 * 服务端包版本。
 *
 * 两条来源，按「谁更权威」排序：
 *
 *   · **构建期注入**（`__SERVER_VERSION__`）—— 被宿主**打包**时走这一支。那时本模块不在
 *     服务端的 `dist/` 里，`require("../package.json")` 指向的是**宿主的**包：桌面端打出来的
 *     服务端一度读出 `unknown`，其实是静默读到了 `desktop/packages/main/package.json`
 *     （它恰好没有 `version` 字段）。这种错法比报错更坏 —— 版本号看起来只是「没填」。
 *   · **读自己的 `package.json`** —— 直接跑 `agents-server` bin 时走这一支（构建产物在
 *     `dist/`，故 `../package.json`）。
 *
 * 为什么不读 `process.env.npm_package_version`：那只在 npm script 里存在，守护进程由客户端
 * detach 拉起，环境完全不同。这里要的是「磁盘上真实装的这份」。
 *
 * `typeof` 判断而不是 `try/catch`：未声明的标识符在 `typeof` 下安全返回 `"undefined"`。
 */

import { createRequire } from "node:module";

declare const __SERVER_VERSION__: string | undefined;

const require = createRequire(import.meta.url);

export const SERVER_NAME = "@ai-zen/agents-server";

/** 直接跑 `dist/` 时用；读不到（被打包进别处）返回 `unknown` */
function readPackageVersion(): string {
  try {
    return (require("../package.json") as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const SERVER_VERSION: string =
  typeof __SERVER_VERSION__ === "string" ? __SERVER_VERSION__ : readPackageVersion();
