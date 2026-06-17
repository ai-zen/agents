import { describe, it, expect } from "vitest";
import { CommonEndpoint } from "./CommonEndpoint.js";

describe("CommonEndpoint", () => {
  it("应返回配置中的 url", async () => {
    const ep = new CommonEndpoint({
      url: "https://my-custom-api.com/v1/chat/completions",
      headers: { Authorization: "Bearer token123" },
    });
    const result = await ep.build();
    expect(result.url).toBe("https://my-custom-api.com/v1/chat/completions");
    expect(result.headers.Authorization).toBe("Bearer token123");
  });

  it("应正确设置 Content-Type", async () => {
    const ep = new CommonEndpoint({
      url: "https://test.com/api",
    });
    const result = await ep.build();
    expect(result.headers["Content-Type"]).toBe("application/json");
  });

  it("应合并自定义 body", async () => {
    const ep = new CommonEndpoint({
      url: "https://test.com/api",
      body: { custom_field: "value", extra: 123 },
    });
    const result = await ep.build();
    expect(result.body.custom_field).toBe("value");
    expect(result.body.extra).toBe(123);
  });

  it("isCompatible 应始终返回 true", () => {
    const ep = new CommonEndpoint({ url: "https://test.com" });
    expect(ep.isCompatible()).toBe(true);
  });

  it("应覆盖自定义 headers", async () => {
    const ep = new CommonEndpoint({
      url: "https://test.com/api",
      headers: { "X-Debug": "true", "X-Custom": "val" },
    });
    const result = await ep.build();
    expect(result.headers["X-Debug"]).toBe("true");
    expect(result.headers["X-Custom"]).toBe("val");
  });
});
