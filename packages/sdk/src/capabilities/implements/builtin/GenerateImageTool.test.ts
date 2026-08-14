import { describe, it, expect, vi, afterEach } from "vitest";
import { GenerateImageTool } from "./GenerateImageTool.js";
import { makeEnv } from "./test-helpers.js";
import type { AppConfig } from "../../../types/index.js";
import type { ToolCallContext } from "@ai-zen/agents-core";

const mockFetch = vi.fn();

afterEach(() => {
  mockFetch.mockReset();
  vi.unstubAllGlobals();
});

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

const tool = new GenerateImageTool(makeEnv(process.cwd(), mockConfig));

describe("GenerateImageTool", () => {
  it("工具名称和描述正确", () => {
    expect(tool.function.name).toBe("generateImage");
    expect(tool.function.description).toContain("生成图片");
  });

  it("prompt 为空时返回错误", async () => {
    const result = await tool.call({ prompt: "" });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("不能为空");
  });

  it("prompt 只有空白字符时返回错误", async () => {
    const result = await tool.call({ prompt: "   " });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("不能为空");
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
    expect(parsed.error).toContain("未配置图片生成模型");
  });

  it("指定的模型 ID 不存在时返回友好错误", async () => {
    const result = await tool.call({ prompt: "a cat", model: "non-existent-model" });
    const parsed = JSON.parse(result);
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
    const noEpTool = new GenerateImageTool(makeEnv(process.cwd(), noEndpointConfig));
    const result = await noEpTool.call({ prompt: "a cat" });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("未配置");
  });

  it("图片生成被中断（abort）时返回 aborted 结果", async () => {
    // mock fetch：收到已 aborted 的 signal 时抛 AbortError
    mockFetch.mockImplementation(async (url: string, init?: any) => {
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      throw new Error("should not reach here");
    });
    vi.stubGlobal("fetch", mockFetch);

    const controller = new AbortController();
    controller.abort();

    const result = await tool.call(
      { prompt: "a cat" },
      { signal: controller.signal } as unknown as ToolCallContext,
    );
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.aborted).toBe(true);
    expect(parsed.error).toContain("中断");
  });
});
