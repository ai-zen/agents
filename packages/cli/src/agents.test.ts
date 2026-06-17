import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAgent, getAgents, getDefaultAgent, setDefaultAgent, upsertAgent, deleteAgent } from "./agents.js";
import { defaultConfig } from "./config.js";
import { AgentConfig } from "./types.js";

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

const testAgent: AgentConfig = {
  id: "test-agent",
  name: "测试助手",
  description: "用于测试的 Agent",
  messages: [
    { role: "system", content: "你是测试助手" },
  ],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

// ==================== 测试用例 ====================

describe("getAgents", () => {
  it("返回所有 Agent", () => {
    const agents = getAgents();
    expect(agents).toEqual(mockConfig.agents);
  });

  it("至少有默认 Agent", () => {
    const agents = getAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.some((a) => a.id === "default")).toBe(true);
  });
});

describe("getAgent", () => {
  it("按 ID 查找 Agent", () => {
    const agent = getAgent("default");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("default");
  });

  it("不存在的 ID 返回 undefined", () => {
    const agent = getAgent("non-existent");
    expect(agent).toBeUndefined();
  });
});

describe("getDefaultAgent", () => {
  it("返回默认 Agent", () => {
    const agent = getDefaultAgent();
    expect(agent).toBeDefined();
  });

  it("未设置 defaultAgent 时返回第一个", () => {
    const originalDefault = mockConfig.defaultAgent;
    mockConfig.defaultAgent = "";
    const agent = getDefaultAgent();
    expect(agent).toBeDefined();
    expect(agent!.id).toBe(mockConfig.agents[0]?.id);
    mockConfig.defaultAgent = originalDefault;
  });
});

describe("setDefaultAgent", () => {
  it("设置默认 Agent", () => {
    setDefaultAgent("default");
    expect(mockConfig.defaultAgent).toBe("default");
  });

  it("设置不存在的 Agent 时报错", () => {
    expect(() => setDefaultAgent("non-existent")).toThrow("不存在");
  });
});

describe("upsertAgent", () => {
  it("新增 Agent", () => {
    const count = mockConfig.agents.length;
    upsertAgent(testAgent);
    expect(mockConfig.agents.length).toBe(count + 1);
    expect(mockConfig.agents.find((a) => a.id === "test-agent")).toEqual(testAgent);
  });

  it("更新已有 Agent", () => {
    const updated = { ...testAgent, name: "更新后的助手" };
    upsertAgent(updated);
    const agent = mockConfig.agents.find((a) => a.id === "test-agent");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("更新后的助手");
  });
});

describe("deleteAgent", () => {
  it("删除 Agent", () => {
    // 先确保存在
    upsertAgent(testAgent);
    const beforeDelete = mockConfig.agents.find((a) => a.id === "test-agent");
    expect(beforeDelete).toBeDefined();

    deleteAgent("test-agent");
    const afterDelete = mockConfig.agents.find((a) => a.id === "test-agent");
    expect(afterDelete).toBeUndefined();
  });

  it("删除不存在的 Agent 不报错", () => {
    expect(() => deleteAgent("non-existent")).not.toThrow();
  });
});
