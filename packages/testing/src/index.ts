/**
 * `@ai-zen/agents-testing` —— 跨包共用的测试件。
 *
 * 主体是 {@link startFakeLlm}（OpenAI 兼容的流式/一次性端点）。放进包里而不是各仓各留
 * 一份：它假的是**模型提供方**，而「`chunk-parsed` 的第二参才是 chunk」这条契约有三个
 * 消费者（core 的广播、server 的翻译、CLI 的呈现）。一份实现、一处演进，才谈得上
 * 「同一个 wire 格式」。
 *
 * 本包 `private: true`：它是测试件，不对外发布。仓内用 `workspace:*`，CLI 用 `link:`。
 */

export { startFakeLlm, splitReply } from "./fake-llm.js";
export type { FakeLlm, FakeLlmOptions, FakeLlmRequest } from "./fake-llm.js";
