import chalk from "chalk";
import inquirer from "inquirer";
import { AgentNS } from "@ai-zen/agents-core";
import { createAgent } from "../agent-creator.js";
import { runConversation } from "../conversation-runner.js";
import { ensureEndpointConfig } from "../config-wizard.js";
import { getAgents, getDefaultAgent, getAgent } from "../agents.js";
import { getModels, getDefaultModel } from "../models.js";
import { loadConversation, saveConversation } from "../conversations.js";
import { getConversationsList } from "../conversations.js";
import { readDraft, clearDraft } from "../draft.js";

/**
 * 开始新对话：选择 Agent（可选）→ 选择模型 → 进入对话
 * 如果存在草稿，会自动将草稿保存为对话存档，再开始新对话
 */
export async function startNewConversation(initialMessage?: string): Promise<void> {
  // 有草稿时自动保存为对话存档，避免数据丢失
  const draft = readDraft();
  if (draft) {
    const timeStr = new Date(draft.updatedAt).toLocaleString("zh-CN");
    const draftName = `自动保存-草稿-${new Date(draft.updatedAt).toISOString().slice(0, 16).replace("T", " ")}`;
    saveConversation(draftName, draft.messages, draft.modelId, undefined, draft.agentId);
    console.log(chalk.green(`📦 草稿已自动保存为对话存档: "${draftName}" (${draft.messageCount} 条消息, ${timeStr})\n`));
  }
  
  // 清除草稿
  clearDraft();
  try {
    const agents = getAgents();
    let messages: AgentNS.Message[] | undefined;
    let agentId: string | undefined;
    let modelId: string | undefined;

    // 有 Agent 时直接弹出选择列表
    if (agents.length === 1) {
      // 只有一个 Agent，直接使用
      const agent = agents[0];
      messages = agent.messages;
      agentId = agent.id;
      if (agent.modelId) modelId = agent.modelId;
    } else if (agents.length > 1) {
      const defaultAgent = getDefaultAgent();
      const { selectedAgentId } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedAgentId",
          message: "选择 Agent (或选「不使用」或「取消」):",
          choices: [
            ...agents.map((a) => ({
              name: `${a.name}${defaultAgent?.id === a.id ? " (默认)" : ""}`,
              value: a.id,
            })),
            { name: "🚫 不使用 Agent", value: "__none__" },
            { name: "🔙 取消", value: "__cancel__" },
          ],
        },
      ]);
      if (selectedAgentId === "__cancel__") return; // 取消返回主菜单
      if (selectedAgentId !== "__none__") {
        const agent = getAgent(selectedAgentId);
        if (agent) {
          messages = agent.messages;
          agentId = agent.id;
          if (agent.modelId) modelId = agent.modelId;
        }
      }
    }

    // 优先使用默认模型，没有配置默认模型时才要求用户选择
    if (!modelId) {
      const defaultModel = getDefaultModel();
      if (defaultModel) {
        modelId = defaultModel.id;
        console.log(chalk.gray(`使用默认模型: ${defaultModel.name} (${defaultModel.id})`));
      } else {
        const models = getModels();
        const { selectedModelId } = await inquirer.prompt([
          {
            type: "list",
            name: "selectedModelId",
            message: "选择模型（未配置默认模型）:",
            choices: [
              ...models.map((m) => ({
                name: `${m.name} (${m.id})`,
                value: m.id,
              })),
              { name: "🔙 取消", value: "__cancel__" },
            ],
          },
        ]);
        if (selectedModelId === "__cancel__") return; // 取消返回主菜单
        modelId = selectedModelId;
      }
    }

    const model = await ensureEndpointConfig(modelId);
    const agent = await createAgent(model.id, messages);

    await runConversation(agent, model.id, undefined, undefined, agentId, initialMessage);
  } catch (error: any) {
    console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
  }
}

/**
 * 继续上次未完成的对话（从草稿恢复）
 */
export async function continueDraft(): Promise<void> {
  const draft = readDraft();
  if (!draft) {
    console.log(chalk.yellow("\n📭 没有未完成的对话\n"));
    return;
  }

  try {
    const timeStr = new Date(draft.updatedAt).toLocaleString("zh-CN");
    console.log(
      chalk.green(
        `\n✅ 已恢复上次未完成的对话 (${draft.messageCount} 条消息, ${timeStr})\n`,
      ),
    );

    const model = await ensureEndpointConfig(draft.modelId);
    const agent = await createAgent(model.id, draft.messages);

    await runConversation(agent, model.id, undefined, undefined, draft.agentId);
  } catch (error: any) {
    console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
  }
}

/**
 * 继续已保存的对话：列出对话 → 选择 → 进入对话
 */
export async function continueConversation(): Promise<void> {
  const conversations = getConversationsList();
  if (conversations.length === 0) {
    console.log(chalk.yellow("\n📭 没有已保存的对话\n"));
    return;
  }

  const { convId } = await inquirer.prompt([
    {
      type: "list",
      name: "convId",
      message: "选择对话:",
      choices: [
        ...conversations.map((c) => ({
          name: `${c.name} (${c.messageCount} 条消息, ${new Date(c.updatedAt).toLocaleString("zh-CN")})`,
          value: c.id,
        })),
        { name: "🔙 取消", value: "__cancel__" },
      ],
    },
  ]);

  if (convId === "__cancel__") return; // 取消返回主菜单

  try {
    const conversation = loadConversation(convId);
    console.log(chalk.green(`\n✅ 已加载对话: ${conversation.name}\n`));

    const model = await ensureEndpointConfig(conversation.modelId);
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
  }
}
