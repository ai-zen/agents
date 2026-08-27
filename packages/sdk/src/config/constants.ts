import { AgentNS, Message } from "@ai-zen/agents-core";
import type { AgentDefinition, AppConfig } from "../types/index.js";

// ---------------------------------------------------------------------------
// 默认 Agent
// ---------------------------------------------------------------------------

/** 默认 Agent ID */
export const DEFAULT_AGENT_ID = "default";

/** 默认 Agent 定义（不含时间戳） */
export const DEFAULT_AGENT_DEFINITION: Omit<AgentDefinition, "createdAt" | "updatedAt"> = {
  id: DEFAULT_AGENT_ID,
  name: "默认助手",
  description: "默认的 AI 助手，适用于日常问答和任务执行。",
  messages: [
    Message.System(`你是一个严谨可靠的智能助手。请用中文回复，说话风格参照官方文件。

- 开动脑筋 — 主动思考、灵活运用工具，而不是机械执行
- 实事求是 — 知之为知之，不知为不知，而不是凭空编造；如果用户意图不明确，应先提问澄清，而不是自行脑补
- 一切行动听指挥 — 严格遵循用户指令，而不是自作主张
- 安全第一 — 风险操作先告知确认，而不是盲目执行
- 能打胜仗 — 写优秀的代码，而不是只限于能用的代码
- 有矛盾就问 — 如果用户指令中存在自相矛盾之处，应指出矛盾并请求澄清，而不是自行取舍`),
  ],
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
  name: "通用助手",
  description: "一个通用的子 Agent，擅长独立完成各类任务。",
  messages: [
    Message.System("你是一个通用助手子 Agent，被父 Agent 委派来独立完成具体任务。请根据给定的任务描述，主动调用你的工具（文件读写、执行命令、搜索等）来分析和完成任务。完成任务后直接返回结果，不需要解释你的思考过程。\n\n⚠️ 强制性要求：\n1. 如果任务描述中存在任何不明确、模糊或缺失的信息（包括但不限于具体目标、文件路径、约束条件、预期产出等），你必须直接拒绝执行，并明确列出哪些信息不明确或缺失，要求父 Agent 提供更完整的任务上下文。不得自行假设、猜测或脑补任何信息。\n2. 如果任务描述中存在自相矛盾的信息（如相互冲突的要求、不一致的文件路径、矛盾的约束条件等），你必须及时指出矛盾之处，并要求父 Agent 澄清后再执行。"),
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
      "通用子 Agent，可独立完成各类任务。⚠️ 委派任务时必须提供完整的任务上下文，包括所有必要的背景信息、文件路径、具体要求和约束条件，任何信息不明确将导致子 Agent 拒绝执行并要求补充信息。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "完整的任务描述，必须包含所有必要的背景、目标、约束条件和上下文信息。任何不明确的信息将导致子 Agent 拒绝执行。" },
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
      description: "OpenAI API 端点",
    },
    {
      id: "bigmodelcn",
      name: "BigModelCN (智谱AI)",
      apiKey: "",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      description: "智谱AI大模型端点",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      apiKey: "",
      baseUrl: "https://api.deepseek.com/v1",
      description: "DeepSeek API 端点",
    },
  ],
  models: [
    {
      id: "gpt-5.5",
      name: "GPT-5.5",
      endpointId: "openai",
      modelName: "gpt-5.5",
      maxContextTokens: 250_000,
      defaultParams: {},
      description: "OpenAI 最新旗舰模型，擅长编程与代码调试、在线研究、数据分析",
    },
    {
      id: "glm-5.1",
      name: "GLM-5.1",
      endpointId: "bigmodelcn",
      modelName: "glm-5.1",
      maxContextTokens: 250_000,
      defaultParams: {},
      description: "智谱AI 最新旗舰模型，支持8小时长程Agent任务",
    },
    {
      id: "glm-5v-turbo",
      name: "GLM-5V-Turbo",
      endpointId: "bigmodelcn",
      modelName: "glm-5v-turbo",
      maxContextTokens: 250_000,
      defaultParams: {},
      vision: true,
      description: "智谱AI 多模态Coding基座（支持图片输入）",
    },
    {
      id: "glm-4.7-flash",
      name: "GLM-4.7-Flash",
      endpointId: "bigmodelcn",
      modelName: "glm-4.7-flash",
      maxContextTokens: 250_000,
      defaultParams: {},
      description: "智谱AI 免费轻量模型",
    },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek-V4-Pro",
      endpointId: "deepseek",
      modelName: "deepseek-v4-pro",
      maxContextTokens: 250_000,
      defaultParams: { thinking: { type: "disabled" } },
      description: "DeepSeek 旗舰模型，Agentic Coding开源第一",
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek-V4-Flash",
      endpointId: "deepseek",
      modelName: "deepseek-v4-flash",
      maxContextTokens: 250_000,
      defaultParams: { thinking: { type: "enabled" } },
      description: "DeepSeek 经济高效模型",
    },
    {
      id: "deepseek-v4-flash-vision-exp",
      name: "DeepSeek-V4-Flash-Vision-Exp",
      endpointId: "deepseek",
      modelName: "deepseek-v4-flash-vision-exp",
      maxContextTokens: 250_000,
      defaultParams: { thinking: { type: "enabled" } },
      vision: true,
      description: "DeepSeek 视觉实验模型（支持图片/文件输入）",
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
  defaultModel: "deepseek-v4-flash",
  defaultImageModel: "cogview-4",
  defaultAgent: "default",
  defaultMigrationModel: "deepseek-v4-flash",
};

// ---------------------------------------------------------------------------
// 默认 MCP 配置（socket-pty 终端 MCP）
// ---------------------------------------------------------------------------

/**
 * SDK 出厂默认 MCP 服务器配置（mcp.json 内容，业界标准格式）。
 * 首次初始化时释放到 ~/.ai-zen/mcp.json，让用户开箱即用 socket-pty 终端能力。
 *
 * 若文件已存在则不覆盖（尊重用户已有配置）。
 */
export const DEFAULT_MCP_CONFIG: { mcpServers: Record<string, unknown> } = {
  mcpServers: {
    "socket-pty": {
      type: "stdio",
      command: "npx",
      args: ["-y", "@ai-zen/socket-pty", "mcp"],
      description: "可托管的伪终端（pty）：spawn/read/wait/write/resize/status/kill",
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
