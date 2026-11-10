/**
 * `@ai-zen/agents-protocol` 的对外入口 —— 线上契约的唯一出口。
 *
 * ## 这个包管什么 / 不管什么
 *
 * 管：两进程之间「怎么找到对方（发现文件的形状与读写）/ 怎么说话（帧编解码、`callOnce`）/
 * 说什么形状（方法名表、事件名表、载荷类型、错误码表、数据模型的类型转出）」。
 * 不管：任何业务判断、任何状态机、任何 UI 概念 —— 这里没有一个函数知道「会话」「工作区」
 * 该怎么运作，只有它们在线上的样子。
 *
 * ## 为什么是一个独立的包，而不是服务端的一个子路径
 *
 * 契约是**双方的东西**：`server` 与 `client` 都只依赖本包，谁都不依赖谁。若把它放在
 * `@ai-zen/agents-server` 里，依赖图就变成 `client → server`，「客户端不拖进服务端实现」
 * 只能靠纪律维持（只许走子路径、产物依赖图必须闭合）。性质是结构而不是纪律。
 *
 * ## 为什么用 `export *`
 *
 * 逐个列符号的话，协议每加一条方法就要在这里补一行，忘了就是「导出不存在」——
 * 而这类遗漏不会被任何门禁抓到。`export *` 让这里成为纯透传：新增符号自动可见。
 * 代价是符号重名会编译失败 —— 那正是我们想要的提醒。
 *
 * ## 运行期零第三方依赖（`packages/protocol/README.md` 里有可执行的 grep 判据）
 *
 * 本目录各模块在**运行期**只 import 兄弟模块与 `node:*`。唯一跨出本目录的是
 * `@ai-zen/agents-core` 的 `import type`（`model.ts`）—— 类型在编译后抹掉，不进运行时
 * 依赖图。所以桌面端 main 这类打包产物引用本包时，不会把 openai / MCP SDK 拖进去。
 */

export * from "./frames.js";
export * from "./messages.js";
export * from "./daemon.js";
export * from "./sessions.js";
export * from "./config.js";
export * from "./assets.js";
export * from "./discovery.js";
export * from "./host.js";
export * from "./phase.js";
export * from "./errors.js";
export * from "./model.js";
export * from "./call-once.js";
