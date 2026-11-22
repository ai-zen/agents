/**
 * `@ai-zen/fake-llm` —— OpenAI 兼容的假端点。
 *
 * 它假的是模型提供方，不是调用方的任何一层：只依赖 `node:http`，不引用本仓任何包，
 * 谁都能在离线的机器上用它跑通一条真实的 HTTP 流。
 *
 * 核心能力是从一条完整的目标消息倒推出 delta 流：正文、思考、工具调用各自切几片，
 * 首片报 `role`，收尾片报结束原因与用量 —— 与真实提供方发出来的一样，区别只是内容与时机
 * 全由调用方定，断言可以写等号。
 */

export { buildDeltas, cutText, splitReply, DEFAULT_CHUNKS } from "./deltas.js";
export type { FakeLlmChunking } from "./deltas.js";
export { startFakeLlm } from "./server.js";
export type {
  FakeLlm,
  FakeLlmContentSection,
  FakeLlmDelta,
  FakeLlmFinishReason,
  FakeLlmFunctionCall,
  FakeLlmMessage,
  FakeLlmOptions,
  FakeLlmReply,
  FakeLlmRequest,
  FakeLlmStreamPart,
  FakeLlmToolCall,
  FakeLlmUsage,
} from "./types.js";
