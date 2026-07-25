import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Provider } from "../runtime/Provider.js";
import type { AppConfig, AgentPermissions } from "../types/index.js";
import type { AgentDefinition } from "../types/index.js";
import { AgentNS, Tool } from "@ai-zen/agents-core";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const MIN_CONFIG: AppConfig = {
  defaultModel: "gpt4",
  endpoints: [],
  models: [],
};

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
// 带真实文件系统的 Provider 能力发现
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
    join(toolDir, `${name}.mjs`),
    `
export default {
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

describe("Provider 能力发现与过滤", () => {
  describe("constructor — 全局发现", () => {
    it("空配置时内置工具不为空", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      expect(provider.builtinTools.length).toBeGreaterThan(0);
      expect(provider.userTools).toEqual([]);
      expect(provider.subagents).toEqual([]);
      expect(provider.skills).toEqual([]);
      expect(provider.mcps).toEqual([]);
    });

    it("未配置 defaultImageModel 时不包含 generateImage", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      const names = provider.builtinTools.map((t) => t.function.name);
      expect(names).not.toContain("generateImage");
    });

    it("配置了 defaultImageModel 时包含 generateImage", async () => {
      const config: AppConfig = {
        defaultModel: "gpt4",
        endpoints: [{ id: "zhipu", name: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "sk-xxx" }],
        models: [{ id: "gpt4", name: "GPT-4", endpointId: "zhipu", maxContextTokens: 500000 }],
        imageModels: [{ id: "cogview", name: "CogView", endpointId: "zhipu", modelName: "cogview-4" }],
        defaultImageModel: "cogview",
      };
      const provider = new Provider({ config, agentsDir: "" });
      await provider.refresh();
      const names = provider.builtinTools.map((t) => t.function.name);
      expect(names).toContain("generateImage");
    });

    it("能发现文件系统中的 SubAgent", async () => {
      writeSubAgent("sa1", "agent_one");
      writeSubAgent("sa2", "agent_two");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      await provider.refresh();
      expect(provider.subagents).toHaveLength(2);
      expect(provider.subagents[0].function!.name).toBe("agent_one");
      expect(provider.subagents[1].function!.name).toBe("agent_two");
    });

    it("能发现文件系统中的 Skill", async () => {
      writeSkill("code-review", "代码审查");
      writeSkill("deploy", "自动部署");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        skillsPaths: [join(tmpDir, "skills")],
      });
      await provider.refresh();
      expect(provider.skills).toHaveLength(2);
      expect(provider.skills[0].id).toBe("code-review");
      expect(provider.skills[1].id).toBe("deploy");
    });

    it("能发现文件系统中的 MCP 服务器", async () => {
      writeMcpJson({ github: { transport: "stdio", command: "gh" } });
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        mcpPaths: [join(tmpDir, "mcp.json")],
      });
      await provider.refresh();
      expect(provider.mcps).toHaveLength(1);
      expect(provider.mcps[0].id).toBe("github");
    });

    it("能发现文件系统中的用户工具", async () => {
      writeUserTool("my-custom-tool");
      writeUserTool("another-tool");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        toolsPaths: [join(tmpDir, "tools")],
      });
      await provider.refresh();
      expect(provider.userTools).toHaveLength(2);
      const names = provider.userTools.map((t) => t.function.name);
      expect(names).toContain("my-custom-tool");
      expect(names).toContain("another-tool");
    });
  });

  describe("filter()", () => {
    it("allow all 时返回所有候选", async () => {
      writeSubAgent("sa1", "agent_one");
      writeSkill("code-review", "代码审查");
      writeMcpJson({ github: { transport: "stdio", command: "gh" } });
      writeUserTool("my-tool");

      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        subAgentsPaths: [join(tmpDir, "sub-agents")],
        skillsPaths: [join(tmpDir, "skills")],
        mcpPaths: [join(tmpDir, "mcp.json")],
        toolsPaths: [join(tmpDir, "tools")],
      });
      await provider.refresh();
      const result = provider.filter(ALLOW_ALL);

      // tools: 内置 + 用户 + 5 个动态工具
      expect(result.tools.length).toBeGreaterThan(15);
      expect(result.tools).toContain("my-tool");
      expect(result.tools).toContain("load_skill");
      expect(result.tools).toContain("call_mcp_tool");
      expect(result.subagents).toContain("agent_one");
      expect(result.skills).toContain("code-review");
      expect(result.mcps).toContain("github");
    });

    it("deny all 时返回空", async () => {
      writeSubAgent("sa1", "agent_one");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      await provider.refresh();
      const result = provider.filter(DENY_ALL);
      expect(result.tools).toEqual([]);
      expect(result.subagents).toEqual([]);
      expect(result.skills).toEqual([]);
      expect(result.mcps).toEqual([]);
    });

    it("按工具白名单过滤", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      const result = provider.filter({
        tools: { allow: ["readFile", "writeFile"] },
      });
      expect(result.tools).toContain("readFile");
      expect(result.tools).toContain("writeFile");
      expect(result.tools).not.toContain("exec");
    });

    it("按工具黑名单过滤", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      const result = provider.filter({
        tools: { deny: ["exec", "rm"] },
        skills: { allow: ["*"] },
        mcps: { allow: ["*"] },
        subagents: { allow: ["*"] },
      });
      expect(result.tools).not.toContain("exec");
      expect(result.tools).not.toContain("rm");
      expect(result.tools).toContain("readFile");
    });

    it("exclude tools 黑名单优先级高于 permissions", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      const result = provider.filter(ALLOW_ALL, {
        exclude: { tools: ["readFile"] },
      });
      expect(result.tools).not.toContain("readFile");
      expect(result.tools).toContain("writeFile");
    });

    it("exclude subagents 安全预过滤", async () => {
      writeSubAgent("sa1", "agent_one");
      writeSubAgent("sa2", "agent_two");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      await provider.refresh();
      const result = provider.filter(ALLOW_ALL, {
        exclude: { subagents: ["agent_one"] },
      });
      expect(result.subagents).not.toContain("agent_one");
      expect(result.subagents).toContain("agent_two");
    });

    it("exclude skills 安全预过滤", async () => {
      writeSkill("skill-a", "A");
      writeSkill("skill-b", "B");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        skillsPaths: [join(tmpDir, "skills")],
      });
      await provider.refresh();
      const result = provider.filter(ALLOW_ALL, {
        exclude: { skills: ["skill-a"] },
      });
      expect(result.skills).not.toContain("skill-a");
      expect(result.skills).toContain("skill-b");
    });

    it("exclude mcps 安全预过滤", async () => {
      writeMcpJson({ github: { transport: "stdio", command: "gh" }, slack: { transport: "stdio", command: "slack" } });
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        mcpPaths: [join(tmpDir, "mcp.json")],
      });
      await provider.refresh();
      const result = provider.filter(ALLOW_ALL, {
        exclude: { mcps: ["github"] },
      });
      expect(result.mcps).not.toContain("github");
      expect(result.mcps).toContain("slack");
    });

    it("无 SubAgent function.name 的 Agent 被跳过", async () => {
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

      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      await provider.refresh();
      const result = provider.filter(ALLOW_ALL);
      expect(result.subagents).toEqual([]);
    });

    it("permissions 缺失时所有维度拒绝", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      const result = provider.filter(undefined as any);
      expect(result.tools).toEqual([]);
      expect(result.subagents).toEqual([]);
      expect(result.skills).toEqual([]);
      expect(result.mcps).toEqual([]);
    });

    it("动态工具名始终在 toolNames 中", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      const result = provider.filter(ALLOW_ALL);
      expect(result.tools).toContain("load_skill");
      expect(result.tools).toContain("call_skill_sub_agent");
      expect(result.tools).toContain("load_mcp");
      expect(result.tools).toContain("call_mcp_tool");
      expect(result.tools).toContain("read_mcp_resource");
    });

    it("无 skills/mcps 时动态工具仍出现在 tools 列表中", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      const result = provider.filter(ALLOW_ALL);
      expect(result.tools).toContain("load_skill");
      expect(result.tools).toContain("load_mcp");
    });
  });

  describe("instantiate()", () => {
    it("空过滤结果返回空数组", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      const result = provider.instantiate({ tools: [], subagents: [], skills: [], mcps: [] });
      expect(result).toEqual([]);
    });

    it("只实例化过滤后的内置工具", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      const result = provider.instantiate({
        tools: ["readFile", "writeFile"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).toEqual(["readFile", "writeFile"]);
    });

    it("无 skills 时不注册 load_skill / call_skill_sub_agent", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      const result = provider.instantiate({
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

    it("有 skills 时注册 load_skill / call_skill_sub_agent", async () => {
      writeSkill("code-review", "代码审查");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        skillsPaths: [join(tmpDir, "skills")],
      });
      await provider.refresh();
      const result = provider.instantiate({
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

    it("无 mcpManager 时不注册 MCP 工具", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      const result = provider.instantiate({
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

    it("有 mcpManager 但无 mcps 时不注册 load_mcp（call 和 read 仍注册）", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      (provider as any).mcpManager = {
        getState: vi.fn(),
        getManifest: vi.fn(),
        getClient: vi.fn(),
        connect: vi.fn(),
        touch: vi.fn(),
      };
      await provider.refresh();
      const result = provider.instantiate({
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

    it("有 mcpManager 且有 mcps 时注册 load_mcp", async () => {
      writeMcpJson({ github: { transport: "stdio", command: "gh" } });
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        mcpPaths: [join(tmpDir, "mcp.json")],
      });
      (provider as any).mcpManager = {
        getState: vi.fn(),
        getManifest: vi.fn(),
        getClient: vi.fn(),
        connect: vi.fn(),
        touch: vi.fn(),
      };
      await provider.refresh();
      const result = provider.instantiate({
        tools: ["load_mcp", "call_mcp_tool", "read_mcp_resource"],
        subagents: [],
        skills: [],
        mcps: ["github"],
      });
      const names = result.map((t) => t.function.name);
      expect(names).toContain("load_mcp");
    });

    it("实例化 SubAgent 工具", async () => {
      writeSubAgent("sa1", "agent_one");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      await provider.refresh();
      const result = provider.instantiate({
        tools: [],
        subagents: ["agent_one"],
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).toContain("agent_one");
    });

    it("SubAgent 不在过滤结果中时不实例化", async () => {
      writeSubAgent("sa1", "agent_one");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      await provider.refresh();
      const result = provider.instantiate({
        tools: [],
        subagents: [], // 空
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).not.toContain("agent_one");
    });

    it("包含用户工具", async () => {
      writeUserTool("my-tool");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        toolsPaths: [join(tmpDir, "tools")],
      });
      await provider.refresh();
      const result = provider.instantiate({
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
    it("一步完成过滤和实例化", async () => {
      writeSubAgent("sa1", "agent_one");
      writeSkill("code-review", "代码审查");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        subAgentsPaths: [join(tmpDir, "sub-agents")],
        skillsPaths: [join(tmpDir, "skills")],
      });
      await provider.refresh();
      const tools = provider.buildTools(ALLOW_ALL);
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("readFile");
      expect(names).toContain("agent_one");
      expect(names).toContain("load_skill");
    });

    it("支持 exclude 选项", async () => {
      writeSubAgent("sa1", "agent_one");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      await provider.refresh();
      const tools = provider.buildTools(ALLOW_ALL, {
        exclude: { subagents: ["agent_one"] },
      });
      const names = tools.map((t) => t.function.name);
      expect(names).not.toContain("agent_one");
    });
  });

  describe("refresh()", () => {
    it("重新发现文件系统变更", async () => {
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        skillsPaths: [join(tmpDir, "skills")],
      });
      await provider.refresh();
      expect(provider.skills).toEqual([]);

      // 新增 skill
      writeSkill("new-skill", "新技能");
      await provider.refresh();
      expect(provider.skills).toHaveLength(1);
      expect(provider.skills[0].id).toBe("new-skill");
    });

    it("refresh 后 filter 使用最新候选集", async () => {
      writeSubAgent("sa1", "agent_one");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        subAgentsPaths: [join(tmpDir, "sub-agents")],
      });
      await provider.refresh();
      expect(provider.filter(ALLOW_ALL).subagents).toContain("agent_one");

      // 删除 SubAgent 文件
      rmSync(join(tmpDir, "sub-agents", "sa1.json"));
      await provider.refresh();
      expect(provider.filter(ALLOW_ALL).subagents).not.toContain("agent_one");
    });
  });

  describe("dedupTools — 去重", () => {
    it("后注册覆盖先注册", async () => {
      writeUserTool("readFile");
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        toolsPaths: [join(tmpDir, "tools")],
      });
      await provider.refresh();
      const result = provider.instantiate({
        tools: ["readFile"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      // 应该只有 1 个 readFile（用户工具覆盖内置）
      const readFiles = result.filter((t) => t.function.name === "readFile");
      expect(readFiles).toHaveLength(1);
    });

    it("同名工具不重复", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      // 手动注入重复
      provider.builtinTools.push(makeTool("readFile"));
      const result = provider.instantiate({
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
    it("所有发现目录不存在时不抛异常", async () => {
      const provider = new Provider({
        config: MIN_CONFIG,
        agentsDir: "",
        subAgentsPaths: [join(tmpDir, "nonexistent-sub")],
        skillsPaths: [join(tmpDir, "nonexistent-skills")],
        toolsPaths: [join(tmpDir, "nonexistent-tools")],
        mcpPaths: [join(tmpDir, "nonexistent-mcp.json")],
      });
      await provider.refresh();
      expect(provider.subagents).toEqual([]);
      expect(provider.skills).toEqual([]);
      expect(provider.userTools).toEqual([]);
      expect(provider.mcps).toEqual([]);
    });

    it("permissions 部分维度缺失时缺失维度按 deny all 处理", async () => {
      const provider = new Provider({ config: MIN_CONFIG, agentsDir: "" });
      await provider.refresh();
      const result = provider.filter({
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
