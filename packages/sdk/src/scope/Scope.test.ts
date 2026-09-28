import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Scope } from "./Scope.js";
import { allInOne } from "./plugins/allInOne.js";
import { BuiltinToolsScopePlugin } from "./plugins/builtin/BuiltinToolsScopePlugin.js";
import { discoverBuiltinTools } from "./plugins/builtin/discover.js";
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
      super();
      this.function = {
        name,
        description: `Tool ${name}`,
        parameters: { type: "object", properties: {}, required: [] },
      };
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

/** 把权限包成 AgentDefinition（filter/buildTools 现在接收 definition） */
function makeDef(permissions?: AgentPermissions, modelId?: string): AgentDefinition {
  return {
    id: "t",
    name: "T",
    messages: [{ role: AgentNS.Role.System, content: "You are helpful." }],
    permissions,
    modelId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 带真实文件系统的 Scope 能力发现
// ---------------------------------------------------------------------------
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ai-zen-caps-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 构造一个装配了标准插件（allInOne）并完成发现的 Scope */
async function makeScope(opts: {
  config?: AppConfig;
  subAgentsPaths?: string[];
  skillsPaths?: string[];
  toolsPaths?: string[];
  mcpPaths?: string[];
} = {}): Promise<Scope> {
  const scope = new Scope({
    config: opts.config ?? MIN_CONFIG,
    agentsDir: "",
    cwd: tmpDir,
  }).use(
    ...allInOne({
      subAgentsPaths: opts.subAgentsPaths,
      skillsPaths: opts.skillsPaths,
      toolsPaths: opts.toolsPaths,
      mcpPaths: opts.mcpPaths,
    }),
  );
  await scope.init();
  return scope;
}

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

describe("Scope 能力发现与过滤", () => {
  describe("内置工具（BuiltinToolsScopePlugin）", () => {
    it("discoverBuiltinTools 全量注册内置工具（含 generateImage / viewImage）", () => {
      const tools = discoverBuiltinTools({ cwd: tmpDir, config: MIN_CONFIG });
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("generateImage");
      expect(names).toContain("viewImage");
      expect(names.length).toBeGreaterThan(15);
    });

    it("空配置时内置工具可用（buildTools 后非空）", async () => {
      const scope = await makeScope();
      const tools = scope.buildTools(makeDef(ALLOW_ALL));
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("readFile");
      expect(names.length).toBeGreaterThan(5);
    });
  });

  describe("SubAgent 插件（SubAgentsScopePlugin）", () => {
    it("能发现文件系统中的 SubAgent", async () => {
      writeSubAgent("sa1", "agent_one");
      writeSubAgent("sa2", "agent_two");
      const scope = await makeScope({ subAgentsPaths: [join(tmpDir, "sub-agents")] });
      const result = scope.filter(makeDef(ALLOW_ALL));
      expect(result.subagents).toContain("agent_one");
      expect(result.subagents).toContain("agent_two");
    });

    it("无 SubAgent function.name 的 Agent 被跳过", async () => {
      const subDir = join(tmpDir, "sub-agents");
      mkdirSync(subDir, { recursive: true });
      const def: AgentDefinition = {
        id: "normal-agent",
        name: "Normal",
        messages: [{ role: AgentNS.Role.System, content: "You are helpful." }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(join(subDir, "normal-agent.json"), JSON.stringify(def));

      const scope = await makeScope({ subAgentsPaths: [join(tmpDir, "sub-agents")] });
      const result = scope.filter(makeDef(ALLOW_ALL));
      expect(result.subagents).toEqual([]);
    });
  });

  describe("Skill 插件（SkillsScopePlugin）", () => {
    it("能发现文件系统中的 Skill（含 sub-agent 标记）", async () => {
      writeSkill("code-review", "代码审查", true);
      writeSkill("deploy", "自动部署", false);
      const scope = await makeScope({ skillsPaths: [join(tmpDir, "skills")] });
      const result = scope.filter(makeDef(ALLOW_ALL));
      expect(result.skills).toContain("code-review");
      expect(result.skills).toContain("deploy");
    });

    it("有 skills 时注册 load_skill / call_skill_sub_agent", async () => {
      writeSkill("code-review", "代码审查");
      const scope = await makeScope({ skillsPaths: [join(tmpDir, "skills")] });
      const result = scope.instantiate({
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

    it("无 skills 时不注册 load_skill / call_skill_sub_agent", async () => {
      const scope = await makeScope();
      const result = scope.instantiate({
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

    it("仅有非 subAgent skill 时不注册 call_skill_sub_agent（load_skill 仍注册）", async () => {
      writeSkill("guide", "指导", false);
      const scope = await makeScope({ skillsPaths: [join(tmpDir, "skills")] });
      const result = scope.instantiate({
        tools: ["load_skill", "call_skill_sub_agent"],
        subagents: [],
        skills: ["guide"],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).toContain("load_skill");
      expect(names).not.toContain("call_skill_sub_agent");
    });
  });

  describe("MCP 插件（McpScopePlugin）", () => {
    it("能发现文件系统中的 MCP 服务器", async () => {
      writeMcpJson({ github: { transport: "stdio", command: "gh" } });
      const scope = await makeScope({ mcpPaths: [join(tmpDir, "mcp.json")] });
      const result = scope.filter(makeDef(ALLOW_ALL));
      expect(result.mcps).toContain("github");
    });

    it("无 mcpPaths 时不注册 MCP 工具", async () => {
      const scope = await makeScope();
      const result = scope.instantiate({
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
      // 提供一个（不存在的）mcp 配置文件：paths 非空 → mcpManager 创建
      const scope = await makeScope({ mcpPaths: [join(tmpDir, "nonexistent-mcp.json")] });
      const result = scope.instantiate({
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
      const scope = await makeScope({ mcpPaths: [join(tmpDir, "mcp.json")] });
      const result = scope.instantiate({
        tools: ["load_mcp", "call_mcp_tool", "read_mcp_resource"],
        subagents: [],
        skills: [],
        mcps: ["github"],
      });
      const names = result.map((t) => t.function.name);
      expect(names).toContain("load_mcp");
    });
  });

  describe("用户工具插件（UserToolsScopePlugin）", () => {
    it("能发现并实例化用户工具", async () => {
      writeUserTool("my-custom-tool");
      writeUserTool("another-tool");
      const scope = await makeScope({ toolsPaths: [join(tmpDir, "tools")] });
      const result = scope.instantiate({
        tools: ["my-custom-tool", "another-tool", "readFile"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).toContain("my-custom-tool");
      expect(names).toContain("another-tool");
      expect(names).toContain("readFile");
    });
  });

  describe("filter() — 权限过滤", () => {
    it("allow all 时返回所有候选", async () => {
      writeSubAgent("sa1", "agent_one");
      writeSkill("code-review", "代码审查");
      writeMcpJson({ github: { transport: "stdio", command: "gh" } });
      writeUserTool("my-tool");

      const scope = await makeScope({
        subAgentsPaths: [join(tmpDir, "sub-agents")],
        skillsPaths: [join(tmpDir, "skills")],
        mcpPaths: [join(tmpDir, "mcp.json")],
        toolsPaths: [join(tmpDir, "tools")],
      });
      const result = scope.filter(makeDef(ALLOW_ALL));

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
      const scope = await makeScope({ subAgentsPaths: [join(tmpDir, "sub-agents")] });
      const result = scope.filter(makeDef(DENY_ALL));
      expect(result.tools).toEqual([]);
      expect(result.subagents).toEqual([]);
      expect(result.skills).toEqual([]);
      expect(result.mcps).toEqual([]);
    });

    it("按工具白名单过滤", async () => {
      const scope = await makeScope();
      const result = scope.filter(makeDef({
        tools: { allow: ["readFile", "writeFile"] },
      }));
      expect(result.tools).toContain("readFile");
      expect(result.tools).toContain("writeFile");
      expect(result.tools).not.toContain("exec");
    });

    it("按工具黑名单过滤", async () => {
      const scope = await makeScope();
      const result = scope.filter(makeDef({
        tools: { deny: ["exec", "rm"] },
        skills: { allow: ["*"] },
        mcps: { allow: ["*"] },
        subagents: { allow: ["*"] },
      }));
      expect(result.tools).not.toContain("exec");
      expect(result.tools).not.toContain("rm");
      expect(result.tools).toContain("readFile");
    });

    it("exclude tools 黑名单优先级高于 permissions", async () => {
      const scope = await makeScope();
      const result = scope.filter(makeDef(ALLOW_ALL), {
        exclude: { tools: ["readFile"] },
      });
      expect(result.tools).not.toContain("readFile");
      expect(result.tools).toContain("writeFile");
    });

    it("exclude subagents 安全预过滤", async () => {
      writeSubAgent("sa1", "agent_one");
      writeSubAgent("sa2", "agent_two");
      const scope = await makeScope({ subAgentsPaths: [join(tmpDir, "sub-agents")] });
      const result = scope.filter(makeDef(ALLOW_ALL), {
        exclude: { subagents: ["agent_one"] },
      });
      expect(result.subagents).not.toContain("agent_one");
      expect(result.subagents).toContain("agent_two");
    });

    it("exclude skills 安全预过滤", async () => {
      writeSkill("skill-a", "A");
      writeSkill("skill-b", "B");
      const scope = await makeScope({ skillsPaths: [join(tmpDir, "skills")] });
      const result = scope.filter(makeDef(ALLOW_ALL), {
        exclude: { skills: ["skill-a"] },
      });
      expect(result.skills).not.toContain("skill-a");
      expect(result.skills).toContain("skill-b");
    });

    it("exclude mcps 安全预过滤", async () => {
      writeMcpJson({ github: { transport: "stdio", command: "gh" }, slack: { transport: "stdio", command: "slack" } });
      const scope = await makeScope({ mcpPaths: [join(tmpDir, "mcp.json")] });
      const result = scope.filter(makeDef(ALLOW_ALL), {
        exclude: { mcps: ["github"] },
      });
      expect(result.mcps).not.toContain("github");
      expect(result.mcps).toContain("slack");
    });

    it("permissions 缺失时所有维度拒绝", async () => {
      const scope = await makeScope();
      const result = scope.filter(makeDef(undefined) as any);
      expect(result.tools).toEqual([]);
      expect(result.subagents).toEqual([]);
      expect(result.skills).toEqual([]);
      expect(result.mcps).toEqual([]);
    });

    it("permissions 部分维度缺失时缺失维度按 deny all 处理", async () => {
      const scope = await makeScope();
      const result = scope.filter(makeDef({
        tools: { allow: ["readFile"] },
        // skills, mcps, subagents 缺失
      } as AgentPermissions));
      expect(result.tools).toContain("readFile");
      expect(result.skills).toEqual([]);
      expect(result.mcps).toEqual([]);
      expect(result.subagents).toEqual([]);
    });

    it("动态工具名始终在 toolNames 中", async () => {
      const scope = await makeScope();
      const result = scope.filter(makeDef(ALLOW_ALL));
      expect(result.tools).toContain("load_skill");
      expect(result.tools).toContain("call_skill_sub_agent");
      expect(result.tools).toContain("load_mcp");
      expect(result.tools).toContain("call_mcp_tool");
      expect(result.tools).toContain("read_mcp_resource");
    });

    it("无 skills/mcps 时动态工具仍出现在 tools 列表中", async () => {
      const scope = await makeScope();
      const result = scope.filter(makeDef(ALLOW_ALL));
      expect(result.tools).toContain("load_skill");
      expect(result.tools).toContain("load_mcp");
    });
  });

  describe("instantiate()", () => {
    it("空过滤结果返回空数组", async () => {
      const scope = await makeScope();
      const result = scope.instantiate({ tools: [], subagents: [], skills: [], mcps: [] });
      expect(result).toEqual([]);
    });

    it("只实例化过滤后的内置工具", async () => {
      const scope = await makeScope();
      const result = scope.instantiate({
        tools: ["readFile", "writeFile"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).toEqual(["readFile", "writeFile"]);
    });

    it("实例化 SubAgent 工具", async () => {
      writeSubAgent("sa1", "agent_one");
      const scope = await makeScope({ subAgentsPaths: [join(tmpDir, "sub-agents")] });
      const result = scope.instantiate({
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
      const scope = await makeScope({ subAgentsPaths: [join(tmpDir, "sub-agents")] });
      const result = scope.instantiate({
        tools: [],
        subagents: [], // 空
        skills: [],
        mcps: [],
      });
      const names = result.map((t) => t.function.name);
      expect(names).not.toContain("agent_one");
    });
  });

  describe("buildTools() — filter + instantiate 快捷组合", () => {
    it("一步完成过滤和实例化", async () => {
      writeSubAgent("sa1", "agent_one");
      writeSkill("code-review", "代码审查");
      const scope = await makeScope({
        subAgentsPaths: [join(tmpDir, "sub-agents")],
        skillsPaths: [join(tmpDir, "skills")],
      });
      const tools = scope.buildTools(makeDef(ALLOW_ALL));
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("readFile");
      expect(names).toContain("agent_one");
      expect(names).toContain("load_skill");
    });

    it("buildTools: 非视觉模型剔除 viewImage，视觉模型保留", async () => {
      const config: AppConfig = {
        defaultModel: "gpt4",
        endpoints: [],
        models: [
          { id: "gpt4", name: "GPT-4", endpointId: "ep", modelName: "gpt4", maxContextTokens: 100000 },
          { id: "vision", name: "Vision", endpointId: "ep", modelName: "vision-1", maxContextTokens: 100000, vision: true },
        ],
      };
      const scope = await makeScope({ config });

      // 不传 modelId：viewImage 无法确认视觉能力 → 被过滤
      const noModel = scope.buildTools(makeDef(ALLOW_ALL));
      expect(noModel.map((t) => t.function.name)).not.toContain("viewImage");

      // 非视觉模型：剔除 viewImage
      const nonVision = scope.buildTools(makeDef(ALLOW_ALL, "gpt4"));
      expect(nonVision.map((t) => t.function.name)).not.toContain("viewImage");

      // 视觉模型：保留 viewImage
      const vision = scope.buildTools(makeDef(ALLOW_ALL, "vision"));
      expect(vision.map((t) => t.function.name)).toContain("viewImage");
    });

    it("buildTools: generateImage 仅当配置了 defaultImageModel 时可用", async () => {
      // 未配置图片模型：generateImage 不可用
      const scope = await makeScope();
      const noImg = scope.buildTools(makeDef(ALLOW_ALL, "gpt4"));
      expect(noImg.map((t) => t.function.name)).not.toContain("generateImage");

      // 配置了 defaultImageModel：generateImage 可用
      const imgConfig: AppConfig = {
        defaultModel: "gpt4",
        endpoints: [{ id: "zhipu", name: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "sk-xxx" }],
        models: [{ id: "gpt4", name: "GPT-4", endpointId: "zhipu", maxContextTokens: 500000 }],
        imageModels: [{ id: "cogview", name: "CogView", endpointId: "zhipu", modelName: "cogview-4" }],
        defaultImageModel: "cogview",
      };
      const scope2 = await makeScope({ config: imgConfig });
      const withImg = scope2.buildTools(makeDef(ALLOW_ALL, "gpt4"));
      expect(withImg.map((t) => t.function.name)).toContain("generateImage");
    });

    it("支持 exclude 选项", async () => {
      writeSubAgent("sa1", "agent_one");
      const scope = await makeScope({ subAgentsPaths: [join(tmpDir, "sub-agents")] });
      const tools = scope.buildTools(makeDef(ALLOW_ALL), {
        exclude: { subagents: ["agent_one"] },
      });
      const names = tools.map((t) => t.function.name);
      expect(names).not.toContain("agent_one");
    });
  });

  describe("refresh()", () => {
    it("重新发现文件系统变更", async () => {
      const scope = await makeScope({ skillsPaths: [join(tmpDir, "skills")] });
      expect(scope.filter(makeDef(ALLOW_ALL)).skills).toEqual([]);

      // 新增 skill
      writeSkill("new-skill", "新技能");
      await scope.refresh();
      const result = scope.filter(makeDef(ALLOW_ALL)).skills;
      expect(result).toHaveLength(1);
      expect(result[0]).toBe("new-skill");
    });

    it("refresh 后 filter 使用最新候选集", async () => {
      writeSubAgent("sa1", "agent_one");
      const scope = await makeScope({ subAgentsPaths: [join(tmpDir, "sub-agents")] });
      expect(scope.filter(makeDef(ALLOW_ALL)).subagents).toContain("agent_one");

      // 删除 SubAgent 文件
      rmSync(join(tmpDir, "sub-agents", "sa1.json"));
      await scope.refresh();
      expect(scope.filter(makeDef(ALLOW_ALL)).subagents).not.toContain("agent_one");
    });
  });

  describe("dedupTools — 去重", () => {
    it("后注册覆盖先注册（用户工具覆盖同名内置工具）", async () => {
      writeUserTool("readFile");
      const scope = await makeScope({ toolsPaths: [join(tmpDir, "tools")] });
      const result = scope.instantiate({
        tools: ["readFile"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      const readFiles = result.filter((t) => t.function.name === "readFile");
      expect(readFiles).toHaveLength(1);
    });

    it("同名工具不重复（两个同名插件）", async () => {
      const scope = new Scope({ config: MIN_CONFIG, agentsDir: "", cwd: tmpDir })
        .use(new BuiltinToolsScopePlugin())
        .use(new BuiltinToolsScopePlugin());
      await scope.init();
      const result = scope.instantiate({
        tools: ["readFile"],
        subagents: [],
        skills: [],
        mcps: [],
      });
      const readFiles = result.filter((t) => t.function.name === "readFile");
      expect(readFiles).toHaveLength(1);
    });
  });

  describe("插件生命周期", () => {
    it("init() 之后再 use() 抛错", async () => {
      const scope = await makeScope();
      expect(() => scope.use(new BuiltinToolsScopePlugin())).toThrow();
    });

    it("getPluginById 可查到已注册插件", async () => {
      const scope = await makeScope();
      expect(scope.getPluginById(BuiltinToolsScopePlugin.ID)).toBeInstanceOf(
        BuiltinToolsScopePlugin,
      );
      expect(scope.getPluginById("nope")).toBeUndefined();
    });
  });

  describe("边缘情况", () => {
    it("所有发现目录不存在时不抛异常", async () => {
      const scope = await makeScope({
        subAgentsPaths: [join(tmpDir, "nonexistent-sub")],
        skillsPaths: [join(tmpDir, "nonexistent-skills")],
        toolsPaths: [join(tmpDir, "nonexistent-tools")],
        mcpPaths: [join(tmpDir, "nonexistent-mcp.json")],
      });
      const result = scope.filter(makeDef(ALLOW_ALL));
      expect(result.subagents).toEqual([]);
      expect(result.skills).toEqual([]);
      expect(result.mcps).toEqual([]);
    });
  });
});
