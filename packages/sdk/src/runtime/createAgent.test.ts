import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentNS, Message } from "@ai-zen/agents-core";
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

    // SdkAgent 定义携带 permissions
    expect(agent.definition.permissions).toBeDefined();
    expect(agent.definition.permissions!.tools).toEqual({ allow: ["*"] });

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

  it("append 不应污染 Agent 定义模板（definition.messages 引用隔离）", async () => {
    await writeAgentFile("my-agent");

    const provider = await Provider.create({
      config,
      agentsDir: join(dir, "agents"),
    });
    const agent = await createAgent(provider, "my-agent");

    const templateBefore = agent.definition.messages!.map((m) => ({ ...m }));
    const templateCount = templateBefore.length;

    // 对话过程中 append 新消息（模拟 send 行为）
    agent.append(Message.User("你好"));
    agent.append(Message.Assistant("你好！"));

    // 模板未被污染：definition.messages 仍为初始模板
    expect(agent.definition.messages).toHaveLength(templateCount);
    expect(agent.definition.messages).toEqual(templateBefore);
    // 会话消息独立累积
    expect(agent.messages).toHaveLength(templateCount + 2);
    expect(agent.messages).not.toBe(agent.definition.messages);
  });

  it("Agent 定义缺少 messages 字段时也能正常创建（空值兜底）", async () => {
    await writeAgentFile("my-agent", { messages: undefined });

    const provider = await Provider.create({
      config,
      agentsDir: join(dir, "agents"),
    });
    const agent = await createAgent(provider, "my-agent");

    expect(agent.messages).toEqual([]);
    agent.append(Message.User("你好"));
    expect(agent.messages).toHaveLength(1);
    // definition.messages 为 undefined 时不应抛错（createAgent 已用 ?? [] 兜底）
    expect(agent.definition.messages).toBeUndefined();
  });
});
