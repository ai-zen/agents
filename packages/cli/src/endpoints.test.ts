import { describe, it, expect, vi } from "vitest";
import { getEndpoint, getEndpoints, upsertEndpoint, deleteEndpoint } from "./endpoints.js";
import { defaultConfig } from "./config.js";
import { Endpoint } from "./types.js";

// ==================== Mock 配置 ====================

const mockConfig = { ...defaultConfig };

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    readConfig: vi.fn(() => mockConfig),
    saveConfig: vi.fn(),
  };
});

// ==================== 测试数据 ====================

const newEndpoint: Endpoint = {
  id: "custom-endpoint",
  name: "自定义端点",
  apiKey: "sk-test-key",
  baseUrl: "https://custom.api.com/v1",
  description: "用于测试",
};

// ==================== 测试用例 ====================

describe("getEndpoints", () => {
  it("返回所有端点", () => {
    const endpoints = getEndpoints();
    expect(endpoints).toEqual(mockConfig.endpoints);
  });

  it("至少有预置的 3 个端点", () => {
    const endpoints = getEndpoints();
    const ids = endpoints.map((e) => e.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("bigmodelcn");
    expect(ids).toContain("deepseek");
  });
});

describe("getEndpoint", () => {
  it("按 ID 查找端点", () => {
    const endpoint = getEndpoint("openai");
    expect(endpoint).toBeDefined();
    expect(endpoint!.id).toBe("openai");
    expect(endpoint!.name).toBe("OpenAI");
  });

  it("不存在的 ID 返回 undefined", () => {
    const endpoint = getEndpoint("non-existent");
    expect(endpoint).toBeUndefined();
  });
});

describe("upsertEndpoint", () => {
  it("新增端点", () => {
    const count = mockConfig.endpoints.length;
    upsertEndpoint(newEndpoint);
    expect(mockConfig.endpoints.length).toBe(count + 1);
    const ep = mockConfig.endpoints.find((e) => e.id === "custom-endpoint");
    expect(ep).toEqual(newEndpoint);
  });

  it("更新已有端点", () => {
    const updated = { ...newEndpoint, name: "更新后的端点", apiKey: "new-key" };
    upsertEndpoint(updated);
    const ep = mockConfig.endpoints.find((e) => e.id === "custom-endpoint");
    expect(ep).toBeDefined();
    expect(ep!.name).toBe("更新后的端点");
    expect(ep!.apiKey).toBe("new-key");
  });
});

describe("deleteEndpoint", () => {
  it("删除端点", () => {
    // 先确保存在
    upsertEndpoint(newEndpoint);
    expect(mockConfig.endpoints.find((e) => e.id === "custom-endpoint")).toBeDefined();

    deleteEndpoint("custom-endpoint");
    expect(mockConfig.endpoints.find((e) => e.id === "custom-endpoint")).toBeUndefined();
  });

  it("删除不存在的端点不报错", () => {
    expect(() => deleteEndpoint("non-existent")).not.toThrow();
  });

  it("删除后不应影响其他端点", () => {
    const ids = mockConfig.endpoints.map((e) => e.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("bigmodelcn");
    expect(ids).toContain("deepseek");
  });
});
