import { AgentNS, Message } from "@ai-zen/agents-core";
import type { AgentDefinition, AppConfig } from "../types/index.js";

// ---------------------------------------------------------------------------
// 默认 Agent
// ---------------------------------------------------------------------------

/** 默认 Agent ID */
export const DEFAULT_AGENT_ID = "default";

/**
 * 出厂默认模型 id。
 *
 * 模型的**唯一真相源是 `AgentDefinition.modelId`**：配置里不再有 `defaultModel`，
 * 会话存档里也不记模型。这个常量只用于给出厂默认 Agent 填一个初始值。
 */
export const DEFAULT_MODEL_ID = "deepseek-flash";

/** 默认 Agent 定义（不含时间戳） */
export const DEFAULT_AGENT_DEFINITION: Omit<AgentDefinition, "createdAt" | "updatedAt"> = {
  id: DEFAULT_AGENT_ID,
  name: "Default Assistant",
  description: "The default AI assistant, suited for everyday Q&A and task execution.",
  // 模型写在 Agent 定义上，是运行期唯一真相源（无 config.defaultModel 兜底）
  modelId: DEFAULT_MODEL_ID,
  messages: [
    Message.System(`You are a witty, rigorous and reliable assistant. Always reply in the same language the user writes in. Current operating system: ${process.platform}.

1. When user input is needed for a decision, ask only one question at a time.
2. This session runs on Node.js — you can write Node.js scripts to carry out complex tasks and run them via the exec tool.`),
  ],
  // 出厂默认 Agent：custom 为 false，SDK 初始化时会同步出厂提示词（用户设为 true 则跳过）
  custom: false,
  permissions: {
    tools: { allow: ["*"] },
    skills: { allow: ["*"] },
    mcps: { allow: ["*"] },
    subagents: { allow: ["*"] },
  },
};

// ---------------------------------------------------------------------------
// 默认 SubAgent
// ---------------------------------------------------------------------------

/** 默认 SubAgent ID */
export const DEFAULT_SUBAGENT_ID = "sub-agent-default";

/** 默认 SubAgent 定义（不含时间戳） */
export const DEFAULT_SUBAGENT_DEFINITION: Omit<AgentDefinition, "createdAt" | "updatedAt"> = {
  id: DEFAULT_SUBAGENT_ID,
  name: "General Assistant",
  description: "A general-purpose sub-agent that is good at completing all kinds of tasks independently.",
  messages: [
    Message.System("You are a general-purpose assistant sub-agent, delegated by a parent agent to independently complete a specific task. Based on the given task description, proactively call your tools (file read/write, command execution, search, etc.) to analyze and complete the task. When the task is done, return the result directly; there is no need to explain your thinking process.\n\n⚠️ Mandatory requirements:\n1. If anything in the task description is unclear, vague or missing (including but not limited to the specific goal, file paths, constraints, expected deliverables, etc.), you MUST refuse to execute immediately and explicitly list what is unclear or missing, asking the parent agent to provide more complete task context. Do not assume, guess or make up any information on your own.\n2. If the task description contains contradictory information (such as mutually conflicting requirements, inconsistent file paths, contradictory constraints, etc.), you MUST point out the contradiction promptly and require the parent agent to clarify before executing."),
    Message.User("{{task}}"),
  ],
  permissions: {
    tools: { allow: ["*"] },
    skills: { allow: ["*"] },
    mcps: { allow: ["*"] },
    subagents: { deny: ["*"] },
  },
  function: {
    name: "sub_agent_default",
    description:
      "General-purpose sub-agent that can independently complete all kinds of tasks. ⚠️ When delegating a task you must provide complete task context, including all necessary background information, file paths, specific requirements and constraints; any unclear information will cause the sub-agent to refuse execution and ask for more information.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Complete task description; must include all necessary background, goals, constraints and context. Any unclear information will cause the sub-agent to refuse execution." },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
};

// ---------------------------------------------------------------------------
// 默认配置（含预置厂商、模型、图片模型）
// ---------------------------------------------------------------------------

