import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Config, Endpoint, Model } from "./types.js";

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
  agents: [
    {
      id: "default",
      name: "默认助手",
      systemPrompt: "你是一个AI助手，专门帮助用户回答问题和执行任务。请用中文回复。",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  defaultModel: "deepseek-v4-flash",
  defaultAgent: "default",
};

// 配置目录
export const CONFIG_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".ai-zen",
);
export const CONVERSATIONS_DIR = join(CONFIG_DIR, "conversations");
export const AGENTS_DIR = join(CONFIG_DIR, "agents");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// ==================== 配置管理 ====================

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!existsSync(CONVERSATIONS_DIR)) {
    mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  }
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
  }
}

export function readConfig(): Config {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    saveConfig(defaultConfig);
    return defaultConfig;
  }
  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    return { ...defaultConfig, ...JSON.parse(content) };
  } catch (error) {
    console.error(chalk.red(`读取配置文件失败: ${error}`));
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
