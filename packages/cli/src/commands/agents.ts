import chalk from "chalk";
import inquirer from "inquirer";
import { Command } from "commander";
import {
  getAgent,
  getAgents,
  getDefaultAgent,
  setDefaultAgent,
  upsertAgent,
  deleteAgent,
} from "../agents.js";
import { getModels } from "../models.js";
import { AgentConfig } from "../types.js";

export function registerAgentsCommand(program: Command): void {
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
}
