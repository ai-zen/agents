import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAgent } from "../src/runtime/createAgent";
import { Provider } from "../src/runtime/Provider";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition, AppConfig } from "../src/types";
import type { Tool } from "@ai-zen/agents-core";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-integration-"));
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
    { id: "gpt4", name: "GPT-4", endpointId: "openai", maxContextTokens: 500000 },
  ],
};

describe("集成：端到端 Agent 组装", () => {
  it("完整链路：配置文件 + Agent 定义 + 候选 → SdkAgent", async () => {
    // 写 Agent 定义
    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    const agentDef: AgentDefinition = {
      id: "my-agent",
      name: "My Agent",
      messages: [{ role: "system", content: "你是一个专业的代码助手。" }],
      permissions: {
        tools: { allow: ["readFile", "exec", "glob", "findText"] },
        skills: { allow: ["code-review"] },
        mcps: { deny: ["*"] },
        subagents: { allow: ["sub_agent_default"] },
      },
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    writeFileSync(join(agentsDir, "my-agent.json"), JSON.stringify(agentDef));

    // 写 SubAgent
    const subAgentsDir = join(dir, "sub-agents");
    mkdirSync(subAgentsDir, { recursive: true });
    const saDef: AgentDefinition = {
      id: "ga", name: "ga",
      messages: [{ role: "system", content: "Hi" }, { role: "user", content: "{{task}}" }],
      function: { name: "sub_agent_default", description: "", parameters: { type: "object", properties: {}, required: [] } },
      createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
    };
    writeFileSync(join(subAgentsDir, "ga.json"), JSON.stringify(saDef));

    // 写 Skill
    const skillsDir = join(dir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(join(skillsDir, "code-review"), { recursive: true });
    writeFileSync(join(skillsDir, "code-review", "SKILL.md"), "---\nname: code-review\ndescription: 代码审查\n---\n# Code Review");

    const provider = new Provider({
      config,
      agentsDir,
      subAgentsPaths: [subAgentsDir],
      skillsPaths: [skillsDir],
    });
    const agent = createAgent(provider, "my-agent");

    expect(agent.permissions).toBeDefined();
    expect(agent.permissions!.tools).toEqual({ allow: ["readFile", "exec", "glob", "findText"] });

    expect(agent.messages[0].content).toBe("你是一个专业的代码助手。");

    const toolNames = agent.tools.map((t: Tool) => t.function.name);
    expect(toolNames).toContain("readFile");
    expect(toolNames).toContain("exec");
    expect(toolNames).toContain("glob");
    expect(toolNames).toContain("findText");
    expect(toolNames).not.toContain("rm");
    expect(toolNames).not.toContain("writeFile");

    // subagents: allow: ["sub_agent_default"]
    expect(toolNames).toContain("sub_agent_default");
  });
});
