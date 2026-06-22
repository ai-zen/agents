import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { AgentNS } from "@ai-zen/agents-core";
import { Config } from "./types.js";
import { migrateRawConfig, ensureVersions } from "./config-migration.js";

// ==================== 默认配置 ====================

export const defaultConfig: Config = {
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
    // ========== OpenAI 系列 ==========
    {
      id: "gpt-5.5",
      name: "GPT-5.5",
      endpointId: "openai",
      modelName: "gpt-5.5",
      description: "OpenAI 最新旗舰模型，擅长编程与代码调试、在线研究、数据分析",
      defaultParams: {},
    },
    // ========== 智谱AI 系列 ==========
    {
      id: "glm-5.1",
      name: "GLM-5.1",
      endpointId: "bigmodelcn",
      modelName: "glm-5.1",
      description: "智谱AI 最新旗舰模型，支持8小时长程Agent任务，综合能力对标Claude Opus 4.6",
      defaultParams: {},
    },
    {
      id: "glm-5v-turbo",
      name: "GLM-5V-Turbo",
      endpointId: "bigmodelcn",
      modelName: "glm-5v-turbo",
      description: "智谱AI 多模态Coding基座，兼顾视觉理解与代码能力",
      defaultParams: {},
    },
    {
      id: "glm-4.7-flash",
      name: "GLM-4.7-Flash",
      endpointId: "bigmodelcn",
      modelName: "glm-4.7-flash",
      description: "智谱AI 免费轻量模型，通用能力同级别最优",
      defaultParams: {},
    },
    // ========== DeepSeek 系列 ==========
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek-V4-Pro",
      endpointId: "deepseek",
      modelName: "deepseek-v4-pro",
      description: "DeepSeek 旗舰模型，Agentic Coding开源第一，100万tokens上下文，1.6万亿参数",
      defaultParams: {
        thinking: { type: "disabled" },
      },
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek-V4-Flash",
      endpointId: "deepseek",
      modelName: "deepseek-v4-flash",
      description: "DeepSeek 经济高效模型，2840亿参数/130亿活跃参数，100万tokens上下文",
      defaultParams: {
        thinking: { type: "disabled" },
      },
    },
  ],
  agents: [],
  subAgents: [],
  defaultModel: "deepseek-v4-flash",
  defaultAgent: "default",
  imageModels: [
    {
      id: "cogview-4",
      name: "CogView-4",
      endpointId: "bigmodelcn",
      modelName: "cogview-4",
      description: "智谱AI CogView-4 图片生成模型，默认 1024x1024",
      defaultSize: "1024x1024",
    },
    {
      id: "glm-image",
      name: "GLM-Image",
      endpointId: "bigmodelcn",
      modelName: "glm-image",
      description: "智谱AI GLM-Image 图片生成模型，默认 1280x1280，仅支持 hd 质量",
      defaultSize: "1280x1280",
      defaultQuality: "hd",
    },
    {
      id: "cogview-3-flash",
      name: "CogView-3-Flash",
      endpointId: "bigmodelcn",
      modelName: "cogview-3-flash",
      description: "智谱AI CogView-3-Flash 快速图片生成模型，默认 1024x1024",
      defaultSize: "1024x1024",
    },
  ],
  defaultImageModel: "cogview-4",
  mcpServers: [],
};

// 配置目录
export const CONFIG_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".ai-zen",
);
export const CONVERSATIONS_DIR = join(CONFIG_DIR, "conversations");
export const AGENTS_DIR = join(CONFIG_DIR, "agents");
export const SUB_AGENTS_DIR = join(CONFIG_DIR, "sub-agents");
export const SKILLS_DIR = join(CONFIG_DIR, "skills");
export const TOOLS_DIR = join(CONFIG_DIR, "tools");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// ==================== 配置管理 ====================

