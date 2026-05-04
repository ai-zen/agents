#!/usr/bin/env node

import { Command } from "commander";
import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { Agent, AgentNS, OpenAI, ChatGPT } from "@ai-zen/agents-core";
import { allTools } from "./tools.js";
// import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 配置目录
const CONFIG_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".ai-zen",
);
const CONVERSATIONS_DIR = join(CONFIG_DIR, "conversations");
const AGENTS_DIR = join(CONFIG_DIR, "agents");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// ==================== 类型定义 ====================

interface Endpoint {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  description?: string;
}

interface ModelParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

interface Model {
  id: string;
  name: string;
  endpointId: string;
  modelName: string;
  description?: string;
  defaultParams?: ModelParams;
}

interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  modelId?: string;
  createdAt: string;
  updatedAt: string;
}

interface Config {
  endpoints: Endpoint[];
  models: Model[];
  agents: AgentConfig[];
  defaultModel?: string;
  defaultAgent?: string;
}

// ==================== 默认配置 ====================

const defaultConfig: Config = {
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
      description:
        "OpenAI 最新旗舰模型，擅长编程与代码调试、在线研究、数据分析",
      defaultParams: {
        temperature: 0.7,
        maxTokens: 8192,
      },
    },
    // ========== 智谱AI 系列 ==========
    {
      id: "glm-5.1",
      name: "GLM-5.1",
      endpointId: "bigmodelcn",
      modelName: "glm-5.1",
      description:
        "智谱AI 最新旗舰模型，支持8小时长程Agent任务，综合能力对标Claude Opus 4.6",
      defaultParams: {
        temperature: 0.7,
        maxTokens: 8192,
      },
    },
    {
      id: "glm-5v-turbo",
      name: "GLM-5V-Turbo",
      endpointId: "bigmodelcn",
      modelName: "glm-5v-turbo",
      description: "智谱AI 多模态Coding基座，兼顾视觉理解与代码能力",
      defaultParams: {
        temperature: 0.7,
        maxTokens: 4096,
      },
    },
    {
      id: "glm-4.7-flash",
      name: "GLM-4.7-Flash",
      endpointId: "bigmodelcn",
      modelName: "glm-4.7-flash",
      description: "智谱AI 免费轻量模型，通用能力同级别最优",
      defaultParams: {
        temperature: 0.7,
        maxTokens: 4096,
      },
    },
    // ========== DeepSeek 系列 ==========
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek-V4-Pro",
      endpointId: "deepseek",
      modelName: "deepseek-v4-pro",
      description:
        "DeepSeek 旗舰模型，Agentic Coding开源第一，100万tokens上下文，1.6万亿参数",
      defaultParams: {
        temperature: 0.7,
        maxTokens: 8192,
      },
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek-V4-Flash",
      endpointId: "deepseek",
      modelName: "deepseek-v4-flash",
      description:
        "DeepSeek 经济高效模型，2840亿参数/130亿活跃参数，100万tokens上下文",
      defaultParams: {
        temperature: 0.7,
        maxTokens: 4096,
      },
    },
  ],
  agents: [
    {
      id: "default",
      name: "默认助手",
      systemPrompt:
        "你是一个AI助手，专门帮助用户回答问题和执行任务。请用中文回复。",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  defaultModel: "deepseekv4flash",
  defaultAgent: "default",
};

// ==================== 配置管理 ====================

function ensureConfigDir(): void {
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

function readConfig(): Config {
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

function saveConfig(config: Config): void {
  ensureConfigDir();
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  } catch (error) {
    console.error(chalk.red(`保存配置文件失败: ${error}`));
    throw error;
  }
}

// ==================== 端点管理 ====================

function getEndpoint(endpointId: string): Endpoint | undefined {
  const config = readConfig();
  return config.endpoints.find((e) => e.id === endpointId);
}

function getEndpoints(): Endpoint[] {
  const config = readConfig();
  return config.endpoints;
}

function upsertEndpoint(endpoint: Endpoint): void {
  const config = readConfig();
  const index = config.endpoints.findIndex((e) => e.id === endpoint.id);
  if (index >= 0) {
    config.endpoints[index] = endpoint;
  } else {
    config.endpoints.push(endpoint);
  }
  saveConfig(config);
}

function deleteEndpoint(endpointId: string): void {
  const config = readConfig();
  config.endpoints = config.endpoints.filter((e) => e.id !== endpointId);
  saveConfig(config);
}

// ==================== 模型管理 ====================

function getModel(modelId: string): Model | undefined {
  const config = readConfig();
  return config.models.find((m) => m.id === modelId);
}

function getModels(): Model[] {
  const config = readConfig();
  return config.models;
}

function getDefaultModel(): Model | undefined {
  const config = readConfig();
  if (config.defaultModel) {
    return getModel(config.defaultModel);
  }
  return config.models.length > 0 ? config.models[0] : undefined;
}

function setDefaultModel(modelId: string): void {
  const config = readConfig();
  if (!config.models.find((m) => m.id === modelId)) {
    throw new Error(`模型 ${modelId} 不存在`);
  }
  config.defaultModel = modelId;
  saveConfig(config);
}

function upsertModel(model: Model): void {
  const config = readConfig();
  const index = config.models.findIndex((m) => m.id === model.id);
  if (index >= 0) {
    config.models[index] = model;
  } else {
    config.models.push(model);
  }
  saveConfig(config);
}

function deleteModel(modelId: string): void {
  const config = readConfig();
  config.models = config.models.filter((m) => m.id !== modelId);
  saveConfig(config);
}

function getModelsByEndpoint(endpointId: string): Model[] {
  const config = readConfig();
  return config.models.filter((m) => m.endpointId === endpointId);
}

// ==================== Agent 管理 ====================

function getAgent(agentId: string): AgentConfig | undefined {
  const config = readConfig();
  return config.agents.find((a) => a.id === agentId);
}

function getAgents(): AgentConfig[] {
  const config = readConfig();
  return config.agents;
}

function getDefaultAgent(): AgentConfig | undefined {
  const config = readConfig();
  if (config.defaultAgent) {
    return getAgent(config.defaultAgent);
  }
  return config.agents.length > 0 ? config.agents[0] : undefined;
}

function setDefaultAgent(agentId: string): void {
  const config = readConfig();
  if (!config.agents.find((a) => a.id === agentId)) {
    throw new Error(`Agent ${agentId} 不存在`);
  }
  config.defaultAgent = agentId;
  saveConfig(config);
}

function upsertAgent(agent: AgentConfig): void {
  const config = readConfig();
  const index = config.agents.findIndex((a) => a.id === agent.id);
  if (index >= 0) {
    config.agents[index] = agent;
  } else {
    config.agents.push(agent);
  }
  saveConfig(config);
}

function deleteAgent(agentId: string): void {
  const config = readConfig();
  config.agents = config.agents.filter((a) => a.id !== agentId);
  saveConfig(config);
}

// ==================== 对话管理 ====================

interface ConversationData {
  id: string;
  name: string;
  modelId: string;
  agentId?: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentNS.Message[];
  messageCount: number;
}

function getConversationsList(): ConversationData[] {
  ensureConfigDir();
  const conversations: ConversationData[] = [];

  if (!existsSync(CONVERSATIONS_DIR)) return conversations;

  const files = readdirSync(CONVERSATIONS_DIR);

  for (const file of files) {
    if (file.endsWith(".json")) {
      const filePath = join(CONVERSATIONS_DIR, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const data = JSON.parse(content);
        conversations.push({
          id: file.replace(".json", ""),
          name: data.name || file.replace(".json", ""),
          modelId: data.modelId || "unknown",
          agentId: data.agentId,
          createdAt: data.createdAt || new Date().toISOString(),
          updatedAt:
            data.updatedAt || data.createdAt || new Date().toISOString(),
          messages: data.messages || [],
          messageCount: (data.messages || []).length,
        });
      } catch (error) {
        console.error(
          chalk.red(`Error reading conversation file ${file}: ${error}`),
        );
      }
    }
  }

  // 按更新时间排序
  return conversations.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

function saveConversation(
  name: string,
  messages: AgentNS.Message[],
  modelId: string,
  existingId?: string,
  agentId?: string,
): string {
  ensureConfigDir();
  const id =
    existingId ||
    name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_") + "_" + Date.now();
  const filePath = join(CONVERSATIONS_DIR, `${id}.json`);

  const data = {
    name,
    id,
    modelId,
    agentId,
    createdAt: existingId ? undefined : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages,
  };

  // 如果是更新现有对话，保留创建时间
  if (existingId) {
    const existingPath = join(CONVERSATIONS_DIR, `${existingId}.json`);
    if (existsSync(existingPath)) {
      const existingData = JSON.parse(readFileSync(existingPath, "utf-8"));
      data.createdAt = existingData.createdAt;
    }
  }

  writeFileSync(filePath, JSON.stringify(data, null, 2));
  return id;
}

function loadConversation(id: string): ConversationData {
  ensureConfigDir();
  const filePath = join(CONVERSATIONS_DIR, `${id}.json`);

  if (!existsSync(filePath)) {
    throw new Error(`对话 ${id} 不存在`);
  }

  const content = readFileSync(filePath, "utf-8");
  const data = JSON.parse(content);
  return {
    id: data.id,
    name: data.name,
    modelId: data.modelId,
    agentId: data.agentId,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messages: data.messages,
    messageCount: (data.messages || []).length,
  };
}

function deleteConversation(id: string): void {
  ensureConfigDir();
  const filePath = join(CONVERSATIONS_DIR, `${id}.json`);

  if (!existsSync(filePath)) {
    throw new Error(`对话 ${id} 不存在`);
  }

  unlinkSync(filePath);
}

// ==================== Agent 创建 ====================

async function createAgent(
  modelId: string,
  messages?: AgentNS.Message[],
  overrideParams?: ModelParams,
): Promise<Agent> {
  // 获取模型配置
  const modelConfig = getModel(modelId);
  if (!modelConfig) {
    throw new Error(`模型 ${modelId} 不存在`);
  }

  // 获取端点配置
  const endpointConfig = getEndpoint(modelConfig.endpointId);
  if (!endpointConfig) {
    throw new Error(`端点 ${modelConfig.endpointId} 不存在，请先配置端点`);
  }

  // 检查 API Key
  if (!endpointConfig.apiKey) {
    throw new Error(
      `端点 ${endpointConfig.name} 的 API Key 未设置，请使用 "aiz config set-key" 设置`,
    );
  }

  // 创建 OpenAI 端点
  const endpoint = new OpenAI({
    openai_endpoint: endpointConfig.baseUrl,
    api_key: endpointConfig.apiKey,
  });

  // 合并默认参数和覆盖参数
  const params = {
    ...modelConfig.defaultParams,
    ...overrideParams,
  };

  // 创建模型
  const model = new ChatGPT({
    model_config: {
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      top_p: params.topP,
      frequency_penalty: params.frequencyPenalty,
      presence_penalty: params.presencePenalty,
    },
    request_config: await endpoint.chatCompletion(modelConfig.modelName),
  });

  // 创建 Agent
  const agent = new Agent({
    model: model,
    messages: messages || [
      {
        role: AgentNS.Role.System,
        content: "完成任务后立即汇报，不要输出多余的内容，不要解释",
      },
    ],
    tools: [...allTools],
  });

  agent.events.on("run", (messages: AgentNS.Message[]) => {
    const lastMessage = messages[messages.length - 2];
    if (lastMessage?.tool_calls?.length || lastMessage?.function_call) {
      console.log(
        "\n",
        chalk.yellowBright(`🔧 执行工具: `),
        "\n",
        lastMessage,
        "\n",
      );
    }

    const lastToolMessage = messages[messages.length - 1];
    if (lastToolMessage?.role === "tool") {
      console.log(
        "\n",
        chalk.yellowBright(`🔧 工具输出: `),
        "\n",
        lastToolMessage,
        "\n",
      );
    }
  });

  return agent;
}

// ==================== 对话交互 ====================

async function runConversation(
  agent: Agent,
  modelId: string,
  conversationId?: string,
  conversationName?: string,
  agentId?: string,
): Promise<void> {
  console.log(chalk.blue.bold("\n" + "=".repeat(60)));
  console.log(
    chalk.blue.bold(
      "  对话已开始 (输入 'exit' 退出, 'save' 保存, 'clear' 清屏)",
    ),
  );
  console.log(chalk.blue.bold("=".repeat(60) + "\n"));

  let shouldContinue = true;
  let currentName =
    conversationName || `对话_${new Date().toLocaleDateString()}_${Date.now()}`;
  let currentId = conversationId;

  while (shouldContinue) {
    const { question } = await inquirer.prompt([
      {
        type: "input",
        name: "question",
        message: chalk.cyan("你:"),
        prefix: "💬",
      },
    ]);

    const trimmedQuestion = question.trim();

    // 处理命令
    if (
      trimmedQuestion.toLowerCase() === "exit" ||
      trimmedQuestion.toLowerCase() === "quit"
    ) {
      // 询问是否保存
      if (agent.messages.length > 1) {
        const { saveBeforeExit } = await inquirer.prompt([
          {
            type: "confirm",
            name: "saveBeforeExit",
            message: "退出前是否保存当前对话?",
            default: true,
          },
        ]);

        if (saveBeforeExit) {
          try {
            currentId = saveConversation(
              currentName,
              agent.messages,
              modelId,
              currentId,
              agentId,
            );
            console.log(
              chalk.green(
                `\n✅ 对话已保存: ${currentName} (ID: ${currentId})\n`,
              ),
            );
          } catch (error) {
            console.error(chalk.red(`\n❌ 保存失败: ${error}\n`));
          }
        }
      }
      shouldContinue = false;
      break;
    }

    if (trimmedQuestion.toLowerCase() === "save") {
      const { name } = await inquirer.prompt([
        {
          type: "input",
          name: "name",
          message: "对话名称:",
          default: currentName,
        },
      ]);

      try {
        currentName = name;
        currentId = saveConversation(
          currentName,
          agent.messages,
          modelId,
          currentId,
          agentId,
        );
        console.log(
          chalk.green(`\n✅ 对话已保存: ${currentName} (ID: ${currentId})\n`),
        );
      } catch (error) {
        console.error(chalk.red(`\n❌ 保存失败: ${error}\n`));
      }
      continue;
    }

    if (trimmedQuestion.toLowerCase() === "clear") {
      console.clear();
      console.log(chalk.blue.bold("\n" + "=".repeat(60)));
      console.log(chalk.blue.bold("  屏幕已清空"));
      console.log(chalk.blue.bold("=".repeat(60) + "\n"));
      continue;
    }

    if (trimmedQuestion.toLowerCase() === "history") {
      console.log(chalk.yellow.bold("\n📋 对话历史:"));
      for (let i = 0; i < agent.messages.length; i++) {
        const msg = agent.messages[i];
        if (msg.role === AgentNS.Role.User) {
          console.log(chalk.cyan(`👤 你: ${msg.content}`));
        } else if (msg.role === AgentNS.Role.Assistant) {
          const content =
            typeof msg.content === "string"
              ? msg.content.substring(0, 100) +
                (msg.content.length > 100 ? "..." : "")
              : "[复杂内容]";
          console.log(chalk.green(`🤖 AI: ${content}`));
        }
      }
      console.log();
      continue;
    }

    if (!trimmedQuestion) continue;

    // 发送问题并获取回答
    const spinner = ora({
      text: chalk.yellow("AI 正在思考..."),
      spinner: "dots",
    }).start();

    try {
      const messages = await agent.send(trimmedQuestion);
      spinner.stop();

      // 获取最后一条助手消息
      const lastAssistantMessage = messages
        .filter((m) => m.role === AgentNS.Role.Assistant)
        .pop();

      if (lastAssistantMessage) {
        console.log(chalk.green.bold("\n🤖 AI:"));
        if (typeof lastAssistantMessage.content === "string") {
          // 格式化输出，支持代码块
          console.log(formatMessage(lastAssistantMessage.content));
        } else if (Array.isArray(lastAssistantMessage.content)) {
          for (const section of lastAssistantMessage.content) {
            if (section.type === "text") {
              console.log(formatMessage(section.text));
            } else if (section.type === "image_url") {
              console.log(chalk.yellow(`[图片: ${section.image_url.url}]`));
            }
          }
        }
      }

      console.log();
    } catch (error: any) {
      spinner.stop();
      console.error(chalk.red(`\n❌ 发生错误: ${error.message || error}\n`));

      // 如果是 API Key 的问题，提示用户设置
      if (
        error.message?.includes("API Key") ||
        error.message?.includes("401") ||
        error.message?.includes("403")
      ) {
        console.log(
          chalk.yellow(
            "💡 提示: 请使用 'aiz config set-key' 设置正确的 API Key\n",
          ),
        );
      }
    }
  }

  console.log(chalk.blue.bold("\n👋 再见！\n"));
}

function formatMessage(content: string): string {
  // 简单的格式化，高亮代码块
  const lines = content.split("\n");
  let inCodeBlock = false;
  let formatted = "";

  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      formatted += chalk.gray(line) + "\n";
    } else if (inCodeBlock) {
      formatted += chalk.yellow(line) + "\n";
    } else {
      formatted += line + "\n";
    }
  }

  return formatted;
}

// ==================== 交互式配置向导 ====================

async function ensureEndpointConfig(modelId?: string): Promise<Model> {
  let model: Model | undefined;

  if (modelId) {
    model = getModel(modelId);
    if (!model) {
      throw new Error(`模型 ${modelId} 不存在`);
    }
  } else {
    model = getDefaultModel();
    if (!model) {
      throw new Error("没有可用的模型");
    }
  }

  const endpoint = getEndpoint(model.endpointId);
  if (!endpoint) {
    throw new Error(`端点 ${model.endpointId} 不存在`);
  }

  if (!endpoint.apiKey) {
    console.log(
      chalk.yellow.bold(`\n⚠️  端点 "${endpoint.name}" 的 API Key 未设置\n`),
    );
    console.log(chalk.white(`💡 请前往对应平台获取 API Key:`));
    console.log(
      chalk.white(`   - OpenAI: https://platform.openai.com/api-keys`),
    );
    console.log(
      chalk.white(
        `   - BigModelCN (智谱AI): https://open.bigmodel.cn/usercenter/apikeys`,
      ),
    );
    console.log(
      chalk.white(`   - DeepSeek: https://platform.deepseek.com/api_keys\n`),
    );

    const { apiKey, saveKey } = await inquirer.prompt([
      {
        type: "password",
        name: "apiKey",
        message: `请输入 ${endpoint.name} 的 API Key:`,
        mask: "*",
        validate: (input) => input.trim() !== "" || "API Key 不能为空",
      },
      {
        type: "confirm",
        name: "saveKey",
        message: "是否保存此 API Key 以便下次使用?",
        default: true,
      },
    ]);

    // 更新端点的 API Key
    const updatedEndpoint = { ...endpoint, apiKey };
    upsertEndpoint(updatedEndpoint);

    if (saveKey) {
      console.log(chalk.green(`\n✅ API Key 已保存\n`));
    }
  }

  return model;
}

// ==================== 主程序 ====================

const program = new Command();

program
  .name("aiz")
  .description("🤖 AI Agent 命令行工具 - 支持 OpenAI、BigModelCN、DeepSeek")
  .version("0.0.3");

// ==================== 对话命令 ====================

program
  .command("chat")
  .description("开始一个新的对话")
  .option("-m, --model <model-id>", "指定模型 ID")
  .option("-l, --load <id>", "加载已保存的对话")
  .option("-a, --agent <agent-id>", "使用指定的 Agent")
  .option("-t, --temperature <number>", "设置温度参数")
  .option("--max-tokens <number>", "设置最大令牌数")
  .action(async (options) => {
    try {
      let model: Model;
      let systemPrompt: string | undefined;
      let agentId: string | undefined;

      // 处理 Agent 配置
      if (options.agent) {
        const agent = getAgent(options.agent);
        if (!agent) {
          console.error(chalk.red(`\n❌ Agent "${options.agent}" 不存在\n`));
          process.exit(1);
        }
        systemPrompt = agent.systemPrompt;
        agentId = agent.id;

        // 如果 Agent 有默认模型，优先使用
        if (agent.modelId && !options.model) {
          options.model = agent.modelId;
        }
      }

      // 确保端点配置正确
      model = await ensureEndpointConfig(options.model);

      // 如果用户指定了模型但端点未配置，重新获取模型
      if (options.model) {
        model = await ensureEndpointConfig(options.model);
      }

      // 准备覆盖参数
      const overrideParams: ModelParams = {};
      if (options.temperature !== undefined) {
        overrideParams.temperature = parseFloat(options.temperature);
      }
      if (options.maxTokens !== undefined) {
        overrideParams.maxTokens = parseInt(options.maxTokens);
      }

      let agent: Agent;
      let conversationId: string | undefined;
      let conversationName: string | undefined;

      if (options.load) {
        try {
          const conversation = loadConversation(options.load);
          agent = await createAgent(
            conversation.modelId || model.id,
            conversation.messages,
            overrideParams,
          );
          conversationId = conversation.id;
          conversationName = conversation.name;
          agentId = conversation.agentId || agentId;
          console.log(chalk.green(`\n✅ 已加载对话: ${conversation.name}\n`));
        } catch (error) {
          console.error(chalk.red(`\n❌ 加载对话失败: ${error}\n`));
          process.exit(1);
        }
      } else {
        const messages: AgentNS.Message[] = systemPrompt
          ? [{ role: AgentNS.Role.System, content: systemPrompt }]
          : [];
        agent = await createAgent(model.id, messages, overrideParams);
      }

      await runConversation(
        agent,
        model.id,
        conversationId,
        conversationName,
        agentId,
      );
    } catch (error: any) {
      console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
      process.exit(1);
    }
  });

// ==================== 对话管理命令 ====================

const conversationsCommand = program
  .command("conversations")
  .alias("conv")
  .description("管理对话");

conversationsCommand
  .command("list")
  .alias("ls")
  .description("列出所有已保存的对话")
  .option("-n, --number <number>", "显示最近 N 条对话")
  .action((options) => {
    let conversations = getConversationsList();

    if (options.number) {
      conversations = conversations.slice(0, parseInt(options.number));
    }

    if (conversations.length === 0) {
      console.log(chalk.yellow("\n📭 没有已保存的对话\n"));
      return;
    }

    console.log(chalk.blue.bold("\n📋 已保存的对话:\n"));
    console.log(chalk.gray("─".repeat(80)));

    for (const conversation of conversations) {
      const date = new Date(conversation.createdAt).toLocaleString("zh-CN");
      const updateDate = new Date(conversation.updatedAt).toLocaleString(
        "zh-CN",
      );

      console.log(chalk.white.bold(`  📝 ${conversation.name}`));
      console.log(chalk.gray(`     ID: ${conversation.id}`));
      console.log(chalk.gray(`     模型: ${conversation.modelId}`));
      console.log(chalk.gray(`     消息数: ${conversation.messageCount}`));
      console.log(chalk.gray(`     创建时间: ${date}`));
      console.log(chalk.gray(`     更新时间: ${updateDate}`));
      console.log(chalk.gray("─".repeat(80)));
    }
  });

conversationsCommand
  .command("load <id>")
  .description("从保存的对话继续")
  .option("-m, --model <model-id>", "切换模型")
  .action(async (id, options) => {
    try {
      const conversation = loadConversation(id);
      console.log(chalk.green(`\n✅ 已加载对话: ${conversation.name}\n`));

      const modelId = options.model || conversation.modelId;
      const model = await ensureEndpointConfig(modelId);
      const agent = await createAgent(model.id, conversation.messages);

      await runConversation(
        agent,
        model.id,
        conversation.id,
        conversation.name,
        conversation.agentId,
      );
    } catch (error: any) {
      console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
      process.exit(1);
    }
  });

conversationsCommand
  .command("delete <id>")
  .description("删除指定的对话")
  .action(async (id) => {
    try {
      const conversation = loadConversation(id);
      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: `确定要删除对话 "${conversation.name}" 吗?`,
          default: false,
        },
      ]);

      if (confirm) {
        deleteConversation(id);
        console.log(chalk.green(`\n✅ 对话 "${conversation.name}" 已删除\n`));
      }
    } catch (error: any) {
      console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
      process.exit(1);
    }
  });

