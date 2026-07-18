import { describe, it, expect } from "vitest";
import { createGenerateImageTool } from "./generateImage.js";
import type { AppConfig } from "../../../types/index.js";

const mockConfig: AppConfig = {
  defaultModel: "gpt4",
  endpoints: [
    { id: "bigmodelcn", name: "BigModelCN", apiKey: "test-key", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  ],
  models: [{ id: "gpt4", name: "GPT-4", endpointId: "bigmodelcn", maxContextTokens: 500000 }],
  imageModels: [
    { id: "cogview-4", name: "CogView-4", endpointId: "bigmodelcn", modelName: "cogview-4", defaultSize: "1024x1024" },
  ],
  defaultImageModel: "cogview-4",
};

const tool = createGenerateImageTool(mockConfig);

describe("generateImageTool", () => {
  it("工具名称和描述正确", () => {
    expect(tool.function.name).toBe("generateImage");
    expect(tool.function.description).toContain("生成图片");
  });

  it("prompt 为空时返回错误", async () => {
    const result = await tool.callback({ prompt: "" });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("不能为空");
  });

  it("prompt 只有空白字符时返回错误", async () => {
    const result = await tool.callback({ prompt: "   " });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("不能为空");
  });

  it("未配置图片模型时返回友好错误", async () => {
    const emptyConfig: AppConfig = {
      defaultModel: "gpt4",
      endpoints: [],
      models: [],
    };
    const emptyTool = createGenerateImageTool(emptyConfig);
    const result = await emptyTool.callback({ prompt: "a cat" });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("未配置图片生成模型");
  });

  it("指定的模型 ID 不存在时返回友好错误", async () => {
    const result = await tool.callback({ prompt: "a cat", model: "non-existent-model" });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("不存在");
  });

  it("端点未配置时返回友好错误", async () => {
    const noEndpointConfig: AppConfig = {
      defaultModel: "gpt4",
      endpoints: [],
      models: [],
      imageModels: [
        { id: "cogview-4", name: "CogView-4", endpointId: "missing-ep", modelName: "cogview-4" },
      ],
      defaultImageModel: "cogview-4",
    };
    const noEpTool = createGenerateImageTool(noEndpointConfig);
    const result = await noEpTool.callback({ prompt: "a cat" });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("未配置");
  });
});
