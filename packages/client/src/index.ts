/**
 * `@ai-zen/agents-client` —— 一个前端（CLI / 桌面端 / 将来的其它）到 `agents-server`
 * 之间**全部**需要在客户端这边发生的事。
 *
 * ## 包里有什么（五件）
 *
 *   1. **服务发现与拉起**（`ensure-server.ts`）：读 `<aiZenDir>/run/server.json`，探活失败就
 *      detached 拉一个 `agents-server serve`，再轮询到能 `ping` 通；
 *   2. **一条连接**（`socket-server-client.ts`）：TCP + JSON-lines + `hello` 握手 + 在飞调用
 *      + 事件分发 + 断开通知；
 *   3. **两张门面**（`sessions.ts` / `config-port.ts`）：把 `call("session.xxx")` 那种字符串
 *      调用收成带类型的方法，上层不写方法名、不拼参数；
 *   4. **两个判据**（`local-host.ts` / `status.ts`）：工作目录该不该递上去、服务端现在什么状态；
 *   5. **一份合并规则**（`stream-merge.ts`）：「本地流式增量」与「服务端快照」怎么拼（纯函数，
 *      与传输无关 —— 两个前端在同一个时序压力下都要用它，抄两份就会漂）。
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
export * from "./sessions.js";
export * from "./config-port.js";
export * from "./status.js";
export * from "./local-host.js";
export * from "./mcp.js";

// 「本地流式增量 vs 服务端快照」的合并规则（`mergeStreamedSnapshot` / `StreamedAssistant`）。
// 它是公开面的一部分：两个前端都要在同一个时序压力下做同一件事（快照比第一批增量还慢），
// 而这份规则只该有一份 —— 前端各写一遍就会在「宁可重复也不吞字」这类边界上分叉。
export * from "./stream-merge.js";

// 协议面（方法名常量 / 结果类型 / 帧编解码）原样转出，理由见文件头
export * from "@ai-zen/agents-protocol";
