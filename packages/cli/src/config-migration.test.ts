import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  migrateRawConfig,
  ensureVersions,
  CURRENT_VERSION,
} from "./config-migration.js";

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
    writeFileSync: vi.fn((path: string, content: string) => {
      vol.set(path, content);
    }),
  };
});

beforeEach(() => {
  vol.clear();
});

// ==================== migrateRawConfig ====================

describe("migrateRawConfig", () => {
  it("当 agents 有 systemPrompt 时迁移为 messages", () => {
    const saved = {
      agents: [{ id: "a1", systemPrompt: "你是一个助手" }],
    };
    const changed = migrateRawConfig(saved);
    expect(changed).toBe(true);
    expect(saved.agents[0].messages).toEqual([
      { role: "system", content: "你是一个助手" },
    ]);
    expect(saved.agents[0].systemPrompt).toBeUndefined();
  });

  it("当 agents 已有 messages 时不做迁移", () => {
    const saved = {
      agents: [
        {
          id: "a1",
          systemPrompt: "你是一个助手",
          messages: [{ role: "system", content: "你是一个助手" }],
        },
      ],
    };
    const changed = migrateRawConfig(saved);
    expect(changed).toBe(false);
    // systemPrompt 不会被删除，因为已有 messages
  });

  it("agents 不是数组时不报错", () => {
    const saved = { agents: "not-array" };
    const changed = migrateRawConfig(saved);
    expect(changed).toBe(false);
  });

  it("agents 不存在时不报错", () => {
    const saved = {};
    const changed = migrateRawConfig(saved);
    expect(changed).toBe(false);
  });

  it("当 subAgents 有 systemPrompt 时迁移为 messages", () => {
    const saved = {
      subAgents: [{ id: "s1", systemPrompt: "你是通用助手" }],
    };
    const changed = migrateRawConfig(saved);
    expect(changed).toBe(true);
    expect(saved.subAgents[0].messages).toEqual([
      { role: "system", content: "你是通用助手" },
    ]);
    expect(saved.subAgents[0].systemPrompt).toBeUndefined();
  });

  it("当 subAgents 有 toolConfig 时迁移为 function", () => {
    const saved = {
      subAgents: [
        {
          id: "s1",
          toolConfig: { name: "test", description: "test", parameters: {} },
        },
      ],
    };
    const changed = migrateRawConfig(saved);
    expect(changed).toBe(true);
    expect(saved.subAgents[0].function).toEqual({
      name: "test",
      description: "test",
      parameters: {},
    });
    expect(saved.subAgents[0].toolConfig).toBeUndefined();
  });

  it("subAgents 同时迁移 systemPrompt 和 toolConfig", () => {
    const saved = {
      subAgents: [
        {
          id: "s1",
          systemPrompt: "你是助手",
          toolConfig: { name: "test", description: "test", parameters: {} },
        },
      ],
    };
    const changed = migrateRawConfig(saved);
    expect(changed).toBe(true);
    expect(saved.subAgents[0].messages).toEqual([
      { role: "system", content: "你是助手" },
    ]);
    expect(saved.subAgents[0].systemPrompt).toBeUndefined();
    expect(saved.subAgents[0].function).toEqual({
      name: "test",
      description: "test",
      parameters: {},
    });
    expect(saved.subAgents[0].toolConfig).toBeUndefined();
  });

  it("subAgents 不是数组时不报错", () => {
    const saved = { subAgents: "not-array" };
    const changed = migrateRawConfig(saved);
    expect(changed).toBe(false);
  });

  it("没有变更时返回 false", () => {
    const saved = {
      agents: [{ id: "a1", messages: [{ role: "system", content: "hi" }] }],
      subAgents: [
        {
          id: "s1",
          messages: [{ role: "system", content: "hi" }],
          function: { name: "t", description: "t", parameters: {} },
        },
      ],
    };
    const changed = migrateRawConfig(saved);
    expect(changed).toBe(false);
  });

  it("将 config.json 中的 agents 写入文件系统", () => {
    const agentsDir = "/mock/.ai-zen/agents";
    const saved = {
      agents: [
        { id: "agent1", name: "Agent 1", messages: [{ role: "system", content: "hi" }] },
        { id: "agent2", name: "Agent 2", messages: [{ role: "system", content: "hello" }] },
      ],
    };
    const changed = migrateRawConfig(saved, agentsDir);
    expect(changed).toBe(true);
    expect(vol.has("/mock/.ai-zen/agents/agent1.json")).toBe(true);
    expect(vol.has("/mock/.ai-zen/agents/agent2.json")).toBe(true);

    const agent1 = JSON.parse(vol.get("/mock/.ai-zen/agents/agent1.json")!);
    expect(agent1.id).toBe("agent1");
    expect(agent1.name).toBe("Agent 1");
  });

  it("不覆盖已存在的 agents 文件", () => {
    const agentsDir = "/mock/.ai-zen/agents";
    vol.set("/mock/.ai-zen/agents/agent1.json", JSON.stringify({ id: "agent1", name: "已有" }));

    const saved = {
      agents: [
        { id: "agent1", name: "新版本", messages: [] },
      ],
    };
    const changed = migrateRawConfig(saved, agentsDir);
    expect(changed).toBe(false);
    // 内容不变
    const agent1 = JSON.parse(vol.get("/mock/.ai-zen/agents/agent1.json")!);
    expect(agent1.name).toBe("已有");
  });

  it("agents 为空时不写入", () => {
    const agentsDir = "/mock/.ai-zen/agents";
    const saved = { agents: [] };
    const changed = migrateRawConfig(saved, agentsDir);
    expect(changed).toBe(false);
  });

  it("不传 agentsDir 时不触发文件系统迁移", () => {
    const saved = {
      agents: [{ id: "a1", name: "Test", messages: [] }],
    };
    const changed = migrateRawConfig(saved);
    expect(changed).toBe(false);
  });
});

// ==================== ensureVersions ====================

describe("ensureVersions", () => {
  it("给所有实体补充默认版本号", () => {
    const config = {
      endpoints: [{ id: "e1" }],
      models: [{ id: "m1" }],
      imageModels: [{ id: "im1" }],
      agents: [{ id: "a1" }],
      subAgents: [{ id: "s1" }],
    };
    ensureVersions(config);
    expect(config.endpoints[0].version).toBe(CURRENT_VERSION);
    expect(config.models[0].version).toBe(CURRENT_VERSION);
    expect(config.imageModels[0].version).toBe(CURRENT_VERSION);
    expect(config.agents[0].version).toBe(CURRENT_VERSION);
    expect(config.subAgents[0].version).toBe(CURRENT_VERSION);
  });

  it("不覆盖已有的版本号", () => {
    const config = {
      endpoints: [{ id: "e1", version: 99 }],
    };
    ensureVersions(config);
    expect(config.endpoints[0].version).toBe(99);
  });

  it("空数组不报错", () => {
    const config = {
      endpoints: [],
      models: [],
      agents: [],
    };
    expect(() => ensureVersions(config)).not.toThrow();
  });

  it("不存在的字段不报错", () => {
    const config = {};
    expect(() => ensureVersions(config)).not.toThrow();
  });
});