/** 获取当前模块目录（ESM 兼容） */
function getModuleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/** 默认助手的 JSON 内容 */
const DEFAULT_AGENT_JSON = JSON.stringify(
  {
    id: "default",
    name: "默认助手",
    description: "默认的 AI 助手，适用于日常问答和任务执行。",
    messages: [
      {
        role: "system",
        content: "你是一个AI助手，专门帮助用户回答问题和执行任务。请用中文回复。",
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  null,
  2,
);

/** 默认通用助手的 JSON 内容 */
const DEFAULT_GENERAL_ASSISTANT_JSON = JSON.stringify(
  {
    id: "general-assistant",
    name: "通用助手",
    description:
      "一个通用的子 Agent，擅长独立完成各类任务。可被主 Agent 自动调用，也可直接对话使用。",
    system:
      "你是一个通用助手，擅长独立完成各类任务。请根据给定的任务描述，认真分析并完成任务。完成任务后直接返回结果，不要解释你的思考过程。",
    tools: [
      "cwd",
      "readFile",
      "writeFile",
      "batchReplace",
      "mkdir",
      "rm",
      "glob",
      "ls",
      "exist",
      "exec",
      "findText",
      "downloadFile",
      "generateImage",
      "rename",
      "copy",
    ],
  },
  null,
  2,
);

/**
 * 确保配置目录存在，并在首次初始化时写入默认子 Agent 文件
 */
export function ensureConfigDir(): void {
  const isFirstRun = !existsSync(CONFIG_DIR);

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!existsSync(CONVERSATIONS_DIR)) {
    mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  }
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
  }
  if (!existsSync(SUB_AGENTS_DIR)) {
    mkdirSync(SUB_AGENTS_DIR, { recursive: true });
  }
  if (!existsSync(SKILLS_DIR)) {
    mkdirSync(SKILLS_DIR, { recursive: true });
  }
  if (!existsSync(TOOLS_DIR)) {
    mkdirSync(TOOLS_DIR, { recursive: true });
  }

  // 首次运行：写入默认文件
  if (isFirstRun) {
    // 默认普通 Agent
    const defaultAgentPath = join(AGENTS_DIR, "default.json");
    if (!existsSync(defaultAgentPath)) {
      try {
        writeFileSync(defaultAgentPath, DEFAULT_AGENT_JSON, "utf-8");
      } catch (error) {
        console.warn(chalk.yellow(`⚠️  无法写入默认 Agent 文件: ${error}`));
      }
    }

    // 默认子 Agent（通用助手）
    const defaultSubAgentPath = join(SUB_AGENTS_DIR, "general-assistant.json");
    if (!existsSync(defaultSubAgentPath)) {
      try {
        writeFileSync(defaultSubAgentPath, DEFAULT_GENERAL_ASSISTANT_JSON, "utf-8");
      } catch (error) {
        console.warn(chalk.yellow(`⚠️  无法写入默认子 Agent 文件: ${error}`));
      }
    }
  }
}

/**
 * 合并两个数组成员，确保默认项始终存在
 * 以用户保存的配置为主，补充默认配置中新增的项
 */
function mergeArrays<T extends { id: string }>(
  defaultItems: T[],
  savedItems: T[] | undefined,
): T[] {
  const savedIds = new Set((savedItems || []).map((item) => item.id));
  const merged = [...(savedItems || [])];
  for (const defaultItem of defaultItems) {
    if (!savedIds.has(defaultItem.id)) {
      merged.push(defaultItem);
    }
  }
  return merged;
}

export function readConfig(): Config {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    ensureVersions(defaultConfig);
    saveConfig(defaultConfig);
    return defaultConfig;
  }
  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    const saved = JSON.parse(content);

    // 向下兼容：旧配置迁移（migrateRawConfig 直接修改 saved）
    // 传入 AGENTS_DIR 以便将旧 config.json 中的 agents 写入文件系统
    if (migrateRawConfig(saved, AGENTS_DIR)) {
      saveConfig({ ...defaultConfig, ...saved });
    }

    // 浅合并顶层字段
    const config: Config = { ...defaultConfig, ...saved };

    // 合并数组类型字段，确保新版本新增的默认项自动出现
    // 注意：agents 已迁移到文件系统，不再从默认配置合并
    config.subAgents = mergeArrays(defaultConfig.subAgents || [], saved.subAgents);

    // 补充版本号
    ensureVersions(config);

    return config;
  } catch (error) {
    console.error(chalk.red(`读取配置文件失败: ${error}`));
    ensureVersions(defaultConfig);
    return defaultConfig;
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  } catch (error) {
    console.error(chalk.red(`保存配置文件失败: ${error}`));
    throw error;
  }
}
