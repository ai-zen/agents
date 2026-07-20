import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { discoverSubAgents } from "./subagents.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition } from "../../types/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-discovery-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeAgentFile(id: string, functionName: string, description = "") {
  const agent: AgentDefinition = {
    id,
    name: id,
    messages: [{ role: AgentNS.Role.System, content: "You are helpful." }],
    function: { name: functionName, description, parameters: { type: "object", properties: {}, required: [] } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(agent, null, 2));
}

describe("discoverSubAgents", () => {
  it("空目录返回空数组", () => {
    expect(discoverSubAgents([dir])).toEqual([]);
  });

  it("发现所有 SubAgent（返回完整 AgentDefinition）", () => {
    writeAgentFile("agent-a", "sub_agent_default", "通用助手");
    writeAgentFile("agent-b", "code-reviewer", "代码审查");

    const result = discoverSubAgents([dir]);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.function!.name)).toEqual(["sub_agent_default", "code-reviewer"]);
    // 应包含完整定义
    expect(result[0].messages).toBeDefined();
    expect(result[0].function!.description).toBe("通用助手");
  });

  it("跳过无 function 字段的普通 Agent", () => {
    writeAgentFile("agent-a", "sub_agent_default");
    const plain: AgentDefinition = {
      id: "plain-agent",
      name: "普通 Agent",
      messages: [{ role: AgentNS.Role.System, content: "Hi" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(dir, "plain-agent.json"), JSON.stringify(plain, null, 2));

    const result = discoverSubAgents([dir]);
    expect(result).toHaveLength(1);
    expect(result[0].function!.name).toBe("sub_agent_default");
  });

  it("跳过解析失败的 JSON", () => {
    writeAgentFile("good", "helper");
    writeFileSync(join(dir, "bad.json"), "{ not json }");

    const result = discoverSubAgents([dir]);
    expect(result).toHaveLength(1);
    expect(result[0].function!.name).toBe("helper");
  });

  it("目录不存在时返回空数组", () => {
    expect(discoverSubAgents([join(dir, "nonexistent")])).toEqual([]);
  });

  it("多路径扫描：合并所有路径的 SubAgent", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-discovery2-"));
    try {
      writeAgentFile("agent-a", "sub_agent_default");
      const agentB: AgentDefinition = {
        id: "agent-b",
        name: "agent-b",
        messages: [{ role: AgentNS.Role.System, content: "Hi" }],
        function: { name: "code-reviewer", description: "代码审查", parameters: { type: "object", properties: {}, required: [] } },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(join(dir2, "agent-b.json"), JSON.stringify(agentB, null, 2));

      const result = discoverSubAgents([dir, dir2]);
      expect(result).toHaveLength(2);
      expect(result.map((a) => a.function!.name)).toEqual(["sub_agent_default", "code-reviewer"]);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("多路径：同名 function.name 靠前路径优先（先到先得）", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-discovery2-"));
    try {
      writeAgentFile("agent-a", "shared_func", "From dir1（高优先级）");
      const agentB: AgentDefinition = {
        id: "agent-b",
        name: "agent-b",
        messages: [{ role: AgentNS.Role.System, content: "Hi" }],
        function: { name: "shared_func", description: "From dir2（低优先级）", parameters: { type: "object", properties: {}, required: [] } },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(join(dir2, "agent-b.json"), JSON.stringify(agentB, null, 2));

      const result = discoverSubAgents([dir, dir2]);
      expect(result).toHaveLength(1);
      expect(result[0].function!.name).toBe("shared_func");
      // dir 在前（高优先级），应优先
      expect(result[0].function!.description).toBe("From dir1（高优先级）");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
