import { describe, it, expect } from "vitest";
import { Endpoint } from "./Endpoint.js";

class TestEndpoint extends Endpoint<{ baseUrl: string; key: string }> {
  static title = "Test Endpoint";

  async build(path: string, model: string) {
    return {
      url: `${this.endpoint_config.baseUrl}/${path}`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.endpoint_config.key}`,
      },
      body: { model },
    };
  }

  buildSync(path: string, model: string) {
    return {
      url: `${this.endpoint_config.baseUrl}/${path}`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.endpoint_config.key}`,
      },
      body: { model },
    };
  }
}

describe("Endpoint 基类", () => {
  it("应正确获取 title 和 name", () => {
    const ep = new TestEndpoint({ baseUrl: "https://test.com", key: "abc" });
    expect(ep.title).toBe("Test Endpoint");
    expect(ep.name).toBe("TestEndpoint");
  });

  it("build 方法应由子类实现", async () => {
    const ep = new TestEndpoint({ baseUrl: "https://api.example.com/v1", key: "secret-123" });
    const result = await ep.build("chat/completions", "gpt-4");

    expect(result.url).toBe("https://api.example.com/v1/chat/completions");
    expect(result.headers.Authorization).toBe("Bearer secret-123");
    expect(result.body.model).toBe("gpt-4");
  });

  describe("快捷方法", () => {
    it("chatCompletion 应调用 build 并传入 chat/completions", async () => {
      const ep = new TestEndpoint({ baseUrl: "https://test.com", key: "key" });
      const result = await ep.chatCompletion("gpt-4");
      expect(result.url).toContain("chat/completions");
      expect(result.body.model).toBe("gpt-4");
    });

    it("embedding 应调用 build 并传入 embeddings", async () => {
      const ep = new TestEndpoint({ baseUrl: "https://test.com", key: "key" });
      const result = await ep.embedding("text-embedding-ada-002");
      expect(result.url).toContain("embeddings");
      expect(result.body.model).toBe("text-embedding-ada-002");
    });

    it("imageGeneration 应调用 build 并传入 images/generations", async () => {
      const ep = new TestEndpoint({ baseUrl: "https://test.com", key: "key" });
      const result = await ep.imageGeneration("dall-e-3");
      expect(result.url).toContain("images/generations");
      expect(result.body.model).toBe("dall-e-3");
    });

    it("chatCompletionSync 同步返回配置", () => {
      const ep = new TestEndpoint({ baseUrl: "https://test.com", key: "key" });
      const result = ep.chatCompletionSync("gpt-4");
      expect(result.url).toContain("chat/completions");
      expect(result.body.model).toBe("gpt-4");
    });
  });
});