// ==================== Agent 管理命令 ====================

const agentsCommand = program
  .command("agents")
  .alias("agent")
  .description("管理 Agents");

agentsCommand
  .command("list")
  .alias("ls")
  .description("列出所有 Agents")
  .action(() => {
    const agents = getAgents();

    if (agents.length === 0) {
      console.log(chalk.yellow("\n📭 没有可用的 Agent\n"));
      return;
    }

    const defaultAgent = getDefaultAgent();

    console.log(chalk.blue.bold("\n🤖 可用的 Agents:\n"));
    console.log(chalk.gray("─".repeat(80)));

    for (const agent of agents) {
      const isDefault = defaultAgent?.id === agent.id;
      const date = new Date(agent.createdAt).toLocaleString("zh-CN");

      console.log(
        chalk.white.bold(
          `  ${isDefault ? "⭐ " : "  "}${agent.name} ${isDefault ? "(默认)" : ""}`,
        ),
      );
      console.log(chalk.gray(`     ID: ${agent.id}`));
      if (agent.description) {
        console.log(chalk.gray(`     描述: ${agent.description}`));
      }
      console.log(
        chalk.gray(`     系统提示: ${agent.systemPrompt.substring(0, 80)}...`),
      );
      console.log(chalk.gray(`     创建时间: ${date}`));
      console.log(chalk.gray("─".repeat(80)));
    }
  });

