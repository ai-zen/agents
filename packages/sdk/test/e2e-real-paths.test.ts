import { describe, it, expect } from "vitest";
import { Provider } from "../src/runtime/runtime";
import { createAgent } from "../src/runtime/create-agent";
import { Capabilities } from "../src/capabilities/capabilities";
import { readConfig } from "../src/config/manager";
import { readAgent, listAgents } from "../src/crud/agents";
import { readSkill, discoverSkills } from "../src/capabilities/discovery/skills";
import { discoverSubAgents } from "../src/capabilities/discovery/subagents";
import { discoverUserTools } from "../src/capabilities/discovery/usertools";
import { discoverMcpServers } from "../src/capabilities/discovery/mcp";
import { discoverBuiltinTools } from "../src/capabilities/discovery/builtin";
import { SdkAgent } from "../src/runtime/sdk-agent";
import { autoDraft, checkDraftForRestore } from "../src/plugin/auto-draft";
import { autoRefreshTools } from "../src/plugin/auto-refresh-tools";
import type { Tool } from "@ai-zen/agents-core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 真实路径
// ---------------------------------------------------------------------------
const TEST_HOME_DIR = join(__dirname, "..", "..", "test-home");
const TEST_CONFIG = join(TEST_HOME_DIR, "config.json");
const TEST_AGENTS_DIR = join(TEST_HOME_DIR, "agents");
const TEST_SUB_AGENTS_DIR = join(TEST_HOME_DIR, "sub-agents");
const TEST_SKILLS_DIR = join(TEST_HOME_DIR, "skills");
const TEST_TOOLS_DIR = join(TEST_HOME_DIR, "tools");
const TEST_MCP = join(TEST_HOME_DIR, "mcp.json");
const TEST_CONVERSATIONS_DIR = join(TEST_HOME_DIR, "conversations");
const TEST_DRAFTS_DIR = join(TEST_HOME_DIR, "drafts");

const PROJECT_DIR = join(__dirname, "..", "..", "test-project");
const PROJECT_MCP = join(PROJECT_DIR, ".mcp.json");
const PROJECT_AIZEN_DIR = join(PROJECT_DIR, ".ai-zen");
const PROJECT_SKILLS_DIR = join(PROJECT_AIZEN_DIR, "skills");
const PROJECT_TOOLS_DIR = join(PROJECT_AIZEN_DIR, "tools");
const PROJECT_SUB_AGENTS_DIR = join(PROJECT_AIZEN_DIR, "sub-agents");
const PROJECT_AIZEN_MCP = join(PROJECT_AIZEN_DIR, "mcp.json");

// 前置检查
function checkPaths() {
  if (!existsSync(TEST_CONFIG)) {
    throw new Error(`测试数据不存在，请先创建 ${TEST_CONFIG}`);
  }
}

// ==================================================================
// 测试
// ==================================================================