/** SDK 出厂默认 AppConfig。CLI/Desktop 首次初始化时使用。 */
export const DEFAULT_APP_CONFIG: AppConfig = {
  endpoints: [
    {
      id: "openai",
      name: "OpenAI",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      description: "OpenAI API endpoint",
    },
    {
      id: "bigmodelcn",
      name: "BigModelCN (Zhipu AI)",
      apiKey: "",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      description: "Zhipu AI large-model endpoint",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      apiKey: "",
      baseUrl: "https://api.deepseek.com/v1",
      description: "DeepSeek API endpoint (supports the Files API: local files are uploaded and then referenced by file_id)",
      // 唯一声明了 Files API 能力的出厂端点；其余端点本地文件走 base64 内联。
      // 判断依据是能力位而非端点 id，用户自建端点只要声明即可享受上传。
      capabilities: { filesApi: true },
    },
  ],
  // 模型清单（2026-10-03 依据各厂商官方来源核对）：
  //   OpenAI   → openai.com 发布公告 / API 目录（platform 文档站对脚本有访问限制）
  //   智谱     → docs.bigmodel.cn 模型概览/定价 + open.bigmodel.cn/api/paas/v4/models
  //   DeepSeek → api-docs.deepseek.com 定价页与 News + api.deepseek.com/v1/models
  //
  // 更新策略：本清单为「出厂托管」清单。用户 config.json 中凡未标 `custom: true`
  // 的模型（含 imageModels）在初始化时一律被移除并替换为本清单中的最新定义；
  // 标了 `custom: true` 的条目视为用户自有，原样保留。实现见
  // ConfigManager.syncManagedModels。
  //
  // tokenThresholds 的两条线都与模型的真实上下文窗口无关：
  //   handoff（软线，交接触发）与 guard（硬线，请求前强行阻断）。
  // 出厂取值：窗口 ≥1M 的模型统一 handoff=250K / guard=375K（约窗口的 25% / 37.5%），
  // glm-4.7-flash 窗口仅 200K，取 handoff=100K / guard=150K。
  //
  // reasoningPreset：应用层元数据，**SDK 不解释**（既不参与请求参数生成，也不影响运行行为）。
  // 它由客户端（如 CLI）自己定义含义：指向哪张思考档位表、`/think` 能选哪几档。
  // 之所以留在出厂定义里：字段声明与行为消费是两件事，出厂模型需要把它带上，
  // 否则 `syncManagedModels` 会用出厂定义整块覆盖并抹掉应用声明的值。
  // 不写这个字段 = 应用层视作「不可调档」（如 GLM-4.7 强制思考且无 reasoning_effort 参数）。
  models: [
    // ---------- OpenAI ----------
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      endpointId: "openai",
      modelName: "gpt-6-astra",
      tokenThresholds: { handoff: 250_000, guard: 375_000 },
      defaultParams: {},
      vision: true,
      reasoningPreset: "openai",
      description: "OpenAI flagship (2026-09): advanced analysis, software engineering, deep research and scientific work",
    },
    {
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      endpointId: "openai",
      modelName: "gpt-6.1-sol",
      tokenThresholds: { handoff: 250_000, guard: 375_000 },
      defaultParams: {},
      vision: true,
      reasoningPreset: "openai",
      description: "OpenAI latest flagship (2026-09-29): agentic coding, computer operation and document-intensive professional tasks",
    },
    {
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      endpointId: "openai",
      modelName: "gpt-6-luna",
      tokenThresholds: { handoff: 250_000, guard: 375_000 },
      defaultParams: {},
      vision: true,
      reasoningPreset: "openai",
      description: "OpenAI GPT-6 series fast, low-cost model: suited for high-throughput, low-latency scenarios",
    },
    // ---------- 智谱 BigModel ----------
    {
      id: "glm-5.3",
      name: "GLM-5.3",
      endpointId: "bigmodelcn",
      modelName: "glm-5.3",
      tokenThresholds: { handoff: 250_000, guard: 375_000 },
      defaultParams: { thinking: { type: "enabled" }, reasoning_effort: "max" },
      reasoningPreset: "zhipu-5.3",
      description: "Zhipu latest flagship: complex software engineering and long-horizon agent tasks (thinking always on, 1M context)",
    },
    {
      id: "glm-5.3-flash",
      name: "GLM-5.3-Flash",
      endpointId: "bigmodelcn",
      modelName: "glm-5.3-flash",
      tokenThresholds: { handoff: 250_000, guard: 375_000 },
      defaultParams: { thinking: { type: "enabled" }, reasoning_effort: "max" },
      vision: true,
      reasoningPreset: "zhipu-5.3",
      description: "Zhipu native multimodal model (image/video/file): visual coding, 1M context",
    },
    {
      id: "glm-5.3-flashx",
      name: "GLM-5.3-FlashX",
      endpointId: "bigmodelcn",
      modelName: "glm-5.3-flashx",
      tokenThresholds: { handoff: 250_000, guard: 375_000 },
      defaultParams: { thinking: { type: "enabled" }, reasoning_effort: "max" },
      vision: true,
      reasoningPreset: "zhipu-5.3",
      description: "GLM-5.3-Flash high-speed edition (200 tokens/s), native multimodal",
    },
    {
      id: "glm-4.7-flash",
      name: "GLM-4.7-Flash",
      endpointId: "bigmodelcn",
      modelName: "glm-4.7-flash",
      // 该模型真实窗口仅 200K，阈值下调至 100K（约窗口的 50%），留足 response 空间
      tokenThresholds: { handoff: 100_000, guard: 150_000 },
      defaultParams: {},
      description: "Zhipu free text model: 200K context, suited for lightweight tasks",
    },
    // ---------- DeepSeek ----------
    {
      id: "deepseek-flash",
      name: "DeepSeek-V4.1-Flash",
      endpointId: "deepseek",
      modelName: "deepseek-flash",
      tokenThresholds: { handoff: 250_000, guard: 375_000 },
      defaultParams: { thinking: { type: "enabled" } },
      vision: true,
      reasoningPreset: "deepseek",
      description: "DeepSeek flagship (2026-09-10): 552B MoE asymmetric architecture, native multimodal, 1M context",
    },
  ],
  imageModels: [
    {
      id: "cogview-4",
      name: "CogView-4",
      endpointId: "bigmodelcn",
      modelName: "cogview-4",
      defaultSize: "1024x1024",
    },
    {
      id: "glm-image",
      name: "GLM-Image",
      endpointId: "bigmodelcn",
      modelName: "glm-image",
      defaultSize: "1280x1280",
      defaultQuality: "hd",
    },
    {
      id: "cogview-3-flash",
      name: "CogView-3-Flash",
      endpointId: "bigmodelcn",
      modelName: "cogview-3-flash",
      defaultSize: "1024x1024",
    },
  ],
  defaultImageModel: "cogview-4",
  defaultAgent: "default",
  defaultMigrationModel: "deepseek-flash",
  // 工具输出上限（字符数），与 DEFAULT_MAX_TOOL_OUTPUT 保持一致
  maxToolOutput: 32_768,
  // 中断策略：出厂取「保留已输出的内容」—— 中断后模型能接着半截往下说，
  // 而不是「失忆重来」（core 的库级默认是 drop，产品层认为那是坑）；
  // 工具轮次保持整轮进出（fill），服务端要求 tool_calls 与结果一一配对。
  abortedMessageStrategy: "keep",
  abortedToolRoundStrategy: "fill",
};

