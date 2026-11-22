/**
 * `@ai-zen/agents-testing` —— 跨包共用的测试件。
 *
 * 假端点本身在 `@ai-zen/fake-llm`：它假的是模型提供方，而那件事与调用方是谁无关，
 * 单独成包之后别的仓也能用。这里只把它转出去，调用点的 `import` 不必跟着变。
 *
 * 本包 `private: true`：它是测试件，不对外发布，仓内几个包用 `workspace:*` 引它。
 */

export { buildDeltas, cutText, splitReply, startFakeLlm } from "@ai-zen/fake-llm";
export type {
  FakeLlm,
  FakeLlmChunking,
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
} from "@ai-zen/fake-llm";