agentsCommand
  .command("create")
  .description("创建新的 Agent")
  .action(async () => {
    try {
      const { name, description, systemPrompt, modelId } =
        await inquirer.prompt([
          {
            type: "input",
            name: "name",
            message: "Agent 名称:",
            validate: (input) => input.trim() !== "" || "名称不能为空",
          },
          {
            type: "input",
            name: "description",
            message: "描述 (可选):",
          },
          {
            type: "editor",
            name: "systemPrompt",
            message: "系统提示 (在编辑器中输入):",
            default: "你是一个AI助手，请用中文回复。",
          },
          {
            type: "list",
            name: "modelId",
            message: "默认模型:",
            choices: [
              ...getModels().map((m) => ({
                name: `${m.name} (${m.id})`,
                value: m.id,
              })),
              { name: "使用全局默认模型", value: "" },
            ],
          },
        ]);

      const id = name
        .toLowerCase()
        .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_");
      const now = new Date().toISOString();

      const agent: AgentConfig = {
        id,
        name,
        description,
        systemPrompt,
        modelId: modelId || undefined,
        createdAt: now,
        updatedAt: now,
      };

      upsertAgent(agent);
      console.log(chalk.green(`\n✅ Agent "${name}" 创建成功!\n`));
      console.log(chalk.white(`可以使用: aiz chat -a ${id}\n`));
    } catch (error: any) {
      console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
    }
  });

