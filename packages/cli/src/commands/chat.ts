import chalk from "chalk";
import { Command } from "commander";
import { AgentNS } from "@ai-zen/agents-core";
import { ModelParams, Model } from "../types.js";
import { createAgent } from "../agent-creator.js";
import { runConversation } from "../conversation-runner.js";
import { ensureEndpointConfig } from "../config-wizard.js";
import { getAgent } from "../agents.js";
import { loadConversation } from "../conversations.js";

export function registerChatCommand(program: Command): void {
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

        let agent;
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
}
