import chalk from "chalk";
import inquirer from "inquirer";
import { Model } from "./types.js";
import { getModel, getDefaultModel } from "./models.js";
import { getEndpoint, upsertEndpoint } from "./endpoints.js";

// ==================== 交互式配置向导 ====================

export async function ensureEndpointConfig(modelId?: string): Promise<Model> {
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
