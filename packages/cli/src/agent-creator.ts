import { Agent, AgentNS, AgentTool, OpenAI, ChatGPT, CallbackTool } from "@ai-zen/agents-core";
import { getModel } from "./models.js";
import { getEndpoint } from "./endpoints.js";
import { readConfig } from "./config.js";
import { allTools } from "./tools/index.js";
import { startAllMcpServers } from "./mcp-manager.js";
import { discoverSubAgents, resolveSubAgentTools } from "./sub-agent-loader.js";
import { SubAgentConfig } from "./types.js";
import { buildLoadSkillFunction, loadSkillContent } from "./skill-loader.js";
import { discoverUserTools } from "./tool-loader.js";

// ==================== 模型创建 ====================

async function buildModel(modelId: string) {
  const modelConfig = getModel(modelId);
  if (!modelConfig) {
    throw new Error(`模型 ${modelId} 不存在`);
  }

  const endpointConfig = getEndpoint(modelConfig.endpointId);
  if (!endpointConfig) {
    throw new Error(`端点 ${modelConfig.endpointId} 不存在，请先配置端点`);
  }

  if (!endpointConfig.apiKey) {
    throw new Error(
      `端点 ${endpointConfig.name} 的 API Key 未设置，请使用 "aiz config set-key" 设置`,
    );
  }

  const endpoint = new OpenAI({
    openai_endpoint: endpointConfig.baseUrl,
    api_key: endpointConfig.apiKey,
  });

  const model = new ChatGPT({
    model_config: modelConfig.defaultParams,
    request_config: await endpoint.chatCompletion(modelConfig.modelName),
  });

  return model;
}

// ==================== Agent 创建 ====================

export async function createAgent(
  modelId: string,
  messages?: AgentNS.Message[],
): Promise<Agent> {
  // 创建主模型
  const model = await buildModel(modelId);

  // ========== 加载内置工具 + 用户自定义工具 ==========

  const tools: CallbackTool[] = [...allTools];

  // 加载用户自定义工具（全局 + 项目级）
  const userTools = await discoverUserTools();
  if (userTools.length > 0) {
    tools.push(...userTools);
  }

  // ========== 加载子 Agent（文件系统发现 + config.json 向后兼容） ==========

  // 收集所有子 Agent 配置
  const subAgentConfigs: SubAgentConfig[] = [];

  // 1. 文件系统发现（全局 + 项目级）
  const discoveredAgents = await discoverSubAgents();
  subAgentConfigs.push(...discoveredAgents);

  // 2. config.json 中配置的 subAgents（向后兼容）
  const config = readConfig();
  for (const subConfig of config.subAgents || []) {
    // 如果文件系统已经发现同名 Agent，跳过 config 中的（文件系统优先）
    if (!subAgentConfigs.find((a) => a.id === subConfig.id)) {
      subAgentConfigs.push(subConfig);
    }
  }

  // 加载所有子 Agent
  for (const subConfig of subAgentConfigs) {
    try {
      const subModelId = subConfig.modelId || modelId;
      const subModel = subModelId === modelId
        ? model
        : await buildModel(subModelId);

      // 解析子 Agent 引用的工具
      const { tools: subTools, mcpTools: subMcpTools } = resolveSubAgentTools(subConfig);

      // 合并所有工具
      const allSubTools: CallbackTool[] = [];

      // 如果子 Agent 没有显式声明 tools，默认赋予所有全局工具（向后兼容）
      if (subConfig.tools && subConfig.tools.length > 0) {
        allSubTools.push(...subTools);
      } else if (!subConfig.tools && !subConfig.extraTools && !subConfig.mcpServers) {
        // 完全没声明任何工具引用 → 默认全部（兼容旧版 config.subAgents）
        allSubTools.push(...allTools);
      } else {
        allSubTools.push(...subTools);
      }

      // 添加 MCP 工具
      allSubTools.push(...subMcpTools);

      const subAgent = new AgentTool({
        model: subModel,
        function: subConfig.function,
        messages: subConfig.messages,
        tools: allSubTools,
      });

      tools.push(subAgent);
    } catch (error: any) {
      console.warn(`⚠️  子 Agent "${subConfig.name}" 加载失败: ${error.message}`);
    }
  }

  // 加载 MCP 工具
  const mcpTools = await startAllMcpServers();
  tools.push(...mcpTools);

  // ========== 注册 Skill 加载工具 ==========
  //
  // 每次回调都重新读取文件，保证内容是最新的。
  // enum 在工具注册时固定，但 description 中已提醒 AI 可尝试加载不在列表中的 Skill。

  const loadSkillTool = new CallbackTool({
    function: buildLoadSkillFunction(),
    callback(this, args: { skill_id: string }) {
      // 每次调用都重新扫描 + 读取，保证最新
      const content = loadSkillContent(args.skill_id);
      if (!content) {
        return `❌ Skill "${args.skill_id}" 不存在，请确认文件名是否正确`;
      }

      // 将 Skill 内容作为 system message 注入到 Agent 的对话中
      this.agent.messages.push({
        role: AgentNS.Role.System,
        content: `以下是 Skill "${args.skill_id}" 的内容，请按照其中的指导完成任务：\n\n${content}`,
      });

      return `✅ Skill "${args.skill_id}" 已加载，内容已附加到当前对话中`;
    },
  });

  tools.push(loadSkillTool);

  // ========== 构建感知提示 ==========
  //
  // 在 system message 末尾追加当前可用的子 Agent 和 Skill 信息。
  // 如果传入了 messages（来自 Agent 配置），替换最后一条 system 消息的内容。

  const subAgentNames = subAgentConfigs.map((c) => c.name);
  const awarenessSuffix = [
    "",
    "---",
    "",
    subAgentNames.length > 0 ? `可调用的子助手：${subAgentNames.join("、")}` : "",
    "可用 Skill 列表可通过 load_skill 工具查看。",
  ]
    .filter(Boolean)
    .join("\n");

  let finalMessages: AgentNS.Message[];

  if (messages && messages.length > 0) {
    // 有传入消息（来自 Agent 配置），在最后一条 system 消息追加感知信息
    finalMessages = messages.map((msg, index) => {
      if (
        index === messages.length - 1 &&
        msg.role === AgentNS.Role.System &&
        typeof msg.content === "string"
      ) {
        return {
          ...msg,
          content: msg.content + awarenessSuffix,
        };
      }
      return msg;
    });
  } else {
    // 默认 system prompt
    finalMessages = [
      {
        role: AgentNS.Role.System,
        content: `你是一个AI助手，专门帮助用户回答问题和执行任务。请用中文回复。${awarenessSuffix}`,
      },
    ];
  }

  // 创建 Agent
  const agent = new Agent({
    model: model,
    messages: finalMessages,
    tools,
  });

  return agent;
}
