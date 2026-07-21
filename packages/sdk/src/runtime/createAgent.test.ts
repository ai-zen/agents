import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { createAgent } from "./createAgent.js";
import { Provider } from "./Provider.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentDefinition, AppConfig } from "../types/index.js";

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
    { id: "gpt4", name: "GPT-4", endpointId: "openai", maxContextTokens: 500000 },
  ],
};

function writeAgentFile(id: string, def: Partial<AgentDefinition> = {}) {
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const agent: AgentDefinition = {
    id,
    name: id,
    messages: [{ role: AgentNS.Role.System, content: "You are helpful." }],
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
      { role: AgentNS.Role.System, content: "You are a sub-agent." },
      { role: AgentNS.Role.User, content: "{{task}}" },
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

describe("createAgent", () => {
  it("从磁盘完整装配 Agent", () => {
    writeAgentFile("my-agent");
    writeSubAgent("sa1", "sub_agent_default");
    writeSkill("code-review", "代码审查");
    writeMcpConfig({ github: { transport: "stdio", command: "gh" } });

    const provider = new Provider({
      config,
      agentsDir: join(dir, "agents"),
      subAgentsPaths: [join(dir, "sub-agents")],
      skillsPaths: [join(dir, "skills")],
      mcpPaths: [join(dir, "mcp.json")],
    });
    const agent = createAgent(provider, "my-agent");

    // SdkAgent 携带 permissions
    expect(agent.permissions).toBeDefined();
    expect(agent.permissions!.tools).toEqual({ allow: ["*"] });

    const names = agent.tools.map((t: any) => t.function.name);
    expect(names).toContain("sub_agent_default");
  });

  it("Agent 不存在时抛异常", () => {
    const provider = new Provider({
      config,
      agentsDir: join(dir, "agents"),
    });

    expect(() => createAgent(provider, "nonexistent")).toThrow();
  });

  it("可选的发现目录不存在不抛异常", () => {
    writeAgentFile("my-agent");

    const provider = new Provider({
      config,
      agentsDir: join(dir, "agents"),
    });

    const agent = createAgent(provider, "my-agent");
    expect(agent.tools.length).toBeGreaterThan(0); // 内置工具默认存在
  });

  describe("onUnknownTool 钩子", () => {
    it("未设置时默认提示中应包含可用工具列表", () => {
      writeAgentFile("my-agent", {
        permissions: { tools: { allow: ["*"] }, skills: { allow: ["*"] }, mcps: { allow: ["*"] }, subagents: { allow: ["*"] } },
      });

      const provider = new Provider({
        config,
        agentsDir: join(dir, "agents"),
      });

      const agent = createAgent(provider, "my-agent");
      expect(agent.onUnknownTool).toBeDefined();

      const toolNames = agent.tools.map((t) => t.function.name);
      const result = agent.onUnknownTool!({
        toolCall: { function: { name: "nonExistentTool" } },
        availableTools: [],
      });

      // 提示中应包含工具名和可用工具列表
      expect(result).toContain("nonExistentTool");
      expect(result).toContain("不存在");
      // 应列出当前注册的工具
      for (const name of toolNames.slice(0, 3)) {
        expect(result).toContain(name);
      }
    });

    it("有 MCP 配置且 call_mcp_tool 在工具列表中时，应提示使用 call_mcp_tool", () => {
      writeAgentFile("my-agent");
      writeMcpConfig({ github: { transport: "stdio", command: "gh" } });

      const provider = new Provider({
        config,
        agentsDir: join(dir, "agents"),
        mcpPaths: [join(dir, "mcp.json")],
      });

      const agent = createAgent(provider, "my-agent");
      expect(agent.onUnknownTool).toBeDefined();

      const result = agent.onUnknownTool!({
        toolCall: { function: { name: "someMcpTool" } },
        availableTools: [],
      });

      expect(result).toContain("someMcpTool");
      expect(result).toContain("call_mcp_tool");
      expect(result).toContain("load_mcp");
    });

    it("有 MCP 配置但 call_mcp_tool 权限被禁用时，应提示权限问题", () => {
      writeAgentFile("my-agent", {
        permissions: {
          tools: { deny: ["call_mcp_tool", "load_mcp", "read_mcp_resource"] },
          mcps: { deny: ["*"] },
          skills: { deny: ["*"] },
          subagents: { deny: ["*"] },
        },
      });
      writeMcpConfig({ github: { transport: "stdio", command: "gh" } });

      const provider = new Provider({
        config,
        agentsDir: join(dir, "agents"),
        mcpPaths: [join(dir, "mcp.json")],
      });

      const agent = createAgent(provider, "my-agent");
      expect(agent.onUnknownTool).toBeDefined();

      const result = agent.onUnknownTool!({
        toolCall: { function: { name: "someTool" } },
        availableTools: [],
      });

      expect(result).toContain("someTool");
      expect(result).toContain("MCP");
      expect(result).toContain("权限");
      // 提示中应提及 call_mcp_tool 已被禁用
      expect(result).toContain("禁用");
    });

    it("无 MCP 配置时不应提示 MCP 相关内容", () => {
      writeAgentFile("my-agent", {
        permissions: { tools: { allow: ["*"] }, skills: { deny: ["*"] }, mcps: { deny: ["*"] }, subagents: { deny: ["*"] } },
      });

      const provider = new Provider({
        config,
        agentsDir: join(dir, "agents"),
      });

      const agent = createAgent(provider, "my-agent");
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
