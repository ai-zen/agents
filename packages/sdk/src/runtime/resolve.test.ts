import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveAgent } from "./resolve";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition, AppConfig } from "../types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-resolve-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const config: AppConfig = {
  defaultModel: "gpt4",
  endpoints: [
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "sk-xxx" },
  ],
  models: [
    { id: "gpt4", name: "GPT-4", endpointId: "openai", maxContextChars: 500000 },
  ],
};

function writeAgentFile(id: string, def: Partial<AgentDefinition> = {}) {
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const agent: AgentDefinition = {
    id,
    name: id,
    messages: [{ role: "system", content: "You are helpful." }],
    permissions: { tools: { allow: ["*"] }, skills: { allow: ["*"] }, mcps: { allow: ["*"] }, subagents: { allow: ["*"] } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...def,
  };
  writeFileSync(join(agentsDir, `${id}.json`), JSON.stringify(agent, null, 2));
}

function writeSubAgent(id: string, functionName: string) {
  const subDir = join(dir, "sub-agents");
  mkdirSync(subDir, { recursive: true });
  const agent: AgentDefinition = {
    id,
    name: id,
    messages: [
      { role: "system", content: "You are a sub-agent." },
      { role: "user", content: "{{task}}" },
    ],
    function: { name: functionName, description: "A sub-agent", parameters: { type: "object", properties: {}, required: [] } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(subDir, `${id}.json`), JSON.stringify(agent, null, 2));
}

function writeSkill(id: string, description: string) {
  const skillDir = join(dir, "skills", id);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n# ${id}`);
}

function writeMcpConfig(servers: Record<string, unknown>) {
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ servers }, null, 2));
}

describe("resolveAgent", () => {
  it("从磁盘完整装配 Agent", () => {
    writeAgentFile("my-agent");
    writeSubAgent("sa1", "general_assistant");
    writeSkill("code-review", "代码审查");
    writeMcpConfig({ github: { transport: "stdio", command: "gh" } });

    const result = resolveAgent({
      agentId: "my-agent",
      config,
      agentsDir: join(dir, "agents"),
      subAgentsDir: join(dir, "sub-agents"),
      skillsDir: join(dir, "skills"),
      mcpPaths: [join(dir, "mcp.json")],
    });

    expect(result.definition.id).toBe("my-agent");
    expect(result.model.id).toBe("gpt4");
    expect(result.capabilities.subagents).toEqual(["general_assistant"]);
    expect(result.capabilities.skillParam.enum).toEqual(["code-review"]);
    expect(result.capabilities.mcpParam.enum).toEqual(["github"]);
  });

  it("Agent 不存在时抛异常", () => {
    expect(() =>
      resolveAgent({
        agentId: "nonexistent",
        config,
        agentsDir: join(dir, "agents"),
      }),
    ).toThrow();
  });

  it("可选的发现目录不存在不抛异常", () => {
    writeAgentFile("my-agent");

    const result = resolveAgent({
      agentId: "my-agent",
      config,
      agentsDir: join(dir, "agents"),
    });

    expect(result.capabilities.subagents).toEqual([]);
    expect(result.capabilities.skillParam.enum).toBeUndefined();
  });
});