agentsCommand
  .command("edit <id>")
  .description("编辑 Agent")
  .action(async (id) => {
    try {
      const agent = getAgent(id);
      if (!agent) {
        throw new Error(`Agent "${id}" 不存在`);
      }

      const { name, description, systemPrompt, modelId } =
        await inquirer.prompt([
          {
            type: "input",
            name: "name",
            message: "Agent 名称:",
            default: agent.name,
          },
          {
            type: "input",
            name: "description",
            message: "描述:",
            default: agent.description || "",
          },
          {
            type: "editor",
            name: "systemPrompt",
            message: "系统提示:",
            default: agent.systemPrompt,
          },
          {
            type: "list",
            name: "modelId",
            message: "默认模型:",
            choices: [
              ...getModels().map((m) => ({
                name: `${m.name} (${m.id})`,
                value: m.id,
              })),
              { name: "使用全局默认模型", value: "" },
            ],
            default: agent.modelId || "",
          },
        ]);

      const updatedAgent: AgentConfig = {
        ...agent,
        name,
        description,
        systemPrompt,
        modelId: modelId || undefined,
        updatedAt: new Date().toISOString(),
      };

      upsertAgent(updatedAgent);
      console.log(chalk.green(`\n✅ Agent "${name}" 已更新\n`));
    } catch (error: any) {
      console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
    }
  });

