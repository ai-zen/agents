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
    Message.System(`你是一个幽默风趣、严谨可靠的智能助手，请用中文回复。当前操作系统：${process.platform}。

一、需要用户决策时，一次只问一个问题。
二、当前对话基于 Node.js 驱动，你可以编写 Node.js 脚本执行复杂任务，并通过 exec 工具运行。`),
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
  // maxContextTokens 是「任务迁移（交接）触发阈值」，不是模型的真实上下文窗口：
  // 迁移判断只看 API 响应返回的 usage.prompt_tokens。窗口 ≥1M 的模型统一取 250K
  // （约 25%），glm-4.7-flash 窗口仅 200K，取 100K。
  models: [
    // ---------- OpenAI ----------
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      endpointId: "openai",
      modelName: "gpt-6-astra",
      maxContextTokens: 250_000,
      defaultParams: {},
      vision: true,
      description: "OpenAI 最强旗舰（2026-09）：高级分析、软件工程、深度研究与科学工作",
    },
    {
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      endpointId: "openai",
      modelName: "gpt-6.1-sol",
      maxContextTokens: 250_000,
      defaultParams: {},
      vision: true,
      description: "OpenAI 最新旗舰（2026-09-29）：Agentic Coding、计算机操作与文档密集型专业任务",
    },
    {
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      endpointId: "openai",
      modelName: "gpt-6-luna",
      maxContextTokens: 250_000,
      defaultParams: {},
      vision: true,
      description: "OpenAI GPT-6 系列快速低成本模型：适合高吞吐、低延迟场景",
    },
    // ---------- 智谱 BigModel ----------
    {
      id: "glm-5.3",
      name: "GLM-5.3",
      endpointId: "bigmodelcn",
      modelName: "glm-5.3",
      maxContextTokens: 250_000,
      defaultParams: { thinking: { type: "enabled" }, reasoning_effort: "max" },
      description: "智谱最新旗舰：复杂软件工程与长程 Agent 任务（强制开启思考，1M 上下文）",
    },
    {
      id: "glm-5.3-flash",
      name: "GLM-5.3-Flash",
      endpointId: "bigmodelcn",
      modelName: "glm-5.3-flash",
      maxContextTokens: 250_000,
      defaultParams: { thinking: { type: "enabled" }, reasoning_effort: "max" },
      vision: true,
      description: "智谱原生多模态模型（图片/视频/文件）：视觉 Coding，1M 上下文",
    },
    {
      id: "glm-5.3-flashx",
      name: "GLM-5.3-FlashX",
      endpointId: "bigmodelcn",
      modelName: "glm-5.3-flashx",
      maxContextTokens: 250_000,
      defaultParams: { thinking: { type: "enabled" }, reasoning_effort: "max" },
      vision: true,
      description: "GLM-5.3-Flash 高速版（200 tokens/s），原生多模态",
    },
    {
      id: "glm-4.7-flash",
      name: "GLM-4.7-Flash",
      endpointId: "bigmodelcn",
      modelName: "glm-4.7-flash",
      // 该模型真实窗口仅 200K，阈值下调至 100K（约窗口的 50%），留足 response 空间
      maxContextTokens: 100_000,
      defaultParams: {},
      description: "智谱免费文本模型：200K 上下文，适合轻量任务",
    },
    // ---------- DeepSeek ----------
    {
      id: "deepseek-flash",
      name: "DeepSeek-V4.1-Flash",
      endpointId: "deepseek",
      modelName: "deepseek-flash",
      maxContextTokens: 250_000,
      defaultParams: { thinking: { type: "enabled" } },
      vision: true,
      description: "DeepSeek 旗舰（2026-09-10）：552B MoE 非对称架构，原生多模态，1M 上下文",
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
  defaultModel: "deepseek-flash",
  defaultImageModel: "cogview-4",
  defaultAgent: "default",
  defaultMigrationModel: "deepseek-flash",
  // 工具输出上限（字符数），与 DEFAULT_MAX_TOOL_OUTPUT 保持一致
  maxToolOutput: 32_768,
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