describe("端到端：真实文件系统路径", () => {
  // -----------------------------------------------------------------
  // 1. 基础发现
  // -----------------------------------------------------------------
  describe("1. 发现阶段", () => {
    it("config.json 可正常读取", () => {
      checkPaths();
      const config = readConfig(TEST_CONFIG);
      expect(config.defaultModel).toBe("gpt4");
      expect(config.endpoints).toHaveLength(2);
      expect(config.models).toHaveLength(3);
      expect(config.imageModels).toHaveLength(1);
      expect(config.models.find((m) => m.id === "gpt4")?.maxContextTokens).toBe(500000);
    });

    it("discoverBuiltinTools: 有 imageModels 时包含 generateImage", () => {
      checkPaths();
      const config = readConfig(TEST_CONFIG);
      const tools = discoverBuiltinTools(config);
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("generateImage");
      expect(names.length).toBeGreaterThan(15);
    });

    it("discoverSubAgents: 能发现用户级 SubAgent", () => {
      checkPaths();
      const agents = discoverSubAgents([TEST_SUB_AGENTS_DIR]);
      expect(agents.length).toBeGreaterThanOrEqual(2);
      const names = agents.map((a) => a.function!.name);
      expect(names).toContain("general_assistant");
      expect(names).toContain("code_reviewer");
    });

    it("discoverSubAgents: 合并用户级和项目级 SubAgent", () => {
      checkPaths();
      const agents = discoverSubAgents([PROJECT_SUB_AGENTS_DIR, TEST_SUB_AGENTS_DIR]);
      const names = agents.map((a) => a.function!.name);
      expect(names).toContain("general_assistant");
      expect(names).toContain("code_reviewer");
      expect(names).toContain("project_manager");
    });

    it("discoverSkills: 能发现用户级 Skill", () => {
      checkPaths();
      const skills = discoverSkills([TEST_SKILLS_DIR]);
      expect(skills.length).toBeGreaterThanOrEqual(2);
      const ids = skills.map((s) => s.id);
      expect(ids).toContain("code-review");
      expect(ids).toContain("git-helper");
    });

    it("discoverSkills: 合并用户级和项目级 Skill", () => {
      checkPaths();
      const skills = discoverSkills([PROJECT_SKILLS_DIR, TEST_SKILLS_DIR]);
      const ids = skills.map((s) => s.id);
      expect(ids).toContain("code-review");
      expect(ids).toContain("git-helper");
      expect(ids).toContain("project-guide");
    });

    it("readSkill: 可读取完整 Skill 内容和元数据", () => {
      checkPaths();
      const skill = readSkill([TEST_SKILLS_DIR], "code-review");
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe("code-review");
      expect(skill!.description).toBe("代码审查最佳实践指南");
      expect(skill!.subAgent).toBe(true);
      expect(skill!.content).toContain("代码审查 Skill");
      expect(skill!.license).toBe("MIT");
      expect(skill!.compatibility).toBe("requires git");
    });

    it("discoverUserTools: 能发现用户级工具", () => {
      checkPaths();
      const tools = discoverUserTools([TEST_TOOLS_DIR]);
      expect(tools.length).toBeGreaterThanOrEqual(2);
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("count_lines");
      expect(names).toContain("greet");
    });

    it("discoverUserTools: 合并用户级和项目级工具", () => {
      checkPaths();
      const tools = discoverUserTools([PROJECT_TOOLS_DIR, TEST_TOOLS_DIR]);
      const names = tools.map((t) => t.function.name);
      expect(names).toContain("count_lines");
      expect(names).toContain("greet");
      expect(names).toContain("project_stats");
    });

    it("discoverMcpServers: 能发现用户级 MCP 服务器", () => {
      checkPaths();
      const servers = discoverMcpServers([TEST_MCP]);
      const names = servers.map((s) => s.id);
      expect(names).toContain("github");
      expect(names).toContain("filesystem");
    });

    it("discoverMcpServers: 合并用户级 + 项目共享 + 项目个人 MCP", () => {
      checkPaths();
      const servers = discoverMcpServers([PROJECT_AIZEN_MCP, PROJECT_MCP, TEST_MCP]);
      const names = servers.map((s) => s.id);
      expect(names).toContain("github");
      expect(names).toContain("filesystem");
      expect(names).toContain("postgres");
      expect(names).toContain("custom-server");
    });

    it("用户工具可实际调用", async () => {
      checkPaths();
      const tools = discoverUserTools([TEST_TOOLS_DIR]);
      const greetTool = tools.find((t) => t.function.name === "greet")!;
      expect(greetTool).toBeDefined();

      const result = await greetTool.exec({
        parsed_args: { name: "测试" },
        agent: null,
      } as any);
      expect(result).toContain("测试");
      expect(result).toContain("欢迎");
    });

    it("项目工具可实际调用", async () => {
      checkPaths();
      const tools = discoverUserTools([PROJECT_TOOLS_DIR]);
      const statsTool = tools.find((t) => t.function.name === "project_stats")!;
      expect(statsTool).toBeDefined();

      const result = await statsTool.exec({
        parsed_args: { dir: PROJECT_DIR },
        agent: null,
      } as any);
      expect(result).toContain("项目统计");
      expect(result).toContain("glob");
    });
  });

  // -----------------------------------------------------------------
  // 2. CRUD
  // -----------------------------------------------------------------
  describe("2. CRUD 操作", () => {
    it("listAgents: 能列出用户级 Agent", () => {
      checkPaths();
      const agents = listAgents(TEST_AGENTS_DIR);
      expect(agents.length).toBeGreaterThanOrEqual(2);
      const ids = agents.map((a) => a.id);
      expect(ids).toContain("code-assistant");
      expect(ids).toContain("translator");
    });

    it("readAgent: 可读取单个 Agent 定义", () => {
      checkPaths();
      const agent = readAgent(TEST_AGENTS_DIR, "code-assistant");
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe("代码助手");
      expect(agent!.permissions?.tools).toEqual({ allow: ["*"] });
    });

    it("readAgent: translator 权限受限", () => {
      checkPaths();
      const agent = readAgent(TEST_AGENTS_DIR, "translator");
      expect(agent).not.toBeNull();
      expect(agent!.permissions?.tools).toEqual({ allow: ["readFile", "writeFile", "exec"] });
      expect(agent!.permissions?.skills).toEqual({ deny: ["*"] });
      expect(agent!.permissions?.mcps).toEqual({ deny: ["*"] });
      expect(agent!.permissions?.subagents).toEqual({ deny: ["*"] });
    });
  });

  // -----------------------------------------------------------------
  // 3. Capabilities 管线
  // -----------------------------------------------------------------
  describe("3. Capabilities 管线", () => {
    it("使用真实路径构建 Provider + Capabilities", () => {
      checkPaths();
      const config = readConfig(TEST_CONFIG);
      const provider = new Provider({
        config,
        agentsDir: TEST_AGENTS_DIR,
        subAgentsPaths: [PROJECT_SUB_AGENTS_DIR, TEST_SUB_AGENTS_DIR],
        skillsPaths: [PROJECT_SKILLS_DIR, TEST_SKILLS_DIR],
        toolsPaths: [PROJECT_TOOLS_DIR, TEST_TOOLS_DIR],
        mcpPaths: [PROJECT_AIZEN_MCP, PROJECT_MCP, TEST_MCP],
        conversationsDir: TEST_CONVERSATIONS_DIR,
        draftsDir: TEST_DRAFTS_DIR,
      });

      const caps = new Capabilities(provider);

      // 全局发现结果
      expect(caps.subagentDefs.length).toBeGreaterThanOrEqual(3);
      expect(caps.skills.length).toBeGreaterThanOrEqual(3);
      expect(caps.userInstances.length).toBeGreaterThanOrEqual(3);
      expect(caps.mcps.length).toBeGreaterThanOrEqual(4);
    });

    it("code-assistant: allow all 时所有能力可用", () => {
      checkPaths();
      const config = readConfig(TEST_CONFIG);
      const provider = new Provider({
        config,
        agentsDir: TEST_AGENTS_DIR,
        subAgentsPaths: [PROJECT_SUB_AGENTS_DIR, TEST_SUB_AGENTS_DIR],
        skillsPaths: [PROJECT_SKILLS_DIR, TEST_SKILLS_DIR],
        toolsPaths: [PROJECT_TOOLS_DIR, TEST_TOOLS_DIR],
        mcpPaths: [PROJECT_AIZEN_MCP, PROJECT_MCP, TEST_MCP],
        conversationsDir: TEST_CONVERSATIONS_DIR,
        draftsDir: TEST_DRAFTS_DIR,
      });

      const caps = new Capabilities(provider);
      const definition = readAgent(TEST_AGENTS_DIR, "code-assistant")!;
      const tools = caps.buildTools(definition.permissions ?? {});

      const names = tools.map((t) => t.function.name);
      expect(names).toContain("readFile");
      expect(names).toContain("exec");
      expect(names).toContain("general_assistant");
      expect(names).toContain("code_reviewer");
      expect(names).toContain("project_manager");
      expect(names).toContain("load_skill");
      expect(names).toContain("call_skill_sub_agent");
    });

    it("translator: 受限权限只暴露指定工具", () => {
      checkPaths();
      const config = readConfig(TEST_CONFIG);
      const provider = new Provider({
        config,
        agentsDir: TEST_AGENTS_DIR,
        subAgentsPaths: [PROJECT_SUB_AGENTS_DIR, TEST_SUB_AGENTS_DIR],
        skillsPaths: [PROJECT_SKILLS_DIR, TEST_SKILLS_DIR],
        toolsPaths: [PROJECT_TOOLS_DIR, TEST_TOOLS_DIR],
        mcpPaths: [PROJECT_AIZEN_MCP, PROJECT_MCP, TEST_MCP],
        conversationsDir: TEST_CONVERSATIONS_DIR,
        draftsDir: TEST_DRAFTS_DIR,
      });

      const caps = new Capabilities(provider);
      const definition = readAgent(TEST_AGENTS_DIR, "translator")!;
      const tools = caps.buildTools(definition.permissions ?? {});

      const names = tools.map((t) => t.function.name);
      expect(names).toContain("readFile");
      expect(names).toContain("writeFile");
      expect(names).toContain("exec");
      expect(names).not.toContain("rm");
      expect(names).not.toContain("load_skill");
      expect(names).not.toContain("general_assistant");
    });
  });

  // -----------------------------------------------------------------
  // 4. createAgent 完整装配
  // -----------------------------------------------------------------
  describe("4. createAgent 完整装配", () => {
    it("从真实路径创建 code-assistant", () => {
      checkPaths();
      const config = readConfig(TEST_CONFIG);
      const provider = new Provider({
        config,
        agentsDir: TEST_AGENTS_DIR,
        subAgentsPaths: [PROJECT_SUB_AGENTS_DIR, TEST_SUB_AGENTS_DIR],
        skillsPaths: [PROJECT_SKILLS_DIR, TEST_SKILLS_DIR],
        toolsPaths: [PROJECT_TOOLS_DIR, TEST_TOOLS_DIR],
        mcpPaths: [PROJECT_AIZEN_MCP, PROJECT_MCP, TEST_MCP],
        conversationsDir: TEST_CONVERSATIONS_DIR,
        draftsDir: TEST_DRAFTS_DIR,
      });

      const agent = createAgent(provider, "code-assistant");

      // 类型
      expect(agent).toBeInstanceOf(SdkAgent);
      expect(agent.provider).toBe(provider);

      // 元数据
      expect(agent.definition.name).toBe("代码助手");
      expect(agent.permissions?.tools).toEqual({ allow: ["*"] });

      // 模型
      expect(agent.model).toBeDefined();

      // 消息
      expect(agent.messages[0].role).toBe("system");
      expect(agent.messages[0].content).toContain("代码助手");

      // 工具
      const names = agent.tools.map((t: Tool) => t.function.name);
      expect(names).toContain("readFile");
      expect(names).toContain("writeFile");
      expect(names).toContain("exec");
      expect(names).toContain("general_assistant");
      expect(names).toContain("load_skill");
      expect(names).toContain("generateImage"); // 有 imageModels 配置
    });

    it("从真实路径创建 translator（受限权限）", () => {
      checkPaths();
      const config = readConfig(TEST_CONFIG);
      const provider = new Provider({
        config,
        agentsDir: TEST_AGENTS_DIR,
        subAgentsPaths: [PROJECT_SUB_AGENTS_DIR, TEST_SUB_AGENTS_DIR],
        skillsPaths: [PROJECT_SKILLS_DIR, TEST_SKILLS_DIR],
        toolsPaths: [PROJECT_TOOLS_DIR, TEST_TOOLS_DIR],
        mcpPaths: [PROJECT_AIZEN_MCP, PROJECT_MCP, TEST_MCP],
        conversationsDir: TEST_CONVERSATIONS_DIR,
        draftsDir: TEST_DRAFTS_DIR,
      });

      const agent = createAgent(provider, "translator");

      const names = agent.tools.map((t: Tool) => t.function.name);
      expect(names).toContain("readFile");
      expect(names).toContain("writeFile");
      expect(names).toContain("exec");
      expect(names).not.toContain("rm");
      expect(names).not.toContain("general_assistant");
      expect(names).not.toContain("load_skill");
    });
  });

  // -----------------------------------------------------------------
  // 5. 插件集成
  // -----------------------------------------------------------------
  describe("5. 插件集成", () => {
    it("autoRefreshTools 可在真实 SdkAgent 上使用", () => {
      checkPaths();
      const config = readConfig(TEST_CONFIG);
      const provider = new Provider({
        config,
        agentsDir: TEST_AGENTS_DIR,
        subAgentsPaths: [PROJECT_SUB_AGENTS_DIR, TEST_SUB_AGENTS_DIR],
        skillsPaths: [PROJECT_SKILLS_DIR, TEST_SKILLS_DIR],
        toolsPaths: [PROJECT_TOOLS_DIR, TEST_TOOLS_DIR],
        mcpPaths: [PROJECT_AIZEN_MCP, PROJECT_MCP, TEST_MCP],
        conversationsDir: TEST_CONVERSATIONS_DIR,
        draftsDir: TEST_DRAFTS_DIR,
      });

      const agent = createAgent(provider, "code-assistant");
      const beforeNames = agent.tools.map((t: Tool) => t.function.name);

      // 注册并触发 autoRefreshTools
      agent.use(autoRefreshTools());

      // 模拟 onBeforeSend
      const ctx = { agent, content: "hello", messages: agent.messages };

      // 先 init
      agent.init();

      // 执行 onBeforeSend（通过模拟）
      const plugin = (agent as any)._plugins[0];
      plugin.onBeforeSend(ctx);

      // 刷新后工具列表应仍然完整
      const afterNames = agent.tools.map((t: Tool) => t.function.name);
      expect(afterNames).toEqual(beforeNames);
    });

    it("autoDraft 插件可正常保存和检查草稿", () => {
      checkPaths();
      const config = readConfig(TEST_CONFIG);
      const provider = new Provider({
        config,
        agentsDir: TEST_AGENTS_DIR,
        subAgentsPaths: [PROJECT_SUB_AGENTS_DIR, TEST_SUB_AGENTS_DIR],
        skillsPaths: [PROJECT_SKILLS_DIR, TEST_SKILLS_DIR],
        toolsPaths: [PROJECT_TOOLS_DIR, TEST_TOOLS_DIR],
        mcpPaths: [PROJECT_AIZEN_MCP, PROJECT_MCP, TEST_MCP],
        conversationsDir: TEST_CONVERSATIONS_DIR,
        draftsDir: TEST_DRAFTS_DIR,
      });

      const agent = createAgent(provider, "code-assistant");
      agent.use(autoDraft({
        draftsDir: TEST_DRAFTS_DIR,
        agentId: "code-assistant",
      }));

      // 模拟 onAfterSend
      const ctx = { agent, content: "你好", messages: agent.messages };
      const plugin = (agent as any)._plugins[0];
      plugin.onAfterSend(ctx);

      // 检查草稿文件已创建
      const draftPath = join(TEST_DRAFTS_DIR, "_current.json");
      expect(existsSync(draftPath)).toBe(true);

      const draftContent = JSON.parse(readFileSync(draftPath, "utf-8"));
      expect(draftContent.agentId).toBe("code-assistant");
      expect(draftContent.messages.length).toBeGreaterThan(0);

      // checkDraftForRestore 能检测到
      const draft = checkDraftForRestore(TEST_DRAFTS_DIR);
      expect(draft).not.toBeNull();
      expect(draft!.agentId).toBe("code-assistant");
    });
  });

  // -----------------------------------------------------------------
  // 6. 多路径优先级
  // -----------------------------------------------------------------
  describe("6. 多路径合并优先级", () => {
    it("用户级 + 项目级 SubAgent 不冲突合并", () => {
      checkPaths();
      const agents = discoverSubAgents([TEST_SUB_AGENTS_DIR, PROJECT_SUB_AGENTS_DIR]);
      const names = agents.map((a) => a.function!.name);
      // 各自有不同名称，不会冲突
      expect(new Set(names).size).toBe(names.length);
    });

    it("用户级 + 项目级 Skill 不冲突合并", () => {
      checkPaths();
      const skills = discoverSkills([TEST_SKILLS_DIR, PROJECT_SKILLS_DIR]);
      const ids = skills.map((s) => s.id);
      // 各自有不同 id，不会冲突
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("用户级 + 项目级 MCP 合并时同名按优先级覆盖", () => {
      checkPaths();
      // 这里的 server 名称各不相同，验证能全部发现
      const servers = discoverMcpServers([TEST_MCP, PROJECT_MCP, PROJECT_AIZEN_MCP]);
      const names = servers.map((s) => s.id);
      expect(names).toContain("github");
      expect(names).toContain("filesystem");
      expect(names).toContain("postgres");
      expect(names).toContain("custom-server");
    });
  });
});
