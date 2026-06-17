import { describe, it, expect } from "vitest";
import { AzureOpenAI } from "./AzureOpenAI.js";

describe("AzureOpenAI Endpoint", () => {
  it("应构建正确的 Azure OpenAI URL", async () => {
    const ep = new AzureOpenAI({
      azure_endpoint: "https://my-resource.openai.azure.com",
      api_key: "azure-key-123",
      api_version: "2024-02-15-preview",
    });
    const result = await ep.build("chat/completions", "gpt-4-deployment");

    expect(result.url).toBe(
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4-deployment/chat/completions?api-version=2024-02-15-preview",
    );
    expect(result.headers["api-key"]).toBe("azure-key-123");
  });

  it("应自动补全末尾斜杠", async () => {
    const ep = new AzureOpenAI({
      azure_endpoint: "https://my-resource.openai.azure.com/",
      api_key: "key",
      api_version: "2024-01-01",
    });
    const result = await ep.build("chat/completions", "deployment-1");
    expect(result.url).not.toContain("//openai");
  });

  it("缺少 azure_endpoint 应抛出错误", async () => {
    const ep = new AzureOpenAI({
      azure_endpoint: "",
      api_key: "key",
      api_version: "v1",
    });
    await expect(ep.build("chat/completions", "dep")).rejects.toThrow(
      "Azure OpenAI endpoint requires azure_endpoint",
    );
  });

  it("chatCompletion 应使用 deployments 路径", async () => {
    const ep = new AzureOpenAI({
      azure_endpoint: "https://test.openai.azure.com",
      api_key: "key",
      api_version: "2024-01-01",
    });
    const result = await ep.chatCompletion("my-gpt4");
    expect(result.url).toContain("/deployments/my-gpt4/chat/completions");
  });

  it("embedding 应使用 deployments 路径", async () => {
    const ep = new AzureOpenAI({
      azure_endpoint: "https://test.openai.azure.com",
      api_key: "key",
      api_version: "2024-01-01",
    });
    const result = await ep.embedding("my-embedding");
    expect(result.url).toContain("/deployments/my-embedding/embeddings");
  });

  it("应合并自定义 headers 和 body", async () => {
    const ep = new AzureOpenAI({
      azure_endpoint: "https://test.openai.azure.com",
      api_key: "key",
      api_version: "2024-01-01",
      headers: { "X-Debug": "true" },
      body: { temperature: 0.8 },
    });
    const result = await ep.build("chat/completions", "dep");
    expect(result.headers["X-Debug"]).toBe("true");
    expect(result.body.temperature).toBe(0.8);
  });
});