agentsCommand
  .command("delete <id>")
  .description("删除 Agent")
  .action(async (id) => {
    try {
      const agent = getAgent(id);
      if (!agent) {
        throw new Error(`Agent "${id}" 不存在`);
      }

      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: `确定要删除 Agent "${agent.name}" 吗?`,
          default: false,
        },
      ]);

      if (confirm) {
        deleteAgent(id);
        console.log(chalk.green(`\n✅ Agent "${agent.name}" 已删除\n`));
      }
    } catch (error: any) {
      console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
    }
  });

agentsCommand
  .command("set-default <id>")
  .description("设置默认 Agent")
  .action((id) => {
    try {
      setDefaultAgent(id);
      const agent = getAgent(id);
      console.log(chalk.green(`\n✅ 默认 Agent 已设置为 "${agent?.name}"\n`));
    } catch (error: any) {
      console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
    }
  });

// ==================== 配置命令 ====================

const configCommand = program
  .command("config")
  .description("管理端点和模型配置");

configCommand
  .command("show")
  .description("查看当前配置")
  .action(() => {
    const config = readConfig();

    console.log(chalk.blue.bold("\n📋 当前配置:\n"));

    // 显示默认模型
    const defaultModel = getDefaultModel();
    console.log(chalk.white.bold("默认模型:"));
    if (defaultModel) {
      console.log(
        chalk.green(`  ⭐ ${defaultModel.name} (${defaultModel.id})`),
      );
      console.log(chalk.gray(`     端点: ${defaultModel.endpointId}`));
      console.log(chalk.gray(`     模型名: ${defaultModel.modelName}`));
    }
    console.log();

    // 显示默认 Agent
    const defaultAgent = getDefaultAgent();
    console.log(chalk.white.bold("默认 Agent:"));
    if (defaultAgent) {
      console.log(
        chalk.green(`  ⭐ ${defaultAgent.name} (${defaultAgent.id})`),
      );
    }
    console.log();

    // 显示端点
    console.log(chalk.white.bold("端点:"));
    console.log(chalk.gray("─".repeat(60)));
    for (const endpoint of config.endpoints) {
      const maskedKey = endpoint.apiKey
        ? endpoint.apiKey.substring(0, 8) +
          "..." +
          endpoint.apiKey.substring(endpoint.apiKey.length - 4)
        : chalk.red("未设置");
      const isConfigured = endpoint.apiKey
        ? chalk.green("✅")
        : chalk.red("❌");

      console.log(
        chalk.white(`  ${endpoint.name} (${endpoint.id}) ${isConfigured}`),
      );
      console.log(chalk.gray(`     API Key: ${maskedKey}`));
      console.log(chalk.gray(`     Base URL: ${endpoint.baseUrl}`));
      if (endpoint.description) {
        console.log(chalk.gray(`     描述: ${endpoint.description}`));
      }

      // 显示使用此端点的模型
      const models = getModelsByEndpoint(endpoint.id);
      if (models.length > 0) {
        console.log(
          chalk.gray(`     模型: ${models.map((m) => m.name).join(", ")}`),
        );
      }
      console.log(chalk.gray("─".repeat(60)));
    }

    // 显示模型
    console.log(chalk.white.bold("\n模型:"));
    console.log(chalk.gray("─".repeat(60)));
    for (const model of config.models) {
      const endpoint = getEndpoint(model.endpointId);
      const endpointName = endpoint ? endpoint.name : "未知";
      const isDefault = config.defaultModel === model.id;

      console.log(
        chalk.white(`  ${isDefault ? "⭐ " : "  "}${model.name} (${model.id})`),
      );
      console.log(chalk.gray(`     端点: ${endpointName}`));
      console.log(chalk.gray(`     模型名: ${model.modelName}`));
      if (model.description) {
        console.log(chalk.gray(`     描述: ${model.description}`));
      }
      console.log(chalk.gray("─".repeat(60)));
    }

    // 显示配置文件路径
    console.log(chalk.gray(`\n配置文件: ${CONFIG_FILE}\n`));
  });

