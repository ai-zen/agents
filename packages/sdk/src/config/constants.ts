import { AgentNS } from "@ai-zen/agents-core";
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
    {
      role: AgentNS.Role.System,
      content: "你是一个AI助手，专门帮助用户回答问题和执行任务。请用中文回复。",
    },
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
    {
      role: AgentNS.Role.System,
      content:
        "你是一个通用助手子 Agent，被父 Agent 委派来独立完成具体任务。请根据给定的任务描述，主动调用你的工具（文件读写、执行命令、搜索等）来分析和完成任务。完成任务后直接返回结果，不需要解释你的思考过程。",
    },
    { role: AgentNS.Role.User, content: "{{task}}" },
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
      "通用子 Agent，可独立完成各类任务。将任务委派给它后，它会自主调用自身工具（文件读写、代码执行、搜索等）来完成任务并返回结果。适合处理需要多步骤执行、工具调用的复杂任务。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "任务描述" },
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
      description: "智谱AI 多模态Coding基座",
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
      defaultParams: { thinking: { type: "disabled" } },
      description: "DeepSeek 经济高效模型",
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
