import { describe, it, expect, vi, afterEach } from "vitest";
import { GenerateImageTool } from "./GenerateImageTool.js";
import { makeEnv } from "./test-helpers.js";
import type { AppConfig, GenerateImageFn } from "../../../types/index.js";
import type { ToolCallContext } from "@ai-zen/agents-core";

// 出网动作走依赖注入（ToolEnv.deps），不再 mock "openai" 模块：
// 默认返回一张图；signal 已 abort 时抛 AbortError（配合中止测试）
const mockImagesGenerate = vi.fn<GenerateImageFn>(async ({ signal }) => {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
  return { created: 123, data: [{ url: "https://cdn.example/img.png" }] };
});

afterEach(() => {
  mockImagesGenerate.mockReset();
});

const mockConfig: AppConfig = {
  defaultModel: "gpt4",
  endpoints: [
    {
      id: "bigmodelcn",
      name: "BigModelCN",
      apiKey: "test-key",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    },
  ],
  models: [
    {
      id: "gpt4",
      name: "GPT-4",
      endpointId: "bigmodelcn",
      tokenThresholds: { handoff: 500000, guard: 750000 },
    },
  ],
  imageModels: [
    {
      id: "cogview-4",
      name: "CogView-4",
      endpointId: "bigmodelcn",
      modelName: "cogview-4",
      defaultSize: "1024x1024",
    },
  ],
  defaultImageModel: "cogview-4",
};

const tool = new GenerateImageTool(
  makeEnv(process.cwd(), mockConfig, { generateImage: mockImagesGenerate }),
);

describe("GenerateImageTool", () => {
  it("工具名称和描述正确", () => {
    expect(tool.function.name).toBe("generate_image");
    expect(tool.function.description).toContain("Generate an image from a text description");
  });

  it("prompt 为空时返回错误", async () => {
    const result = await tool.call({ prompt: "" });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("must not be empty");
  });

  it("prompt 只有空白字符时返回错误", async () => {
    const result = await tool.call({ prompt: "   " });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("must not be empty");
  });

  it("未配置图片模型时返回友好错误", async () => {
    const emptyConfig: AppConfig = {
      defaultModel: "gpt4",
      endpoints: [],
      models: [],
    };
    const emptyTool = new GenerateImageTool(makeEnv(process.cwd(), emptyConfig));
    const result = await emptyTool.call({ prompt: "a cat" });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("No image generation model configured");
  });

  it("指定的模型 ID 不存在时返回友好错误", async () => {
    const result = await tool.call({ prompt: "a cat", model: "non-existent-model" });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("does not exist");
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
    const noEpTool = new GenerateImageTool(makeEnv(process.cwd(), noEndpointConfig));
    const result = await noEpTool.call({ prompt: "a cat" });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("is not configured");
  });

  it("图片生成被中断（abort）时返回 aborted 结果", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await tool.call({ prompt: "a cat" }, {
      signal: controller.signal,
    } as unknown as ToolCallContext);
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.aborted).toBe(true);
    expect(parsed.error).toContain("Image generation aborted");
  });

  it("生成成功统一返回 JSON 字符串（图片 URL + view_image/download_file 提示）", async () => {
    const result = await tool.call({ prompt: "a cat" });

    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.images).toEqual([{ index: 0, url: "https://cdn.example/img.png" }]);
    expect(parsed.note).toContain("view_image");
    expect(parsed.note).toContain("download_file");
    expect(mockImagesGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "cogview-4",
        prompt: "a cat",
        size: "1024x1024",
        endpoint: expect.objectContaining({ id: "bigmodelcn" }),
      }),
    );
  });
});
