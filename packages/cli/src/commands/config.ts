import chalk from "chalk";
import inquirer from "inquirer";
import { Command } from "commander";
import { readConfig, CONFIG_FILE } from "../config.js";
import { getEndpoints, getEndpoint, upsertEndpoint } from "../endpoints.js";
import { Endpoint } from "../types.js";
import { getModels, getModel, getDefaultModel, setDefaultModel, getModelsByEndpoint } from "../models.js";
import { getDefaultAgent } from "../agents.js";

export function registerConfigCommand(program: Command): void {
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
}
