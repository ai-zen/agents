/**
 * `packages/server/src/protocol/` 的入口 —— **线上契约的类型面**：只有 `type` / `interface`。
 *
 * ## 这一层管什么 / 不管什么
 *
 * 管：两进程之间「说什么形状」——方法名与事件名的字面量联合、载荷类型、错误码联合、
 * 帧的形状、数据模型的类型转出。
 * 不管：任何运行期值。版本号常量、帧编解码、错误码判定、发现文件读写、`callOnce`、
 * 回环判据，全部属于实现 —— 本包的在 `src/wire/`，客户端自己那一份在
 * `packages/client/src/wire/`。
 *
 * ## 为什么是类型文件，而不是一个包
 *
 * 契约是**服务端提供的形状**，它就住在服务端里，没有一个单独的可安装单元。客户端要认这些
 * 形状时只做 `import type`（构建期的事），运行期它用自己的实现 —— 所以
 * `@ai-zen/agents-server` 在客户端只是 devDependency，装客户端不会把服务端运行时拖进来。
 *
 * ## 为什么用 `export type *`
 *
 * 逐个列符号的话，每加一条方法就要在这里补一行，忘了就是「导出不存在」—— 而这类遗漏
 * 不会被任何门禁抓到。`export type *` 让这里成为纯透传：新增类型自动可见。
 */

export type * from "./api.js";
export type * from "./messages.js";
export type * from "./daemon.js";
export type * from "./sessions.js";
export type * from "./config.js";
export type * from "./assets.js";
export type * from "./content.js";
export type * from "./phase.js";
export type * from "./errors.js";
export type * from "./model.js";
