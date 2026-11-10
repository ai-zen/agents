/**
 * `@ai-zen/agents-client` —— 一个前端（CLI / 桌面端 / 将来的其它）到 `agents-server`
 * 之间**全部**需要在客户端这边发生的事。
 *
 * ## 包里有什么（按「脏 / 纯」分层）
 *
 * | 层 | 文件 | 职责 |
 * |---|---|---|
 * | 传输 | `transport/connection.ts` | **一个进程一条连接**（`ServerConnection`）：发现/拉起、断线重建、在新连接上重新订阅 `events.watch`、断线与就绪的上报 |
 * | 传输 | `socket-server-client.ts` | 一条 TCP + JSON-lines + `hello` 握手 + 在飞调用 + 事件分发 |
 * | 传输 | `ensure-server.ts` | 读发现文件并探活，探不到就 detached 拉起一个 `agents-server serve` |
 * | 脏 | `session/channel.ts` | **一条会话的 I/O**（`SessionChannel`）：订阅、请求、重连三条不变式、重新 `attach` |
 * | 纯 | `session/stream.ts` | **一轮之内的状态机**（`SessionStream`）：零 I/O、零 UI、零 timers |
 * | 纯 | `stream-merge.ts` | 「本地流式增量 vs 服务端快照」怎么拼（`mergeStreamedSnapshot`） |
 * | 纯 | `session/errors.ts` | 「这段会话还在不在」的唯一判据 |
 * | 门面 | `facade/sessions.ts` | `session.*`(21) + `workspace.*`(6)，**100% 覆盖**（类型级用例钉着） |
 * | 门面 | `facade/config.ts` | `config.*`(7) + `agent.*`(5) + `asset.*`(1)，同样 100% 覆盖 |
 * | 应用端口 | `config-port.ts` | 配置面（`ConfigPort`）：把线上形状兑现成 `AppConfig` / `AgentStore` 这些应用类型 |
 * | 判据 | `local-host.ts` / `status.ts` / `mcp.ts` | 工作目录该不该递上去、服务端现在什么状态、`mcp.json` 的形状 |
 *
 * ## 为什么协议也从这里转出
 *
 * `export * from "@ai-zen/agents-protocol"`。这样上层只要认这一个包：方法名常量、
 * 结果类型、帧编解码、数据模型类型都在手边。它**不是**第二份定义 —— 只是把协议包原样
 * 转出去（那个包的**运行期**依赖图是闭合的：只有同级模块 + node 内置；类型面有一处跨出去的
 * `import type` 到 core，编译后即被抹掉）。
 *
 * ## 运行期依赖图（可用 grep 检验，见 README）
 *
 *   @ai-zen/agents-client ──→ @ai-zen/agents-protocol ──→ node:fs / node:path / node:net
 *                          └─→ node:net / node:child_process / node:os / node:module
 *
 * 只有协议包一个包：**没有 sdk、没有服务端本体、没有 core**。这不是纪律（靠人记得只走子路径），
 * 是结构 —— `client` 与 `server` 之间没有依赖边，两侧都只依赖协议包。
 *
 * 两处例外都只是**类型**，在产物里被整体擦除：`config-port.ts` 的
 * `import type … from "@ai-zen/agents-sdk"`（配置 / 定义在两端的共同形状），
 * 和协议包里对 core 的那一次类型转出（`Message` / `Usage` / `ToolCall`）。
 */

export * from "./types.js";
export * from "./socket-server-client.js";
export * from "./ensure-server.js";
export * from "./status.js";
export * from "./local-host.js";
export * from "./mcp.js";

// 传输层：一个进程一条连接。会话层不自己建连接，只借它说话
// —— 「断了就重建 + 重新 events.watch」只在这一处发生
export * from "./transport/connection.js";

// 会话层：一纯一脏。纯的那个（状态机）可以在单测里直接跑完一轮，
// 脏的那个（通道）只负责接线与重连 —— 这条边界就是「会话状态机终于能被测」的全部凭据
export * from "./session/stream.js";
export * from "./session/channel.js";
export * from "./session/errors.js";

// 门面：方法名集合 === 协议方法表 key 集合（类型级用例见 `facade/coverage.test-d.ts`）
export * from "./facade/sessions.js";
export * from "./facade/config.js";
export * from "./config-port.js";

// 「本地流式增量 vs 服务端快照」的合并规则（`mergeStreamedSnapshot` / `StreamedAssistant` / `ROLE`）。
// 它是公开面的一部分：会话状态机与两个前端都要在同一个时序压力下做同一件事
// （快照比第一批增量还慢），而这份规则只该有一份 —— 各写一遍就会在「宁可重复也不吞字」
// 这类边界上分叉。
export * from "./stream-merge.js";

// 协议面（方法名常量 / 结果类型 / 帧编解码）原样转出，理由见文件头
export * from "@ai-zen/agents-protocol";
