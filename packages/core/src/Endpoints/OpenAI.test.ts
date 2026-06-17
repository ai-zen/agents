import { describe, it, expect } from "vitest";
import { OpenAI } from "./OpenAI.js";

describe("OpenAI Endpoint", () => {
  it("应使用默认 endpoint", async () => {
    const ep = new OpenAI({ api_key: "sk-test" });
    const result = await ep.build("chat/completions", "gpt-4");

    expect(result.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(result.headers.Authorization).toBe("Bearer sk-test");
    expect(result.body.model).toBe("gpt-4");
  });

  it("应使用自定义 endpoint", async () => {
    const ep = new OpenAI({
      openai_endpoint: "https://custom.api.com/v2",
      api_key: "sk-custom",
    });
    const result = await ep.build("embeddings", "text-embedding-3-small");

    expect(result.url).toBe("https://custom.api.com/v2/embeddings");
    expect(result.body.model).toBe("text-embedding-3-small");
  });

  it("应自动补全末尾斜杠", async () => {
    const ep = new OpenAI({
      openai_endpoint: "https://api.openai.com/v1",
      api_key: "sk-test",
    });
    const result = await ep.build("models", "gpt-4");
    expect(result.url).toBe("https://api.openai.com/v1/models");
  });

  it("应携带 organization 头部", async () => {
    const ep = new OpenAI({
      api_key: "sk-test",
      organization: "org-123",
    });
    const result = await ep.build("chat/completions", "gpt-4");

    expect(result.headers["OpenAI-Organization"]).toBe("org-123");
  });

  it("应合并自定义 headers", async () => {
    const ep = new OpenAI({
      api_key: "sk-test",
      headers: { "X-Custom": "value" },
    });
    const result = await ep.build("chat/completions", "gpt-4");

    expect(result.headers["X-Custom"]).toBe("value");
    expect(result.headers["Content-Type"]).toBe("application/json");
  });

  it("应合并自定义 body", async () => {
    const ep = new OpenAI({
      api_key: "sk-test",
      body: { temperature: 0.5, max_tokens: 100 },
    });
    const result = await ep.build("chat/completions", "gpt-4");

    expect(result.body.temperature).toBe(0.5);
    expect(result.body.max_tokens).toBe(100);
    expect(result.body.model).toBe("gpt-4");
  });
});
