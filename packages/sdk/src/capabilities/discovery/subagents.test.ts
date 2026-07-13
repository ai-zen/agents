import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverSubAgents } from "./subagents";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition } from "../../types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-discovery-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeAgentFile(id: string, functionName: string, description: string) {
  const agent: AgentDefinition = {
    id,
    name: id,
    messages: [{ role: "system", content: "You are helpful." }],
    function: { name: functionName, description, parameters: { type: "object", properties: {}, required: [] } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(agent, null, 2));
}

describe("discoverSubAgents", () => {
  it("空目录返回空数组", () => {
    expect(discoverSubAgents(dir)).toEqual([]);
  });

  it("发现所有 SubAgent", () => {
    writeAgentFile("agent-a", "general_assistant", "通用助手");
    writeAgentFile("agent-b", "code-reviewer", "代码审查");

    const result = discoverSubAgents(dir);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toEqual(["general_assistant", "code-reviewer"]);
    expect(result.map((s) => s.description)).toEqual(["通用助手", "代码审查"]);
  });

  it("跳过无 function 字段的普通 Agent", () => {
    writeAgentFile("agent-a", "general_assistant", "助手");
    // 普通 Agent，无 function
    const plain: AgentDefinition = {
      id: "plain-agent",
      name: "普通 Agent",
      messages: [{ role: "system", content: "Hi" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(dir, "plain-agent.json"), JSON.stringify(plain, null, 2));

    const result = discoverSubAgents(dir);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("general_assistant");
  });

  it("跳过解析失败的 JSON", () => {
    writeAgentFile("good", "helper", "Helper");
    writeFileSync(join(dir, "bad.json"), "{ not json }");

    const result = discoverSubAgents(dir);
    expect(result).toHaveLength(1);
  });

  it("目录不存在时返回空数组", () => {
    expect(discoverSubAgents(join(dir, "nonexistent"))).toEqual([]);
  });
});
