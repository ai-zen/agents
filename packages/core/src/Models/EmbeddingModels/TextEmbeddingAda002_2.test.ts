import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextEmbeddingAda002_2 } from "./TextEmbeddingAda002_2.js";

describe("TextEmbeddingAda002_2", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("应正确设置静态属性", () => {
    expect(TextEmbeddingAda002_2.title).toBe("text-embedding-ada-002-2");
    expect(TextEmbeddingAda002_2.code).toBe("text-embedding-ada-002");
    expect(TextEmbeddingAda002_2.INPUT_MAX_TOKENS).toBe(8191);
    expect(TextEmbeddingAda002_2.OUTPUT_DIMENSION).toBe(1536);
  });

  it("缺少 model_config 时应抛出错误", async () => {
    const model = new TextEmbeddingAda002_2({ request_config: {} as any });
    await expect(model.createEmbedding("test")).rejects.toThrow(
      "TextEmbeddingAda002_2 config not set",
    );
  });

  it("缺少 request_config 时应抛出错误", async () => {
    const model = new TextEmbeddingAda002_2({ model_config: {} as any });
    await expect(model.createEmbedding("test")).rejects.toThrow(
      "TextEmbeddingAda002_2 request not set",
    );
  });

  it("应成功调用 API 并返回 embedding 向量", async () => {
    const mockEmbedding = [0.001, 0.002, 0.003, 0.004, 0.005];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: mockEmbedding }],
        model: "ada",
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
    }));

    const model = new TextEmbeddingAda002_2({
      model_config: {},
      request_config: {
        url: "https://api.openai.com/v1/embeddings",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer sk-test",
        },
        body: { model: "text-embedding-ada-002" },
      },
    });

    const result = await model.createEmbedding("你好世界");
    expect(result).toEqual(mockEmbedding);
  });

  it("API 返回错误时应抛出异常", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        error: { code: 401, message: "Invalid API key" },
      }),
    }));

    const model = new TextEmbeddingAda002_2({
      model_config: {},
      request_config: {
        url: "https://api.openai.com/v1/embeddings",
        headers: { Authorization: "Bearer bad-key" },
        body: { model: "text-embedding-ada-002" },
      },
    });

    await expect(model.createEmbedding("test")).rejects.toThrow(
      "Invalid API key",
    );
  });

  it("fetch 网络错误应抛出异常", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const model = new TextEmbeddingAda002_2({
      model_config: {},
      request_config: {
        url: "https://api.openai.com/v1/embeddings",
        headers: { Authorization: "Bearer sk-test" },
        body: { model: "text-embedding-ada-002" },
      },
    });

    await expect(model.createEmbedding("test")).rejects.toThrow("Network error");
  });
});
