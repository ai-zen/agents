/**
 * 数据模型的**类型出口** —— 协议认得的那些形状，一律从 `@ai-zen/agents-core` 转出。
 *
 * ## 为什么协议认识消息（而不是把 `messages` 当 `unknown[]`）
 *
 * 「载荷里的 `messages` 是 `unknown[]`，形状由 SDK 定、协议不解释」这条口径的初衷没错
 * （避免镜像类型漂移），但代价没被记账：**每个客户端都必须 `import type … from
 * "@ai-zen/agents-core"` 才能读一条消息**，于是「客户端只认协议」这句话在数据模型这一层
 * 根本不成立 —— 而数据模型恰恰是客户端最常用的那一层。
 *
 * 正确的解法不是再抄一份「线上消息」镜像（那就是第二份定义，正是本项目最忌讳的事），而是
 * **承认它就是 core 的数据模型**，并在一个地方（这里）声明它。落盘格式（存档 JSON）就是
 * 这份形状，线上传的也是同一份 —— 只有一份定义，没有第二处会漂。
 *
 * ## 为什么只有类型、没有值
 *
 * 本文件全是 `export type`：`Role` 是 enum（运行期有对象），只能通过 `Message["role"]`
 * 这种**类型位置**使用，绝不许 `export { Role }` —— 那会把 core 拖进本包的运行时依赖图
 * （连带 openai），而本包的立身之本就是「运行期零第三方依赖」。
 *
 * ## 为什么 `ModelParams` 是这里自己写的
 *
 * 它是唯一一个 core 里没有的：`AppConfig` / `AgentDefinition` / `ModelParams` 都在
 * `@ai-zen/agents-sdk`（协议不依赖 sdk —— 客户端不该为了一个配置形状去装整套能力层）。
 * 而 `ModelParams` 在 SDK 里的定义就是 `Record<string, unknown>`：一个「键名协议不解释、
 * 原样透传」的袋子。所以这里写的是**同一条**类型，不是一份镜像形状 —— 没有字段清单，
 * 也就不存在「两边字段漂开」这回事。
 */

import type { AgentNS } from "@ai-zen/agents-core";

/** 一条对话消息（线上载荷里出现的那份形状，也是存档 JSON 的形状） */
export type Message = AgentNS.Message;

/** token 用量（`Message.usage` / 快照的 `lastUsage`） */
export type Usage = AgentNS.Usage;

/** 一次工具调用（`Message.tool_calls` 的元素，组装中的也算） */
export type ToolCall = AgentNS.ToolCall;

/**
 * 模型请求参数覆盖（`SessionSnapshotResult.modelParams` / `session.modelParams.set` 的载荷）。
 *
 * 含厂商特有字段（`thinking` / `reasoning_effort` 等），协议**原样透传、不解释键名**。
 * 见文件头最后一段：与 SDK 那份是同一个类型。
 */
export type ModelParams = Record<string, unknown>;
