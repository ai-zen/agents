import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing
vi.mock("../config.js", () => ({
  readConfig: vi.fn(() => ({
    endpoints: [
      { id: "bigmodelcn", name: "BigModelCN", apiKey: "test-key", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
    ],
    imageModels: [
      { id: "cogview-4", name: "CogView-4", endpointId: "bigmodelcn", modelName: "cogview-4", defaultSize: "1024x1024" },
    ],
    defaultImageModel: "cogview-4",
    models: [],
    defaultModel: "",
    mcpServers: [],
  })),
  CONFIG_DIR: "/mock/.ai-zen",
}));

vi.mock("../models.js", () => ({
  getImageModel: vi.fn(() => ({
    id: "cogview-4",
    name: "CogView-4",
    endpointId: "bigmodelcn",
    modelName: "cogview-4",
    defaultSize: "1024x1024",
  })),
  getDefaultImageModel: vi.fn(() => ({
    id: "cogview-4",
    name: "CogView-4",
    endpointId: "bigmodelcn",
    modelName: "cogview-4",
    defaultSize: "1024x1024",
  })),
}));

const { generateImageTool } = await import("./generateImage.js");

describe("generateImageTool", () => {
  it("工具名称和描述正确", () => {
    expect(generateImageTool.function.name).toBe("generateImage");
    expect(generateImageTool.function.description).toContain("生成图片");
  });

  it("prompt 为空时返回错误", async () => {
    const result = await generateImageTool.callback({ prompt: "" });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("不能为空");
  });

  it("prompt 只有空白字符时返回错误", async () => {
    const result = await generateImageTool.callback({ prompt: "   " });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("不能为空");
  });
});
