import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Capabilities } from "./Capabilities.js";
import type { Provider } from "../runtime/Provider.js";
import type { AgentDefinition, AppConfig, AgentPermissions } from "../types/index.js";
import { AgentNS, Tool } from "@ai-zen/agents-core";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(overrides?: Partial<Provider>): Provider {
  return {
    config: {
      defaultModel: "gpt4",
      endpoints: [],
      models: [],
    },
    agentsDir: "",
    subAgentsPaths: [],
    skillsPaths: [],
    toolsPaths: [],
    mcpPaths: [],

    // 默认 getMcpManager 返回 undefined（无 mcpPaths）
    getMcpManager: () => undefined as any,
    ...overrides,
  } as unknown as Provider;
}

function makeTool(name: string): Tool {
  return new (class extends Tool {
    constructor() {
      super({
        function: {
          name,
          description: `Tool ${name}`,
          parameters: { type: "object", properties: {}, required: [] },
        },
      });
    }
    async exec(): Promise<string> {
      return name;
    }
  })();
}

const ALLOW_ALL: AgentPermissions = {
  tools: { allow: ["*"] },
  skills: { allow: ["*"] },
  mcps: { allow: ["*"] },
  subagents: { allow: ["*"] },
};

const DENY_ALL: AgentPermissions = {
  tools: { deny: ["*"] },
  skills: { deny: ["*"] },
  mcps: { deny: ["*"] },
  subagents: { deny: ["*"] },
};

// ---------------------------------------------------------------------------
// 带真实文件系统的 Capabilities
// ---------------------------------------------------------------------------
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ai-zen-caps-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSubAgent(id: string, functionName: string) {
  const subDir = join(tmpDir, "sub-agents");
  mkdirSync(subDir, { recursive: true });
  const def: AgentDefinition = {
    id,
    name: id,
    messages: [
      { role: AgentNS.Role.System, content: "You are a sub-agent." },
      { role: AgentNS.Role.User, content: "{{task}}" },
    ],
    function: {
      name: functionName,
      description: `Sub-agent ${functionName}`,
      parameters: { type: "object", properties: {}, required: [] },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(subDir, `${id}.json`), JSON.stringify(def));
}

function writeSkill(id: string, description: string, subAgent = true) {
  const skillDir = join(tmpDir, "skills", id);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\nsub-agent: ${subAgent}\n---\n# ${id}`,
  );
}

