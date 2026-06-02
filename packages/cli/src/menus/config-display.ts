import chalk from "chalk";
import { readConfig, CONFIG_FILE } from "../config.js";
import {
  getDefaultModel,
  getDefaultImageModel,
  getImageModels,
  getModelsByEndpoint,
} from "../models.js";
import { getDefaultAgent } from "../agents.js";
import { getEndpoint } from "../endpoints.js";
import { maskApiKey, SEPARATOR } from "./common.js";

/** 查看当前完整配置 */
export function showConfig(): void {
  const config = readConfig();

  console.log(chalk.blue.bold("\n📋 当前配置:\n"));

  showDefaultModelSection();
  showDefaultImageModelSection();
  showDefaultAgentSection();
  showEndpointsSection(config);
  showModelsSection(config);
  showImageModelsSection(config);

  console.log(chalk.gray(`\n配置文件: ${CONFIG_FILE}\n`));
}

function showDefaultModelSection(): void {
  const defaultModel = getDefaultModel();
  console.log(chalk.white.bold("默认对话模型:"));
  if (defaultModel) {
    console.log(chalk.green(`  ⭐ ${defaultModel.name} (${defaultModel.id})`));
    console.log(chalk.gray(`     端点: ${defaultModel.endpointId}`));
    console.log(chalk.gray(`     模型名: ${defaultModel.modelName}`));
  } else {
    console.log(chalk.yellow("  未设置"));
  }
  console.log();
}

function showDefaultImageModelSection(): void {
  const defaultImageModel = getDefaultImageModel();
  console.log(chalk.white.bold("默认图片生成模型:"));
  if (defaultImageModel) {
    console.log(
      chalk.green(`  ⭐ ${defaultImageModel.name} (${defaultImageModel.id})`),
    );
    console.log(chalk.gray(`     端点: ${defaultImageModel.endpointId}`));
    console.log(chalk.gray(`     模型名: ${defaultImageModel.modelName}`));
    if (defaultImageModel.defaultSize) {
      console.log(
        chalk.gray(`     默认尺寸: ${defaultImageModel.defaultSize}`),
      );
    }
  } else {
    console.log(chalk.yellow("  未设置"));
  }
  console.log();
}

function showDefaultAgentSection(): void {
  const defaultAgent = getDefaultAgent();
  console.log(chalk.white.bold("默认 Agent:"));
  if (defaultAgent) {
    console.log(chalk.green(`  ⭐ ${defaultAgent.name} (${defaultAgent.id})`));
  } else {
    console.log(chalk.yellow("  未设置"));
  }
  console.log();
}

function showEndpointsSection(config: ReturnType<typeof readConfig>): void {
  console.log(chalk.white.bold("端点:"));
  console.log(SEPARATOR);
  for (const endpoint of config.endpoints) {
    const isConfigured = endpoint.apiKey ? chalk.green("✅") : chalk.red("❌");

    console.log(
      chalk.white(`  ${endpoint.name} (${endpoint.id}) ${isConfigured}`),
    );
    console.log(chalk.gray(`     API Key: ${maskApiKey(endpoint.apiKey)}`));
    console.log(chalk.gray(`     Base URL: ${endpoint.baseUrl}`));
    if (endpoint.description) {
      console.log(chalk.gray(`     描述: ${endpoint.description}`));
    }

    const models = getModelsByEndpoint(endpoint.id);
    if (models.length > 0) {
      console.log(
        chalk.gray(`     对话模型: ${models.map((m) => m.name).join(", ")}`),
      );
    }

    const imageModels = getImageModels().filter(
      (m) => m.endpointId === endpoint.id,
    );
    if (imageModels.length > 0) {
      console.log(
        chalk.gray(
          `     图片模型: ${imageModels.map((m) => m.name).join(", ")}`,
        ),
      );
    }

    console.log(SEPARATOR);
  }
}

function showModelsSection(config: ReturnType<typeof readConfig>): void {
  console.log(chalk.white.bold("\n对话模型:"));
  console.log(SEPARATOR);
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
    console.log(SEPARATOR);
  }
}

function showImageModelsSection(config: ReturnType<typeof readConfig>): void {
  console.log(chalk.white.bold("\n图片生成模型:"));
  console.log(SEPARATOR);
  const imageModels = config.imageModels || [];
  if (imageModels.length === 0) {
    console.log(chalk.yellow("  (无)"));
    console.log(SEPARATOR);
    return;
  }
  for (const model of imageModels) {
    const endpoint = getEndpoint(model.endpointId);
    const endpointName = endpoint ? endpoint.name : "未知";
    const isDefault = config.defaultImageModel === model.id;

    console.log(
      chalk.white(`  ${isDefault ? "⭐ " : "  "}${model.name} (${model.id})`),
    );
    console.log(chalk.gray(`     端点: ${endpointName}`));
    console.log(chalk.gray(`     模型名: ${model.modelName}`));
    if (model.description) {
      console.log(chalk.gray(`     描述: ${model.description}`));
    }
    if (model.defaultSize) {
      console.log(chalk.gray(`     默认尺寸: ${model.defaultSize}`));
    }
    if (model.defaultQuality) {
      console.log(chalk.gray(`     默认质量: ${model.defaultQuality}`));
    }
    console.log(SEPARATOR);
  }
}
