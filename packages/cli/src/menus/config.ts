import chalk from "chalk";
import inquirer from "inquirer";
import {
  getModels,
  getDefaultModel,
  setDefaultModel,
  getDefaultImageModel,
  setDefaultImageModel,
  getImageModels,
} from "../models.js";
import { getEndpoints, getEndpoint, upsertEndpoint } from "../endpoints.js";
import { showConfig } from "./config-display.js";
import { maskApiKey, selectFromList, SEPARATOR } from "./common.js";

// ==================== 单步操作函数 ====================

/** 查看所有端点 */
function showEndpoints(): void {
  const endpoints = getEndpoints();
  console.log(chalk.blue.bold("\n🌐 端点列表:\n"));
  for (const ep of endpoints) {
    console.log(chalk.white(`  ${ep.name} (${ep.id})`));
    console.log(chalk.gray(`     API Key: ${maskApiKey(ep.apiKey)}`));
    console.log(chalk.gray(`     Base URL: ${ep.baseUrl}`));
    console.log(SEPARATOR);
  }
}

/** 编辑端点 */
async function editEndpoint(): Promise<void> {
  const endpoints = getEndpoints();
  const endpointId = await selectFromList(endpoints, {
    message: "选择要编辑的端点:",
    getName: (e) => `${e.name} (${e.id}) ${e.apiKey ? "✅" : "❌"}`,
    getValue: (e) => e.id,
    emptyMessage: "⚠️  没有端点",
    backLabel: "🔙 取消",
  });
  if (!endpointId) return;

  const endpoint = getEndpoint(endpointId);
  if (!endpoint) return;

  const { field } = await inquirer.prompt([
    {
      type: "list",
      name: "field",
      message: "选择要修改的字段:",
      choices: [
        { name: `名称 (当前: ${endpoint.name})`, value: "name" },
        { name: `Base URL (当前: ${endpoint.baseUrl})`, value: "baseUrl" },
        {
          name: `API Key (当前: ${endpoint.apiKey ? "已设置" : "未设置"})`,
          value: "apiKey",
        },
        {
          name: `描述 (当前: ${endpoint.description || "无"})`,
          value: "description",
        },
        { name: "🔙 取消", value: "back" },
      ],
    },
  ]);
  if (field === "back") return;

  const { value } = await inquirer.prompt([
    {
      type: field === "apiKey" ? "password" : "input",
      name: "value",
      message: `请输入新的${field === "name" ? "名称" : field === "baseUrl" ? "Base URL" : field === "apiKey" ? "API Key" : "描述"}:`,
      default: (endpoint as any)[field] || "",
      mask: field === "apiKey" ? "*" : undefined,
    },
  ]);
  upsertEndpoint({ ...endpoint, [field]: value });
  console.log(chalk.green(`\n✅ 端点已更新\n`));
}

/** 设置 API Key */
async function setApiKeyInteractive(): Promise<void> {
  const endpoints = getEndpoints();
  const endpointId = await selectFromList(endpoints, {
    message: "选择要设置 API Key 的端点:",
    getName: (e) => `${e.name} (${e.id}) ${e.apiKey ? "✅" : "❌"}`,
    getValue: (e) => e.id,
    emptyMessage: "⚠️  没有端点",
    backLabel: "🔙 取消",
  });
  if (!endpointId) return;

  const endpoint = getEndpoint(endpointId);
  if (!endpoint) return;

  const { apiKey } = await inquirer.prompt([
    {
      type: "password",
      name: "apiKey",
      message: `输入 ${endpoint.name} 的 API Key:`,
      mask: "*",
      validate: (input: string) => input.trim() !== "" || "API Key 不能为空",
    },
  ]);

  upsertEndpoint({ ...endpoint, apiKey });
  console.log(chalk.green(`\n✅ ${endpoint.name} API Key 已设置\n`));
}

/** 设置默认对话模型 */
async function setDefaultModelInteractive(): Promise<void> {
  const models = getModels();
  const currentDefault = getDefaultModel();
  const modelId = await selectFromList(models, {
    message: "选择默认对话模型:",
    getName: (m) => `${m.name} (${m.id})${currentDefault?.id === m.id ? " ⭐ 当前" : ""}`,
    getValue: (m) => m.id,
    emptyMessage: "⚠️  没有可用的对话模型",
    backLabel: "🔙 取消",
  });
  if (!modelId) return;
  setDefaultModel(modelId);
  const model = getDefaultModel();
  console.log(chalk.green(`\n✅ 默认对话模型已设置为 "${model?.name}"\n`));
}

