/**
 * OpenCode Go 这个端点与它的模型清单。
 *
 * 单独一个文件，不并进 `constants.ts`：那里面放的是手写维护的少量模型与注释，这里是按官方
 * `/models` 生成的数据，混在一起会把前者淹掉。
 *
 * ## 只收对话模型，而且只收「当前这套请求形状能跑通」的那些
 *
 * 清单是 `GET /inference/go/v1/models` 的产物（2026-11-24 取，36 条）。这里只留 19 条：
 *
 * - `type` 不是 `chat` 的 6 条（3 条 `decision`、3 条 `embedding`）不收 —— 本仓的模型表里没有
 *   `type` 这一格，收进来只会被当成聊天模型选；
 * - 混元 4 条（`hy3`、`hy4`、`hy4-preview`、`hy4-flash-free`）与 mimo 2 条（`mimo-v2.6-flash`、
 *   `mimo-v2.6-pro`）不收；
 * - `gemini-4-argon` 不收：它拒绝 `strict` 本身（原话是 google 不能保证 OpenAI 严格模式的语义），
 *   与工具定义写得合不合规无关；
 * - 环境门槛的 4 条不收：`muse-spark-1.2/1.3-contributor` 与 `beam-free` 在部分地区直接 403
 *   （对应清单里的 `go.limited_regions`），`iceman-contributor-free` 要求先在控制台打开
 *   「允许在请求数据上训练」的开关（对应 `go.training`），否则 400。
 *
 * 判断标准只有一条：拿真的 SDK、真的内置工具集打真端点，能完整跑通工具往返的才收。所以这份清单
 * 是实测结果，不是把 `/models` 抄一遍 —— 收录与版本升级都该照那条标准重跑一遍。
 *
 * ## 逐字段的来源（都是那一份响应里现成的，没有一处凭印象填）
 *
 * - `id`：`opencode-go:` 前缀加官方 id（例如 `opencode-go:glm-5.3`）。模型 id 是全局唯一的那把钥匙
 *   —— `config.models.find((m) => m.id === …)` 只认 id，而这一家有三条模型与出厂其余端点同名
 *   （智谱的 `glm-5.3` / `glm-5.3-flash`、OpenAI 的 `gpt-6-luna`），不前缀就会选到别家的那条；
 * - `modelName`：官方 id，原样发给端点；
 * - `name`：官方 `name`；
 * - `contextWindow`：官方 `limit.context`（真实窗口）；
 * - `maxOutputTokens`：官方 `limit.output`；
 * - `vision`：`modalities.input` 里有没有 `image/*`；
 * - `tokenThresholds`：按窗口的两条比例线（handoff 40%、guard 80%，与出厂其余模型同一个口径）。
 *   这两条线不是窗口：一个是「什么时候该交接」的产品取值，一个是「什么时候不许再发」；
 *   窗口本身记在 `contextWindow` 里，两者不要互相推导；
 * - `description`：官方 `description`。
 *
 * 没有 `reasoningPreset`：思考档位表只收「官方文档写明怎么传参数」的端点，而 OpenCode 这边
 * 本仓只有 `capabilities.reasoning.effort` 这一格（各模型的档位集合还不一样），没有请求侧参数的
 * 官方说明。所以这些模型在 `/think` 里不可调档 —— 不编一份没依据的表。
 *
 * 更新方式：重新打一次 `/models`，按上面几条重算，并且把「能不能跑通」那一关重过一遍。
 */

import type { EndpointDefinition, ModelDefinition } from "../types/index.js";

/** 端点的 id：模型表里每一行的 `endpointId` 都指它 */
export const OPENCODE_GO_ID = "opencode-go";

/**
 * 端点本身。
 *
 * `providerSessionHeader` 是硬要求，不是可选项：不带那个头，这个服务方直接回
 * `400 MissingSessionID`（实测过）。写在这里而不是让用户自己填 `headers`，因为它是这家端点的
 * 恒定事实，不该成为每个用户的配置作业。
 */