// ---------------------------------------------------------------------------
// 默认 MCP 配置（socket-pty 终端 MCP + chrome-devtools 浏览器调试 MCP）
// ---------------------------------------------------------------------------

/**
 * SDK 出厂默认 MCP 服务器配置（mcp.json 内容，业界标准格式）。
 * 首次初始化时释放到 ~/.ai-zen/mcp.json，让用户开箱即用：
 *   - socket-pty       伪终端（pty）能力
 *   - chrome-devtools  Chrome DevTools 浏览器调试/自动化能力（Google 官方 chrome-devtools-mcp）
 *
 * 若文件已存在则不覆盖（尊重用户已有配置）。
 */
export const DEFAULT_MCP_CONFIG: { mcpServers: Record<string, unknown> } = {
  mcpServers: {
    "socket-pty": {
      type: "stdio",
      command: "npx",
      args: ["-y", "@ai-zen/socket-pty", "mcp"],
      description: "Manageable pseudo-terminal (pty): spawn/read/wait/write/resize/status/kill",
    },
    "chrome-devtools": {
      type: "stdio",
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
      description: "Chrome DevTools browser debugging and automation (Google chrome-devtools-mcp): page navigation, performance tracing, network and console inspection, screenshots, etc.",
    },
  },
};

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

/**
 * 标准共享子目录列表（不包含运行时目录）。
 *
 * 各客户端（CLI/Desktop）的运行时数据（config.json、conversations/、drafts/）
 * 由客户端自行在各自目录下管理：
 *   ~/.ai-zen/cli/          ← CLI 运行时
 *   ~/.ai-zen/desktop/      ← Desktop 运行时（未来）
 */
export const CONFIG_SUB_DIRS = [
  "agents",
  "sub-agents",
  "skills",
  "tools",
  "mcp-oauth",
] as const;