/** 设置默认图片生成模型 */
async function setDefaultImageModelInteractive(): Promise<void> {
  const imageModels = getImageModels();
  const currentDefault = getDefaultImageModel();
  const modelId = await selectFromList(imageModels, {
    message: "选择默认图片生成模型:",
    getName: (m) => `${m.name} (${m.id})${currentDefault?.id === m.id ? " ⭐ 当前" : ""}`,
    getValue: (m) => m.id,
    emptyMessage: "⚠️  没有可用的图片生成模型",
    backLabel: "🔙 取消",
  });
  if (!modelId) return;
  setDefaultImageModel(modelId);
  const model = getDefaultImageModel();
  console.log(chalk.green(`\n✅ 默认图片生成模型已设置为 "${model?.name}"\n`));
}

/** 查看所有对话模型 */
function showModels(): void {
  const models = getModels();
  const defaultModel = getDefaultModel();
  console.log(chalk.blue.bold("\n🔧 对话模型列表:\n"));
  if (models.length === 0) {
    console.log(chalk.yellow("  (无)\n"));
    return;
  }
  for (const model of models) {
    const ep = getEndpoint(model.endpointId);
    const isDefault = defaultModel?.id === model.id;
    console.log(
      chalk.white(`  ${isDefault ? "⭐ " : "  "}${model.name} (${model.id})`),
    );
    console.log(chalk.gray(`     端点: ${ep ? ep.name : "未知"}`));
    console.log(chalk.gray(`     模型名: ${model.modelName}`));
    if (model.description)
      console.log(chalk.gray(`     描述: ${model.description}`));
    console.log(SEPARATOR);
  }
}

/** 查看所有图片生成模型 */
function showImageModels(): void {
  const imageModels = getImageModels();
  const defaultImageModel = getDefaultImageModel();
  console.log(chalk.blue.bold("\n🎨 图片生成模型列表:\n"));
  if (imageModels.length === 0) {
    console.log(chalk.yellow("  (无)\n"));
    return;
  }
  for (const model of imageModels) {
    const ep = getEndpoint(model.endpointId);
    const isDefault = defaultImageModel?.id === model.id;
    console.log(
      chalk.white(`  ${isDefault ? "⭐ " : "  "}${model.name} (${model.id})`),
    );
    console.log(chalk.gray(`     端点: ${ep ? ep.name : "未知"}`));
    console.log(chalk.gray(`     模型名: ${model.modelName}`));
    if (model.defaultSize)
      console.log(chalk.gray(`     默认尺寸: ${model.defaultSize}`));
    if (model.defaultQuality)
      console.log(chalk.gray(`     默认质量: ${model.defaultQuality}`));
    console.log(SEPARATOR);
  }
}

// ==================== 配置管理主菜单（扁平化） ====================

export async function showInteractiveConfig(): Promise<void> {
  while (true) {
    console.log(chalk.blue.bold("\n⚙️  配置管理\n"));

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "请选择操作:",
        choices: [
          { name: "📋 查看当前配置（总览）", value: "show" },
          { name: "⭐ 设置默认对话模型", value: "set-default-model" },
          { name: "⭐ 设置默认图片生成模型", value: "set-default-image-model" },
          { name: "🔑 设置 API Key", value: "set-key" },
          { name: "🔧 编辑 API", value: "edit-endpoint" },
          { name: "🌐 查看所有 API", value: "list-endpoints" },
          { name: "📋 查看对话模型", value: "list-models" },
          { name: "📋 查看图片生成模型", value: "list-image-models" },
          { name: "🔙 返回主菜单", value: "back" },
        ],
      },
    ]);

    switch (action) {
      case "show":
        showConfig();
        break;
      case "set-key":
        await setApiKeyInteractive();
        break;
      case "list-endpoints":
        showEndpoints();
        break;
      case "edit-endpoint":
        await editEndpoint();
        break;
      case "list-models":
        showModels();
        break;
      case "set-default-model":
        await setDefaultModelInteractive();
        break;
      case "list-image-models":
        showImageModels();
        break;
      case "set-default-image-model":
        await setDefaultImageModelInteractive();
        break;
      case "back":
        return;
    }
  }
}