export const OPENCODE_GO_ENDPOINT: EndpointDefinition = {
  id: OPENCODE_GO_ID,
  name: "OpenCode Go",
  apiKey: "",
  baseUrl: "https://opencode.ai/inference/go/v1",
  description:
    "OpenCode Go subscription endpoint (OpenAI-compatible; requires an API key from OpenCode)",
  providerSessionHeader: "x-opencode-session",
};

/** 19 条对话模型（清单 36 条里能用的那些，见文件头） */
export const OPENCODE_GO_MODELS: ModelDefinition[] = [
  {
    id: "opencode-go:deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash 1017",
    endpointId: OPENCODE_GO_ID,
    modelName: "deepseek-v4.1-flash",
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    vision: true,
    description:
      "October 17 update of DeepSeek V4.1 Flash with improved reasoning, coding, agentic tasks, and visual understanding",
  },
  {
    id: "opencode-go:deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    endpointId: OPENCODE_GO_ID,
    modelName: "deepseek-v4-pro",
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    description: "Flagship DeepSeek model for coding, reasoning, and agentic work",
  },
  {
    id: "opencode-go:glm-5.3",
    name: "GLM-5.3",
    endpointId: OPENCODE_GO_ID,
    modelName: "glm-5.3",
    contextWindow: 1000000,
    maxOutputTokens: 131072,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    description: "Flagship GLM model for long-horizon coding, agents, and complex project delivery",
  },
  {
    id: "opencode-go:glm-5.3-flash",
    name: "GLM-5.3-Flash",
    endpointId: OPENCODE_GO_ID,
    modelName: "glm-5.3-flash",
    contextWindow: 1000000,
    maxOutputTokens: 131072,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    vision: true,
    description: "Native multimodal GLM model for efficient coding and long-horizon agent tasks",
  },
  {
    id: "opencode-go:grok-4.7",
    name: "Grok 4.7",
    endpointId: OPENCODE_GO_ID,
    modelName: "grok-4.7",
    contextWindow: 500000,
    maxOutputTokens: 500000,
    tokenThresholds: { handoff: 200000, guard: 400000 },
    vision: true,
    description:
      "xAI's frontier model for long-running agents, coding, knowledge work, and visual projects",
  },
  {
    id: "opencode-go:kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    endpointId: OPENCODE_GO_ID,
    modelName: "kimi-k2.7-code",
    contextWindow: 262144,
    maxOutputTokens: 262144,
    tokenThresholds: { handoff: 105000, guard: 210000 },
    vision: true,
    description:
      "Coding-focused Kimi model, stronger on long-horizon repo work with less overthinking",
  },
  {
    id: "opencode-go:kimi-k3",
    name: "Kimi K3",
    endpointId: OPENCODE_GO_ID,
    modelName: "kimi-k3",
    contextWindow: 1048576,
    maxOutputTokens: 1048576,
    tokenThresholds: { handoff: 419000, guard: 839000 },
    vision: true,
    description:
      "Multimodal Kimi model with 1M context and toggleable max-effort thinking for long-horizon agent work",
  },
  {
    id: "opencode-go:kimi-k3.1-pro",
    name: "Kimi K3.1 Pro",
    endpointId: OPENCODE_GO_ID,
    modelName: "kimi-k3.1-pro",
    contextWindow: 1048576,
    maxOutputTokens: 1048576,
    tokenThresholds: { handoff: 419000, guard: 839000 },
    vision: true,
    description:
      "Multimodal Kimi model with a 1M-token context window and always-on reasoning, for coding, 3D creation and financial research",
  },
  {
    id: "opencode-go:minimax-m3",
    name: "MiniMax-M3",
    endpointId: OPENCODE_GO_ID,
    modelName: "minimax-m3",
    contextWindow: 1000000,
    maxOutputTokens: 131072,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    vision: true,
    description: "MiniMax multimodal coding model for long-context reasoning and agent tasks",
  },
  {
    id: "opencode-go:minimax-m3.1-flash",
    name: "MiniMax M3.1 Flash",
    endpointId: OPENCODE_GO_ID,
    modelName: "minimax-m3.1-flash",
    contextWindow: 1000000,
    maxOutputTokens: 512000,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    vision: true,
    description:
      "Frontier multimodal coding model with 1M context window and tunable thinking depth",
  },
  {
    id: "opencode-go:qwen3.7-plus",
    name: "Qwen3.7 Plus",
    endpointId: OPENCODE_GO_ID,
    modelName: "qwen3.7-plus",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    vision: true,
    description: "Multimodal reasoning model for visual analysis, planning, and tool use",
  },
  {
    id: "opencode-go:qwen3.8-flash",
    name: "Qwen3.8 Flash",
    endpointId: OPENCODE_GO_ID,
    modelName: "qwen3.8-flash",
    contextWindow: 1000000,
    maxOutputTokens: 131072,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    vision: true,
    description: "Qwen vision-language model for visual reasoning, documents, and agent tasks",
  },
  {
    id: "opencode-go:qwen3.8-max",
    name: "Qwen3.8 Max",
    endpointId: OPENCODE_GO_ID,
    modelName: "qwen3.8-max",
    contextWindow: 1000000,
    maxOutputTokens: 131072,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    vision: true,
    description:
      "2.4-trillion-parameter multimodal flagship for coding, professional work, and long-horizon agentic workflows",
  },
  {
    id: "opencode-go:qwen4-max",
    name: "Qwen4 Max",
    endpointId: OPENCODE_GO_ID,
    modelName: "qwen4-max",
    // 本端点的首要模型：首启只选服务商时落的就是它（见 `ModelDefinition.primary`）
    primary: true,
    contextWindow: 1000000,
    maxOutputTokens: 262144,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    vision: true,
    description:
      "Flagship multimodal model for coding, office productivity, frontend design, and complex agentic tasks",
  },
  {
    id: "opencode-go:longcat-2.5",
    name: "LongCat-2.5",
    endpointId: OPENCODE_GO_ID,
    modelName: "longcat-2.5",
    contextWindow: 1000000,
    maxOutputTokens: 262144,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    description:
      "Meituan's multimodal reasoning model for long-horizon coding and agent tasks, with visual understanding and a 1M-token context window",
  },
  {
    id: "opencode-go:step-5-preview",
    name: "Step 5 Preview",
    endpointId: OPENCODE_GO_ID,
    modelName: "step-5-preview",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    vision: true,
    description:
      "StepFun's next-generation flagship base model for coding and professional knowledge work, with native text, image, and video input and a 1M-token context window",
  },
  {
    id: "opencode-go:gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    endpointId: OPENCODE_GO_ID,
    modelName: "gpt-5.6-luna",
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    tokenThresholds: { handoff: 420000, guard: 840000 },
    vision: true,
    // 这一条在本端点走 responses 面。不点明要摘要，回包里只有 `reasoning.encrypted`，客户端
    // 拿不到明文思考；`provider_options` 是网关自己给出的作用域写法，域名是 `openai-responses`。
    defaultParams: { provider_options: { "openai-responses": { reasoning: { summary: "auto" } } } },
    description: "Cost-efficient GPT-5.6 model for fast, high-volume workloads",
  },
  {
    id: "opencode-go:gpt-6-luna",
    name: "GPT-6 Luna",
    endpointId: OPENCODE_GO_ID,
    modelName: "gpt-6-luna",
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    tokenThresholds: { handoff: 420000, guard: 840000 },
    vision: true,
    // 同上：不带这一格时思考照跑（usage 里有 reasoning_tokens），但流里只有加密块。
    defaultParams: { provider_options: { "openai-responses": { reasoning: { summary: "auto" } } } },
    description: "OpenAI's most efficient model for focused, high-volume tasks",
  },
  {
    id: "opencode-go:claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    endpointId: OPENCODE_GO_ID,
    modelName: "claude-haiku-5-5",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    tokenThresholds: { handoff: 400000, guard: 800000 },
    vision: true,
    description:
      "Fast Claude model for responsive assistance, classification, and lightweight agents",
  },
];
