import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAgent, getAgents, getDefaultAgent, setDefaultAgent, upsertAgent, deleteAgent } from "./agents.js";
import { AgentConfig } from "./types.js";

// ==================== Mock 文件系统 ====================

const vol = new Map<string, string>();

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (path.includes("node_modules")) return actual.existsSync(path);
      return vol.has(path);
    }),
    readdirSync: vi.fn((path: string) => {
      const prefix = path.endsWith("/") ? path : path + "/";
      const files: string[] = [];
      for (const key of vol.keys()) {
        if (key.startsWith(prefix)) {
          files.push(key.slice(prefix.length));
        }
      }
      return files;
    }),
    readFileSync: vi.fn((path: string, encoding?: any) => {
      if (path.includes("node_modules")) return actual.readFileSync(path, encoding);
      if (!vol.has(path)) throw new Error(`ENOENT: ${path}`);
      return vol.get(path)!;
    }),
    writeFileSync: vi.fn((path: string, content: string) => {
      vol.set(path, content);
    }),
    unlinkSync: vi.fn((path: string) => {
      vol.delete(path);
    }),
  };
});

// ==================== Mock config ====================

const mockConfig = {
  defaultAgent: "default",
  subAgents: [],
};
vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    readConfig: vi.fn(() => mockConfig),
    saveConfig: vi.fn(),
    AGENTS_DIR: "/mock/.ai-zen/agents",
  };
});

// ==================== 测试数据 ====================

const testAgent: AgentConfig = {
  id: "test-agent",
  name: "测试助手",
  description: "用于测试的 Agent",
  messages: [
    { role: "system" as const, content: "你是测试助手" },
  ],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const defaultAgentData: AgentConfig = {
  id: "default",
  name: "默认助手",
  messages: [
    { role: "system" as const, content: "你是一个AI助手" },
  ],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

// ==================== 测试用例 ====================

beforeEach(() => {
  vol.clear();
  // 标记目录存在（两种写法都支持）
  vol.set("/mock/.ai-zen/agents", "");
  vol.set("/mock/.ai-zen/agents/", "");
  // 写入默认 Agent
  vol.set("/mock/.ai-zen/agents/default.json", JSON.stringify(defaultAgentData));
});

describe("getAgents", () => {
  it("返回所有 Agent", () => {
    const agents = getAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].id).toBe("default");
  });

  it("目录为空时返回空数组", () => {
    vol.clear();
    const agents = getAgents();
    expect(agents).toEqual([]);
  });

  it("跳过损坏的文件", () => {
    vol.set("/mock/.ai-zen/agents/bad.json", "not json");
    const agents = getAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].id).toBe("default");
  });
});

describe("getAgent", () => {
  it("按 ID 查找 Agent", () => {
    const agent = getAgent("default");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("default");
    expect(agent!.name).toBe("默认助手");
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
    expect(agent!.id).toBe("default");
  });

  it("未设置 defaultAgent 时返回第一个", () => {
    mockConfig.defaultAgent = "";
    const agent = getDefaultAgent();
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("default");
    mockConfig.defaultAgent = "default";
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
    upsertAgent(testAgent);
    const agents = getAgents();
    expect(agents.length).toBe(2);
    const found = agents.find((a) => a.id === "test-agent");
    expect(found).toEqual(testAgent);
  });

  it("更新已有 Agent", () => {
    upsertAgent(testAgent);
    const updated = { ...testAgent, name: "更新后的助手" };
    upsertAgent(updated);
    const agent = getAgent("test-agent");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("更新后的助手");
  });
});

describe("deleteAgent", () => {
  it("删除 Agent", () => {
    upsertAgent(testAgent);
    expect(getAgent("test-agent")).toBeDefined();

    deleteAgent("test-agent");
    expect(getAgent("test-agent")).toBeUndefined();
  });

  it("删除不存在的 Agent 不报错", () => {
    expect(() => deleteAgent("non-existent")).not.toThrow();
  });

  it("删除默认 Agent 时清除 defaultAgent 引用", () => {
    deleteAgent("default");
    expect(mockConfig.defaultAgent).toBe("");
  });
});
