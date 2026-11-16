/**
 * 契约层出口。
 *
 * 客户端照这份形状接线；宿主接线层（`net/`）按 `MethodMap` 分发、按 `EventMap` 推送。
 * 这里只做再导出，不新增语义。
 *
 * core 的消息相关类型一并再导出：客户端 `import type { AgentNS } from "@ai-zen/agents-host"`
 * 就能拿到消息、消息内容段、工具调用、状态、角色、结束原因、增量与用量的**同一份定义**，
 * 不必自己再抄一份 —— 抄出来的第二份迟早与宿主存下来的那条对不上。
 */

export * from "./errors.js";
export * from "./states.js";
export * from "./methods.js";
export * from "./events.js";
export * from "./frames.js";

/**
 * `AgentNS` 既是类型空间的容器（`AgentNS.Message` / `AgentNS.MessageContent` /
 * `AgentNS.ToolCall` / `AgentNS.Delta` / `AgentNS.Usage` …），也是运行期的枚举表
 * （`AgentNS.Role` / `AgentNS.MessageStatus` / `AgentNS.FinishReason` 的取值）。
 */
export { AgentNS } from "@ai-zen/agents-core";

/**
 * 用量的零值、逐字段相加与求和：`sumUsage` 会把消息自身用量与子 Agent 用量一起累加，
 * 累计口径与计费一致。用量归客户端自己算（宿主不算、不存、不报），算的时候直接用它，
 * 免得再写第二套加法。
 */
export { ZERO_USAGE, addUsage, sumUsage } from "@ai-zen/agents-core";

/**
 * 把一片增量攒进一条消息。宿主自己是这么攒的，客户端折 `message.delta` 时用同一份实现，
 * 攒出来的消息与宿主存下来的逐字一致。
 */
export { applyChunk } from "@ai-zen/agents-core";