function writeMcpJson(servers: Record<string, unknown>) {
  writeFileSync(join(tmpDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

function writeUserTool(name: string) {
  const toolDir = join(tmpDir, "tools");
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(
    join(toolDir, `${name}.js`),
    `
module.exports = {
  function: {
    name: "${name}",
    description: "User tool ${name}",
    parameters: { type: "object", properties: {}, required: [] }
  },
  exec: async function() { return "${name}"; }
};
`,
  );
}

// ==================================================================
// 测试
// ==================================================================

describe("Capabilities", () => {
  describe("constructor — 全局发现", () => {
    it("空配置时内置工具不为空", () => {
      const caps = new Capabilities(mockProvider());
      expect(caps.builtinInstances.length).toBeGreaterThan(0);
      expect(caps.userInstances).toEqual([]);
      expect(caps.subagentDefs).toEqual([]);
      expect(caps.skills).toEqual([]);
      expect(caps.mcps).toEqual([]);
    });

    it("未配置 defaultImageModel 时不包含 generateImage", () => {
      const caps = new Capabilities(mockProvider());
      const names = caps.builtinInstances.map((t) => t.function.name);
      expect(names).not.toContain("generateImage");
    });

    it("配置了 defaultImageModel 时包含 generateImage", () => {
      const config: AppConfig = {
        defaultModel: "gpt4",
        endpoints: [{ id: "zhipu", name: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "sk-xxx" }],
        models: [{ id: "gpt4", name: "GPT-4", endpointId: "zhipu", maxContextTokens: 500000 }],
        imageModels: [{ id: "cogview", name: "CogView", endpointId: "zhipu", modelName: "cogview-4" }],
        defaultImageModel: "cogview",
      };
      const caps = new Capabilities(mockProvider({ config }));
      const names = caps.builtinInstances.map((t) => t.function.name);
      expect(names).toContain("generateImage");
    });

    it("能发现文件系统中的 SubAgent", () => {
      writeSubAgent("sa1", "agent_one");
      writeSubAgent("sa2", "agent_two");
      const provider = mockProvider({
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      const caps = new Capabilities(provider);
      expect(caps.subagentDefs).toHaveLength(2);
      expect(caps.subagentDefs[0].function!.name).toBe("agent_one");
      expect(caps.subagentDefs[1].function!.name).toBe("agent_two");
    });

    it("能发现文件系统中的 Skill", () => {
      writeSkill("code-review", "代码审查");
      writeSkill("deploy", "自动部署");
      const provider = mockProvider({
        skillsPaths: [join(tmpDir, "skills")],
      });
      const caps = new Capabilities(provider);
      expect(caps.skills).toHaveLength(2);
      expect(caps.skills[0].id).toBe("code-review");
      expect(caps.skills[1].id).toBe("deploy");
    });

    it("能发现文件系统中的 MCP 服务器", () => {
      writeMcpJson({ github: { transport: "stdio", command: "gh" } });
      const provider = mockProvider({
        mcpPaths: [join(tmpDir, "mcp.json")],
      });
      const caps = new Capabilities(provider);
      expect(caps.mcps).toHaveLength(1);
      expect(caps.mcps[0].id).toBe("github");
    });

    it("能发现文件系统中的用户工具", () => {
      writeUserTool("my-custom-tool");
      writeUserTool("another-tool");
      const provider = mockProvider({
        toolsPaths: [join(tmpDir, "tools")],
      });
      const caps = new Capabilities(provider);
      expect(caps.userInstances).toHaveLength(2);
      const names = caps.userInstances.map((t) => t.function.name);
      expect(names).toContain("my-custom-tool");
      expect(names).toContain("another-tool");
    });
  });

  describe("filter()", () => {
    it("allow all 时返回所有候选", () => {
      writeSubAgent("sa1", "agent_one");
      writeSkill("code-review", "代码审查");
      writeMcpJson({ github: { transport: "stdio", command: "gh" } });
      writeUserTool("my-tool");

      const provider = mockProvider({
        subAgentsPaths: [join(tmpDir, "sub-agents")],
        skillsPaths: [join(tmpDir, "skills")],
        mcpPaths: [join(tmpDir, "mcp.json")],
        toolsPaths: [join(tmpDir, "tools")],
      });
      const caps = new Capabilities(provider);
      const result = caps.filter(ALLOW_ALL);

      // tools: 内置 + 用户 + 5 个动态工具
      expect(result.tools.length).toBeGreaterThan(15);
      expect(result.tools).toContain("my-tool");
      expect(result.tools).toContain("load_skill");
      expect(result.tools).toContain("call_mcp_tool");
      expect(result.subagents).toContain("agent_one");
      expect(result.skills).toContain("code-review");
      expect(result.mcps).toContain("github");
    });

    it("deny all 时返回空", () => {
      writeSubAgent("sa1", "agent_one");
      const provider = mockProvider({
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      const caps = new Capabilities(provider);
      const result = caps.filter(DENY_ALL);
      expect(result.tools).toEqual([]);
      expect(result.subagents).toEqual([]);
      expect(result.skills).toEqual([]);
      expect(result.mcps).toEqual([]);
    });

    it("按工具白名单过滤", () => {
      const provider = mockProvider();
      const caps = new Capabilities(provider);
      const result = caps.filter({
        tools: { allow: ["readFile", "writeFile"] },
      });
      expect(result.tools).toContain("readFile");
      expect(result.tools).toContain("writeFile");
      expect(result.tools).not.toContain("exec");
    });

    it("按工具黑名单过滤", () => {
      const provider = mockProvider();
      const caps = new Capabilities(provider);
      const result = caps.filter({
        tools: { deny: ["exec", "rm"] },
        skills: { allow: ["*"] },
        mcps: { allow: ["*"] },
        subagents: { allow: ["*"] },
      });
      expect(result.tools).not.toContain("exec");
      expect(result.tools).not.toContain("rm");
      expect(result.tools).toContain("readFile");
    });

    it("exclude tools 黑名单优先级高于 permissions", () => {
      const provider = mockProvider();
      const caps = new Capabilities(provider);
      const result = caps.filter(ALLOW_ALL, {
        exclude: { tools: ["readFile"] },
      });
      expect(result.tools).not.toContain("readFile");
      expect(result.tools).toContain("writeFile");
    });

    it("exclude subagents 安全预过滤", () => {
      writeSubAgent("sa1", "agent_one");
      writeSubAgent("sa2", "agent_two");
      const provider = mockProvider({
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      const caps = new Capabilities(provider);
      const result = caps.filter(ALLOW_ALL, {
        exclude: { subagents: ["agent_one"] },
      });
      expect(result.subagents).not.toContain("agent_one");
      expect(result.subagents).toContain("agent_two");
    });

    it("exclude skills 安全预过滤", () => {
      writeSkill("skill-a", "A");
      writeSkill("skill-b", "B");
      const provider = mockProvider({
        skillsPaths: [join(tmpDir, "skills")],
      });
      const caps = new Capabilities(provider);
      const result = caps.filter(ALLOW_ALL, {
        exclude: { skills: ["skill-a"] },
      });
      expect(result.skills).not.toContain("skill-a");
      expect(result.skills).toContain("skill-b");
    });

    it("exclude mcps 安全预过滤", () => {
      writeMcpJson({ github: { transport: "stdio", command: "gh" }, slack: { transport: "stdio", command: "slack" } });
      const provider = mockProvider({
        mcpPaths: [join(tmpDir, "mcp.json")],
      });
      const caps = new Capabilities(provider);
      const result = caps.filter(ALLOW_ALL, {
        exclude: { mcps: ["github"] },
      });
      expect(result.mcps).not.toContain("github");
      expect(result.mcps).toContain("slack");
    });

    it("无 SubAgent function.name 的 Agent 被跳过", () => {
      const subDir = join(tmpDir, "sub-agents");
      mkdirSync(subDir, { recursive: true });
      // 无 function 字段的普通 Agent
      const def: AgentDefinition = {
        id: "normal-agent",
        name: "Normal",
        messages: [{ role: AgentNS.Role.System, content: "You are helpful." }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(join(subDir, "normal-agent.json"), JSON.stringify(def));

      const provider = mockProvider({
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      const caps = new Capabilities(provider);
      const result = caps.filter(ALLOW_ALL);
      expect(result.subagents).toEqual([]);
    });

    it("permissions 缺失时所有维度拒绝", () => {
      const provider = mockProvider();
      const caps = new Capabilities(provider);
      const result = caps.filter(undefined as any);
      expect(result.tools).toEqual([]);
      expect(result.subagents).toEqual([]);
      expect(result.skills).toEqual([]);
      expect(result.mcps).toEqual([]);
    });

    it("动态工具名始终在 toolNames 中", () => {
      const provider = mockProvider();
      const caps = new Capabilities(provider);
      const result = caps.filter(ALLOW_ALL);
      expect(result.tools).toContain("load_skill");
      expect(result.tools).toContain("call_skill_sub_agent");
      expect(result.tools).toContain("load_mcp");
      expect(result.tools).toContain("call_mcp_tool");
      expect(result.tools).toContain("read_mcp_resource");
    });

    it("无 skills/mcps 时动态工具仍出现在 tools 列表中", () => {
      const provider = mockProvider();
      const caps = new Capabilities(provider);
      const result = caps.filter(ALLOW_ALL);
      expect(result.tools).toContain("load_skill");
      expect(result.tools).toContain("load_mcp");
    });
  });

  describe("instantiate()", () => {
    it("空过滤结果返回空数组", () => {
      const caps = new Capabilities(mockProvider());
      const result = caps.instantiate({ tools: [], subagents: [], skills: [], mcps: [] });
      expect(result).toEqual([]);
    });

    it("只实例化过滤后的内置工具", () => {
      const caps = new Capabilities(mockProvider());
      const result = caps.instantiate({
        tools: ["readFile", "writeFile"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).toEqual(["readFile", "writeFile"]);
    });

    it("无 skills 时不注册 load_skill / call_skill_sub_agent", () => {
      const provider = mockProvider();
      const caps = new Capabilities(provider);
      const result = caps.instantiate({
        tools: ["load_skill", "call_skill_sub_agent", "readFile"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).not.toContain("load_skill");
      expect(names).not.toContain("call_skill_sub_agent");
      expect(names).toContain("readFile");
    });

    it("有 skills 时注册 load_skill / call_skill_sub_agent", () => {
      writeSkill("code-review", "代码审查");
      const provider = mockProvider({
        skillsPaths: [join(tmpDir, "skills")],
      });
      const caps = new Capabilities(provider);
      const result = caps.instantiate({
        tools: ["load_skill", "call_skill_sub_agent", "readFile"],
        subagents: [],
        skills: ["code-review"],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).toContain("load_skill");
      expect(names).toContain("call_skill_sub_agent");
      expect(names).toContain("readFile");
    });

    it("无 mcpManager 时不注册 MCP 工具", () => {
      const provider = mockProvider(); // getMcpManager 返回 undefined
      const caps = new Capabilities(provider);
      const result = caps.instantiate({
        tools: ["load_mcp", "call_mcp_tool", "read_mcp_resource", "readFile"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).not.toContain("load_mcp");
      expect(names).not.toContain("call_mcp_tool");
      expect(names).not.toContain("read_mcp_resource");
    });

    it("有 mcpManager 但无 mcps 时不注册 load_mcp（call 和 read 仍注册）", () => {
      const provider = mockProvider({
        getMcpManager: () => ({ getState: vi.fn(), getManifest: vi.fn(), getClient: vi.fn(), connect: vi.fn(), touch: vi.fn() } as any),
      });
      const caps = new Capabilities(provider);
      const result = caps.instantiate({
        tools: ["load_mcp", "call_mcp_tool", "read_mcp_resource"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).not.toContain("load_mcp");
      expect(names).toContain("call_mcp_tool");
      expect(names).toContain("read_mcp_resource");
    });

    it("有 mcpManager 且有 mcps 时注册 load_mcp", () => {
      writeMcpJson({ github: { transport: "stdio", command: "gh" } });
      const provider = mockProvider({
        getMcpManager: () => ({ getState: vi.fn(), getManifest: vi.fn(), getClient: vi.fn(), connect: vi.fn(), touch: vi.fn() } as any),
        mcpPaths: [join(tmpDir, "mcp.json")],
      });
      const caps = new Capabilities(provider);
      const result = caps.instantiate({
        tools: ["load_mcp", "call_mcp_tool", "read_mcp_resource"],
        subagents: [],
        skills: [],
        mcps: ["github"],
      });
      const names = result.map((t) => t.function.name);
      expect(names).toContain("load_mcp");
    });

    it("实例化 SubAgent 工具", () => {
      writeSubAgent("sa1", "agent_one");
      const provider = mockProvider({
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      const caps = new Capabilities(provider);
      const result = caps.instantiate({
        tools: [],
        subagents: ["agent_one"],
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).toContain("agent_one");
    });

    it("SubAgent 不在过滤结果中时不实例化", () => {
      writeSubAgent("sa1", "agent_one");
      const provider = mockProvider({
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      const caps = new Capabilities(provider);
      const result = caps.instantiate({
        tools: [],
        subagents: [], // 空
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).not.toContain("agent_one");
    });

    it("包含用户工具", () => {
      writeUserTool("my-tool");
      const provider = mockProvider({
        toolsPaths: [join(tmpDir, "tools")],
      });
      const caps = new Capabilities(provider);
      const result = caps.instantiate({
        tools: ["my-tool", "readFile"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).toContain("my-tool");
      expect(names).toContain("readFile");
    });
  });

  describe("buildTools() — filter + instantiate 快捷组合", () => {
    it("一步完成过滤和实例化", () => {
      writeSubAgent("sa1", "agent_one");
      writeSkill("code-review", "代码审查");
      const provider = mockProvider({
        subAgentsPaths: [join(tmpDir, "sub-agents")],
        skillsPaths: [join(tmpDir, "skills")],
      });
      const caps = new Capabilities(provider);
      const tools = caps.buildTools(ALLOW_ALL);
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("readFile");
      expect(names).toContain("agent_one");
      expect(names).toContain("load_skill");
    });

    it("支持 exclude 选项", () => {
      writeSubAgent("sa1", "agent_one");
      const provider = mockProvider({
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      const caps = new Capabilities(provider);
      const tools = caps.buildTools(ALLOW_ALL, {
        exclude: { subagents: ["agent_one"] },
      });
      const names = tools.map((t) => t.function.name);
      expect(names).not.toContain("agent_one");
    });
  });

  describe("refresh()", () => {
    it("重新发现文件系统变更", () => {
      const provider = mockProvider({
        skillsPaths: [join(tmpDir, "skills")],
      });
      const caps = new Capabilities(provider);
      expect(caps.skills).toEqual([]);

      // 新增 skill
      writeSkill("new-skill", "新技能");
      caps.refresh();
      expect(caps.skills).toHaveLength(1);
      expect(caps.skills[0].id).toBe("new-skill");
    });

    it("refresh 后 filter 使用最新候选集", () => {
      writeSubAgent("sa1", "agent_one");
      const provider = mockProvider({
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      const caps = new Capabilities(provider);
      expect(caps.filter(ALLOW_ALL).subagents).toContain("agent_one");

      // 删除 SubAgent 文件
      rmSync(join(tmpDir, "sub-agents", "sa1.json"));
      caps.refresh();
      expect(caps.filter(ALLOW_ALL).subagents).not.toContain("agent_one");
    });
  });

  describe("dedupTools — 去重", () => {
    it("后注册覆盖先注册", () => {
      const provider = mockProvider({
        toolsPaths: [join(tmpDir, "tools")],
      });
      // 先写一个用户工具和内置工具同名
      writeUserTool("readFile");
      const caps = new Capabilities(provider);
      const result = caps.instantiate({
        tools: ["readFile"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      // 应该只有 1 个 readFile（用户工具覆盖内置）
      const readFiles = result.filter((t) => t.function.name === "readFile");
      expect(readFiles).toHaveLength(1);
      // 用户工具是后发现的（userInstances 在 builtinInstances 之后），所以应覆盖
    });

    it("同名工具不重复", () => {
      const provider = mockProvider();
      const caps = new Capabilities(provider);
      // 手动注入重复
      caps.builtinInstances.push(makeTool("readFile"));
      const result = caps.instantiate({
        tools: ["readFile"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      const readFiles = result.filter((t) => t.function.name === "readFile");
      expect(readFiles).toHaveLength(1);
    });
  });

  describe("边缘情况", () => {
    it("所有发现目录不存在时不抛异常", () => {
      const provider = mockProvider({
        subAgentsPaths: [join(tmpDir, "nonexistent-sub")],
        skillsPaths: [join(tmpDir, "nonexistent-skills")],
        toolsPaths: [join(tmpDir, "nonexistent-tools")],
        mcpPaths: [join(tmpDir, "nonexistent-mcp.json")],
      });
      expect(() => new Capabilities(provider)).not.toThrow();
      const caps = new Capabilities(provider);
      expect(caps.subagentDefs).toEqual([]);
      expect(caps.skills).toEqual([]);
      expect(caps.userInstances).toEqual([]);
      expect(caps.mcps).toEqual([]);
    });

    it("permissions 部分维度缺失时缺失维度按 deny all 处理", () => {
      const provider = mockProvider();
      const caps = new Capabilities(provider);
      const result = caps.filter({
        tools: { allow: ["readFile"] },
        // skills, mcps, subagents 缺失
      } as AgentPermissions);
      expect(result.tools).toContain("readFile");
      expect(result.skills).toEqual([]);
      expect(result.mcps).toEqual([]);
      expect(result.subagents).toEqual([]);
    });
  });
});
