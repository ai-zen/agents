import chalk from "chalk";
import inquirer from "inquirer";
import { AgentNS } from "@ai-zen/agents-core";
import {
  getAgents,
  getDefaultAgent,
  deleteAgent,
  getAgent,
  upsertAgent,
  setDefaultAgent,
} from "../agents.js";
import { getModels } from "../models.js";
import { formatFullTime } from "../format-time.js";
import {
  selectItemAndAction,
  confirmAction,
  SEPARATOR_LONG,
} from "./common.js";

/**
 * 获取消息列表中的文本摘要
 */
function getMessagesSummary(messages: AgentNS.Message[]): string {
  const systemMsg = messages.find((m) => m.role === AgentNS.Role.System);
  if (systemMsg && typeof systemMsg.content === "string") {
    return systemMsg.content.substring(0, 80);
  }
  const firstMsg = messages[0];
  if (firstMsg && typeof firstMsg.content === "string") {
    return firstMsg.content.substring(0, 80);
  }
  return "(空)";
}

/**
 * 展现 Agent 详情
 */
function formatAgentDetails(
  agent: ReturnType<typeof getAgent>,
  isDefault: boolean,
): string[] {
  if (!agent) return [];
  return [
    chalk.white.bold(
      `  ${isDefault ? "⭐ " : "  "}${agent.name} ${isDefault ? "(默认)" : ""}`,
    ),
    chalk.gray(`     ID: ${agent.id}`),
    agent.description ? chalk.gray(`     描述: ${agent.description}`) : "",
    chalk.gray(`     消息数: ${agent.messages.length} 条`),
    chalk.gray(`     摘要: ${getMessagesSummary(agent.messages)}`),
    chalk.gray(
      `     创建时间: ${formatFullTime(agent.createdAt)}`,
    ),
    SEPARATOR_LONG,
  ].filter(Boolean);
}

/**
 * Agent 管理：先选 Agent，然后选择操作
 */
export async function manageAgentsInteractive(): Promise<void> {
  while (true) {
    console.log(chalk.blue.bold("\n🤖 Agent 管理\n"));

    // 先列出所有 Agent 让用户选
    const agents = getAgents();
    if (agents.length === 0) {
      console.log(chalk.yellow("📭 没有可用的 Agent\n"));
      const { create } = await inquirer.prompt([
        {
          type: "confirm",
          name: "create",
          message: "是否创建一个 Agent?",
          default: true,
        },
      ]);
      if (create) {
        await createAgentInteractive();
        continue;
      }
      return;
    }

    const defaultAgent = getDefaultAgent();
    const result = await selectItemAndAction(agents, {
      getName: (a) =>
        `${a.name}${defaultAgent?.id === a.id ? " ⭐(默认)" : ""}`,
      getValue: (a) => a.id,
      getDetails: (a) => formatAgentDetails(a, defaultAgent?.id === a.id),
      actions: [
        { name: "✏️  编辑", value: "edit" },
        { name: "🗑️  删除", value: "delete" },
        { name: "⭐ 设为默认", value: "set-default" },
      ],
      emptyMessage: "📭 没有可用的 Agent",
    });

    if (!result) continue; // 返回（选择列表中的"返回"）

    const { item: agent, action } = result;

    switch (action) {
      case "edit":
        await editAgentInteractive(agent.id);
        break;
      case "delete":
        await deleteAgentInteractive(agent.id);
        break;
      case "set-default":
        setDefaultAgent(agent.id);
        console.log(chalk.green(`\n✅ 默认 Agent 已设置为 "${agent.name}"\n`));
        break;
      case "__exit__":
        return; // 用户选择退出管理，回到主菜单
    }
  }
}

/** 创建 Agent */
async function createAgentInteractive(): Promise<void> {
  const { name, description, systemContent, modelId } = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Agent 名称:",
      validate: (input: string) => input.trim() !== "" || "名称不能为空",
    },
    { type: "input", name: "description", message: "描述 (可选):" },
    {
      type: "editor",
      name: "systemContent",
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

  let id = name.toLowerCase().replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_");

  // 检查 ID 是否已存在，冲突时追加随机后缀
  if (getAgent(id)) {
    const suffix = Math.random().toString(36).substring(2, 6);
    id = `${id}_${suffix}`;
    console.log(chalk.yellow(`⚠️  名称生成的 ID 已存在，已调整为: ${id}\n`));
  }

  const now = new Date().toISOString();
  upsertAgent({
    id,
    name,
    description,
    messages: [{ role: AgentNS.Role.System, content: systemContent }],
    modelId: modelId || undefined,
    createdAt: now,
    updatedAt: now,
  });
  console.log(chalk.green(`\n✅ Agent "${name}" 创建成功!\n`));
}

/** 编辑 Agent */
async function editAgentInteractive(agentId: string): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent) return;

  // 获取当前 system 消息内容
  const currentSystem = agent.messages.find(
    (m) => m.role === AgentNS.Role.System && typeof m.content === "string",
  );
  const currentContent =
    currentSystem && typeof currentSystem.content === "string"
      ? currentSystem.content
      : "";

  const { name, description, systemContent, modelId } = await inquirer.prompt([
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
      name: "systemContent",
      message: "系统提示:",
      default: currentContent,
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

  upsertAgent({
    ...agent,
    name,
    description,
    messages: [{ role: AgentNS.Role.System, content: systemContent }],
    modelId: modelId || undefined,
    updatedAt: new Date().toISOString(),
  });
  console.log(chalk.green(`\n✅ Agent "${name}" 已更新\n`));
}

/** 删除 Agent */
async function deleteAgentInteractive(agentId: string): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent) return;

  const confirmed = await confirmAction(
    `确定要删除 Agent "${agent.name}" 吗?`,
    false,
  );
  if (confirmed) {
    deleteAgent(agentId);
    console.log(chalk.green(`\n✅ Agent "${agent.name}" 已删除\n`));
  }
}
