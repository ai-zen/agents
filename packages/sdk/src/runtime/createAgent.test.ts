import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { createAgent } from "./createAgent.js";
import { Provider } from "./Provider.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition, AppConfig } from "../types/index.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "ai-zen-resolve-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
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

async function writeAgentFile(id: string, def: Partial<AgentDefinition> = {}) {
  const agentsDir = join(dir, "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  const agent: AgentDefinition = {
    id,
    name: id,
    messages: [{ role: AgentNS.Role.System, content: "You are helpful." }],
    permissions: { tools: { allow: ["*"] }, skills: { allow: ["*"] }, mcps: { allow: ["*"] }, subagents: { allow: ["*"] } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...def,
  };
  await fs.writeFile(join(agentsDir, `${id}.json`), JSON.stringify(agent, null, 2));
}

async function writeSubAgent(id: string, functionName: string) {
  const subDir = join(dir, "sub-agents");
  await fs.mkdir(subDir, { recursive: true });
  const agent: AgentDefinition = {
    id,
    name: id,
    messages: [
      { role: AgentNS.Role.System, content: "You are a sub-agent." },
      { role: AgentNS.Role.User, content: "{{task}}" },
    ],
    function: { name: functionName, description: "A sub-agent", parameters: { type: "object", properties: {}, required: [] } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(join(subDir, `${id}.json`), JSON.stringify(agent, null, 2));
}

async function writeSkill(id: string, description: string) {
  const skillDir = join(dir, "skills", id);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(join(skillDir, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n# ${id}`);
}

async function writeMcpConfig(servers: Record<string, unknown>) {
  await fs.writeFile(join(dir, "mcp.json"), JSON.stringify({ servers }, null, 2));
}

describe("createAgent", () => {
  it("从磁盘完整装配 Agent", async () => {
    await writeAgentFile("my-agent");
    await writeSubAgent("sa1", "sub_agent_default");
    await writeSkill("code-review", "代码审查");
    await writeMcpConfig({ github: { transport: "stdio", command: "gh" } });

    const provider = await Provider.create({
      config,
      agentsDir: join(dir, "agents"),
      subAgentsPaths: [join(dir, "sub-agents")],
      skillsPaths: [join(dir, "skills")],
      mcpPaths: [join(dir, "mcp.json")],
    });
    const agent = await createAgent(provider, "my-agent");

    // SdkAgent 携带 permissions
    expect(agent.permissions).toBeDefined();
    expect(agent.permissions!.tools).toEqual({ allow: ["*"] });

    const names = agent.tools.map((t: any) => t.function.name);
    expect(names).toContain("sub_agent_default");
  });

  it("Agent 不存在时抛异常", async () => {
    const provider = await Provider.create({
      config,
      agentsDir: join(dir, "agents"),
    });

    await expect(createAgent(provider, "nonexistent")).rejects.toThrow();
  });

  it("可选的发现目录不存在不抛异常", async () => {
    await writeAgentFile("my-agent");

    const provider = await Provider.create({
      config,
      agentsDir: join(dir, "agents"),
    });

    const agent = await createAgent(provider, "my-agent");
    expect(agent.tools.length).toBeGreaterThan(0); // 内置工具默认存在
  });

  describe("onUnknownTool 钩子", () => {
    it("无 MCP 配置时返回简单提示", async () => {
      await writeAgentFile("my-agent");

      const provider = await Provider.create({
        config,
        agentsDir: join(dir, "agents"),
      });

      const agent = await createAgent(provider, "my-agent");
      expect(agent.onUnknownTool).toBeDefined();

      const result = agent.onUnknownTool!({
        toolCall: { function: { name: "nonExistentTool" } },
        availableTools: [],
      });

      expect(result).toContain("nonExistentTool");
      expect(result).toContain("不存在");
    });

    it("有 MCP 配置且 call_mcp_tool 在工具列表中时，应提示使用 call_mcp_tool", async () => {
      await writeAgentFile("my-agent");
      await writeMcpConfig({ github: { transport: "stdio", command: "gh" } });

      const provider = await Provider.create({
        config,
        agentsDir: join(dir, "agents"),
        mcpPaths: [join(dir, "mcp.json")],
      });

      const agent = await createAgent(provider, "my-agent");
      expect(agent.onUnknownTool).toBeDefined();

      const result = agent.onUnknownTool!({
        toolCall: { function: { name: "someMcpTool" } },
        availableTools: [],
      });

      expect(result).toContain("someMcpTool");
      expect(result).toContain("不存在");
      expect(result).toContain("call_mcp_tool");
    });

    it("有 MCP 配置但 call_mcp_tool 权限被禁用时，应提示权限问题", async () => {
      await writeAgentFile("my-agent", {
        permissions: {
          tools: { deny: ["call_mcp_tool", "load_mcp", "read_mcp_resource"] },
          mcps: { deny: ["*"] },
          skills: { deny: ["*"] },
          subagents: { deny: ["*"] },
        },
      });
      await writeMcpConfig({ github: { transport: "stdio", command: "gh" } });

      const provider = await Provider.create({
        config,
        agentsDir: join(dir, "agents"),
        mcpPaths: [join(dir, "mcp.json")],
      });

      const agent = await createAgent(provider, "my-agent");
      expect(agent.onUnknownTool).toBeDefined();

      const result = agent.onUnknownTool!({
        toolCall: { function: { name: "someTool" } },
        availableTools: [],
      });

      expect(result).toContain("someTool");
      expect(result).toContain("MCP");
      expect(result).toContain("禁用");
    });

    it("无 MCP 配置时不应提示 MCP 相关内容", async () => {
      await writeAgentFile("my-agent");

      const provider = await Provider.create({
        config,
        agentsDir: join(dir, "agents"),
      });

      const agent = await createAgent(provider, "my-agent");
      const result = agent.onUnknownTool!({
        toolCall: { function: { name: "unknownFn" } },
        availableTools: [],
      });

      expect(result).toContain("unknownFn");
      expect(result).not.toContain("MCP");
      expect(result).not.toContain("call_mcp_tool");
      expect(result).not.toContain("load_mcp");
    });
  });
});