configCommand
  .command("set-key")
  .description("设置端点的 API Key")
  .option("-e, --endpoint <endpoint-id>", "端点 ID")
  .action(async (options) => {
    try {
      let endpoint: Endpoint | undefined;

      if (options.endpoint) {
        endpoint = getEndpoint(options.endpoint);
        if (!endpoint) {
          throw new Error(`端点 ${options.endpoint} 不存在`);
        }
      } else {
        const endpoints = getEndpoints();
        const { endpointId } = await inquirer.prompt([
          {
            type: "list",
            name: "endpointId",
            message: "选择端点:",
            choices: endpoints.map((e) => ({
              name: `${e.name} (${e.id}) ${e.apiKey ? "✅" : "❌"}`,
              value: e.id,
            })),
          },
        ]);
        endpoint = getEndpoint(endpointId);
      }

      if (!endpoint) throw new Error("端点不存在");

      const { apiKey } = await inquirer.prompt([
        {
          type: "password",
          name: "apiKey",
          message: `输入 ${endpoint.name} 的 API Key:`,
          mask: "*",
          validate: (input) => input.trim() !== "" || "API Key 不能为空",
        },
      ]);

      upsertEndpoint({ ...endpoint, apiKey });
      console.log(chalk.green(`\n✅ ${endpoint.name} API Key 已设置\n`));
    } catch (error: any) {
      console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
    }
  });

