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
import { readConfig, saveConfig } from "../config.js";
import { showConfig } from "./config-display.js";
import { McpServerConfig } from "../types.js";
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

// ==================== MCP 服务器管理 ====================

/** 查看所有 MCP 服务器 */
function showMcpServers(): void {
  const config = readConfig();
  const servers = config.mcpServers || [];
  console.log(chalk.blue.bold("\n🔌 MCP 服务器列表:\n"));
  if (servers.length === 0) {
    console.log(chalk.yellow("  (未配置 MCP 服务器)\n"));
    return;
  }
  for (const srv of servers) {
    const status = srv.enabled === false ? "❌ 已禁用" : "✅ 已启用";
    console.log(chalk.white(`  ${srv.name} (${srv.id}) ${status}`));
    console.log(chalk.gray(`     传输方式: ${srv.transport}`));
    if (srv.transport === "stdio") {
      console.log(chalk.gray(`     命令: ${srv.command}`));
      if (srv.args?.length) console.log(chalk.gray(`     参数: ${srv.args.join(" ")}`));
    } else {
      console.log(chalk.gray(`     URL: ${srv.url}`));
    }
    console.log(SEPARATOR);
  }
}

/** 新增 MCP 服务器 */
async function addMcpServer(): Promise<void> {
  const { id, name, transport } = await inquirer.prompt([
    {
      type: "input",
      name: "id",
      message: "服务器 ID（唯一标识）:",
      validate: (input: string) => input.trim() !== "" || "ID 不能为空",
    },
    {
      type: "input",
      name: "name",
      message: "显示名称:",
      default: (answers: any) => answers.id,
    },
    {
      type: "list",
      name: "transport",
      message: "传输方式:",
      choices: [
        { name: "stdio（本地子进程）", value: "stdio" },
        { name: "SSE（远程 HTTP）", value: "sse" },
      ],
    },
  ]);

  let serverConfig: McpServerConfig = {
    id,
    name,
    transport,
    enabled: true,
  };

  if (transport === "stdio") {
    const { command, args } = await inquirer.prompt([
      {
        type: "input",
        name: "command",
        message: "启动命令:",
        validate: (input: string) => input.trim() !== "" || "命令不能为空",
      },
      {
        type: "input",
        name: "args",
        message: "命令参数（空格分隔，可选）:",
      },
    ]);
    serverConfig.command = command;
    serverConfig.args = args.trim() ? args.trim().split(/\s+/) : undefined;
  } else {
    const { url } = await inquirer.prompt([
      {
        type: "input",
        name: "url",
        message: "SSE URL:",
        validate: (input: string) => input.trim() !== "" || "URL 不能为空",
      },
    ]);
    serverConfig.url = url;
  }

  const config = readConfig();
  if (!config.mcpServers) config.mcpServers = [];
  if (config.mcpServers.find((s) => s.id === id)) {
    console.log(chalk.red(`\n❌ ID "${id}" 已存在\n`));
    return;
  }
  config.mcpServers.push(serverConfig);
  saveConfig(config);
  console.log(chalk.green(`\n✅ MCP 服务器 "${name}" 已添加\n`));
}

/** 编辑 MCP 服务器 */
async function editMcpServer(): Promise<void> {
  const config = readConfig();
  const servers = config.mcpServers || [];

  const serverId = await selectFromList(servers, {
    message: "选择要编辑的 MCP 服务器:",
    getName: (s) => `${s.name} (${s.id}) ${s.enabled === false ? "❌" : "✅"}`,
    getValue: (s) => s.id,
    emptyMessage: "⚠️  没有 MCP 服务器",
    backLabel: "🔙 取消",
  });
  if (!serverId) return;

  const server = servers.find((s) => s.id === serverId);
  if (!server) return;

  const { field } = await inquirer.prompt([
    {
      type: "list",
      name: "field",
      message: "选择要修改的字段:",
      choices: [
        { name: `名称 (当前: ${server.name})`, value: "name" },
        { name: "启用/禁用", value: "enabled" },
        ...(server.transport === "stdio"
          ? [
              { name: `命令 (当前: ${server.command})`, value: "command" },
              {
                name: `参数 (当前: ${(server.args || []).join(" ") || "无"})`,
                value: "args",
              },
            ]
          : [{ name: `URL (当前: ${server.url})`, value: "url" }]),
        { name: "🗑️  删除此服务器", value: "delete" },
        { name: "🔙 取消", value: "back" },
      ],
    },
  ]);

  if (field === "back") return;

  if (field === "delete") {
    config.mcpServers = servers.filter((s) => s.id !== serverId);
    saveConfig(config);
    console.log(chalk.green(`\n✅ MCP 服务器 "${server.name}" 已删除\n`));
    return;
  }

  if (field === "enabled") {
    server.enabled = server.enabled === false ? true : false;
    saveConfig(config);
    console.log(
      chalk.green(
        `\n✅ MCP 服务器 "${server.name}" 已${server.enabled ? "启用" : "禁用"}\n`,
      ),
    );
    return;
  }

  const { value } = await inquirer.prompt([
    {
      type: "input",
      name: "value",
      message: `请输入新的${field === "name" ? "名称" : field === "command" ? "命令" : field === "args" ? "参数（空格分隔）" : "URL"}:`,
      default: field === "args"
        ? (server.args || []).join(" ")
        : (server as any)[field] || "",
    },
  ]);

  if (field === "args") {
    server.args = value.trim() ? value.trim().split(/\s+/) : [];
  } else {
    (server as any)[field] = value;
  }
  saveConfig(config);
  console.log(chalk.green(`\n✅ MCP 服务器已更新\n`));
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
          { name: "🔌 管理 MCP 服务器", value: "mcp" },
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
      case "mcp":
        await manageMcpServers();
        break;
      case "back":
        return;
    }
  }
}

/** MCP 服务器管理子菜单 */
async function manageMcpServers(): Promise<void> {
  while (true) {
    console.log(chalk.blue.bold("\n🔌 MCP 服务器管理\n"));

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "请选择操作:",
        choices: [
          { name: "📋 查看所有 MCP 服务器", value: "list" },
          { name: "➕ 新增 MCP 服务器", value: "add" },
          { name: "✏️  编辑/删除 MCP 服务器", value: "edit" },
          { name: "🔙 返回配置管理", value: "back" },
        ],
      },
    ]);

    switch (action) {
      case "list":
        showMcpServers();
        break;
      case "add":
        await addMcpServer();
        break;
      case "edit":
        await editMcpServer();
        break;
      case "back":
        return;
    }
  }
}
