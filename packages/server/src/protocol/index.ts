/**
 * 协议面的**对外入口**（`@ai-zen/agents-server/protocol`）。
 *
 * ## 为什么单开一个子路径导出
 *
 * 客户端（`@ai-zen/agents-client`，以及将来的桌面端 main）需要的是这份**线上契约**：
 * 方法名常量、请求/响应形状、帧编解码、发现文件的形状。而它**不需要**服务端本体
 * ——`Daemon`、`SessionManager`、`SessionAgentFactory` 那一整套会把
 * `@ai-zen/agents-sdk`（连带 agents-core、MCP SDK、openai）一起拖进客户端的依赖图。
 *
 * 桌面端 main 是打包产物：只要 import 图上出现 `@ai-zen/agents-server` 的主入口，
 * 整套服务端实现就会被塞进安装包。所以给协议单开一个入口，让它成为**唯一**被客户端
 * 引用的路径 —— 判断标准很硬：这个文件里能 export 的东西，都必须零外部依赖（实测：本目录
 * 下各模块**运行时**只 import 本目录的兄弟模块与 node 内置模块；唯一跨出本目录的是一处
 * `import type` —— `sessions.ts` 里的 `PhaseInfo`，类型在编译后抹掉，不进运行时依赖图）。
 *
 * ## 为什么 `discovery` 在这
 *
 * `<aiZenDir>/run/server.json` 的形状与读写也是**跨进程契约**（服务端写、客户端读，
 * 决定「要不要连、连哪个端口」），与帧编解码同性质 —— 放在 `daemon/` 下会让人以为它
 * 属于服务端内部实现。它同样零外部依赖，所以进得来。
 *
 * ## 为什么用 `export *`
 *
 * 逐个列符号的话，协议每加一条方法就要在这里补一行，忘了就是「导出不存在」——
 * 而这类遗漏不会被任何门禁抓到（服务端自己不用这个入口）。`export *` 让这里成为
 * 纯透传：新增符号自动可见。代价是符号重名会编译失败 —— 那正是我们想要的提醒。
 * （实测七个模块之间没有重名。）
 */

export * from "./frames.js";
export * from "./messages.js";
export * from "./daemon.js";
export * from "./sessions.js";
export * from "./config.js";
export * from "./assets.js";
export * from "./discovery.js";
export * from "./host.js";