configCommand
  .command("set-default-model")
  .description("设置默认模型")
  .option("-m, --model <model-id>", "模型 ID")
  .action(async (options) => {
    try {
      let modelId = options.model;

      if (!modelId) {
        const models = getModels();
        const { modelId: selected } = await inquirer.prompt([
          {
            type: "list",
            name: "modelId",
            message: "选择默认模型:",
            choices: models.map((m) => ({
              name: `${m.name} (${m.id})`,
              value: m.id,
            })),
          },
        ]);
        modelId = selected;
      }

      setDefaultModel(modelId);
      const model = getModel(modelId);
      console.log(chalk.green(`\n✅ 默认模型已设置为 "${model?.name}"\n`));
    } catch (error: any) {
      console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
    }
  });

// ==================== 快速启动 ====================

// 如果没有参数，进入交互式菜单
if (process.argv.length <= 2) {
  async () => {
    try {
      console.log(chalk.blue.bold("\n🤖 欢迎使用 AI-Zen CLI\n"));

      const { action } = await inquirer.prompt([
        {
          type: "list",
          name: "action",
          message: "请选择操作:",
          choices: [
            { name: "💬 开始新对话", value: "chat" },
            { name: "📋 查看已保存的对话", value: "list-conversations" },
            { name: "💾 继续已保存的对话", value: "load-conversation" },
            { name: "🤖 管理 Agents", value: "manage-agents" },
            { name: "⚙️  管理配置", value: "config" },
          ],
        },
      ]);

      switch (action) {
        case "chat":
          await program.parseAsync(["node", "aiz", "chat"]);
          break;
        case "list-conversations":
          const conversations = getConversationsList();
          if (conversations.length === 0) {
            console.log(chalk.yellow("\n📭 没有已保存的对话\n"));
          } else {
            console.log(chalk.blue.bold("\n📋 已保存的对话:\n"));
            const { selected } = await inquirer.prompt([
              {
                type: "list",
                name: "selected",
                message: "选择要加载的对话:",
                choices: [
                  ...conversations.map((c) => ({
                    name: `${c.name} (${new Date(c.updatedAt).toLocaleString("zh-CN")})`,
                    value: c.id,
                  })),
                  { name: "返回", value: "" },
                ],
              },
            ]);
            if (selected) {
              await program.parseAsync([
                "node",
                "aiz",
                "conv",
                "load",
                selected,
              ]);
            }
          }
          break;
        case "load-conversation":
          const allConversations = getConversationsList();
          if (allConversations.length === 0) {
            console.log(chalk.yellow("\n📭 没有已保存的对话\n"));
          } else {
            const { convId } = await inquirer.prompt([
              {
                type: "list",
                name: "convId",
                message: "选择对话:",
                choices: allConversations.map((c) => ({
                  name: `${c.name} (${c.messageCount} 条消息)`,
                  value: c.id,
                })),
              },
            ]);
            await program.parseAsync(["node", "aiz", "conv", "load", convId]);
          }
          break;
        case "manage-agents":
          await program.parseAsync(["node", "aiz", "agents", "list"]);
          break;
        case "config":
          await program.parseAsync(["node", "aiz", "config", "show"]);
          break;
      }
    } catch (error: any) {
      console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
    }
    process.exit(0);
  };
}

// 解析命令行参数
program.parse(process.argv);
