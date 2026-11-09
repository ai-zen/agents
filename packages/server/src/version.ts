/**
 * 服务端包版本 —— 从自己的 `package.json` 读（构建产物在 `dist/`，故 `../package.json`）。
 *
 * 为什么不用 `process.env.npm_package_version`：那只在 npm script 里存在，守护进程由
 * 客户端 detach 拉起，环境完全不同。这里读的是**磁盘上真实装的这份**。
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const SERVER_NAME = "@ai-zen/agents-server";
export const SERVER_VERSION: string =
  (require("../package.json") as { version?: string }).version ?? "unknown";
