/**
 * 真实目录结构下的**装配**：仓库里那份夹具（`packages/test-home` + `packages/test-project`）
 * 走一遍「发现 → 过滤 → 建 Agent」。
 *
 * 这个文件只钉装配这一段 —— 也就是说：`allInOne` 把四维路径真的串起来了、权限过滤真的按
 * 定义削掉了工具、`createAgent` 真能装出一个能跑的 Agent、插件能在真 Agent 上挂住。
 *
 * 发现与读写的细节**不在这里重复**，各有自己的套件：
 * `scope/plugins/{skills,usertools,subagents,mcp}/discover.test.ts`、`crud/AgentRepository.test.ts`
 * （临时目录造的夹具，改仓库夹具不会牵连它们）。
 *
 * 起子进程、写真实磁盘、连端口的一律不收 —— 这一套只读夹具：`npm run test:e2e`。
 */
import { describe, it, expect } from "vitest";
import { Scope } from "../src/scope/Scope.js";
import { allInOne } from "../src/scope/plugins/allInOne.js";
import { createAgent } from "../src/runtime/createAgent.js";
import { ConfigManager } from "../src/config/ConfigManager.js";
import { SdkAgent } from "../src/runtime/SdkAgent.js";
import { AutoRefreshToolsPlugin } from "../src/agent-plugins/AutoRefreshToolsPlugin.js";
import type { AgentDefinition } from "../src/types/index.js";
import type { Tool } from "@ai-zen/agents-core";
import { promises as fs } from "node:fs";
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

const PROJECT_DIR = join(__dirname, "..", "..", "test-project");
const PROJECT_MCP = join(PROJECT_DIR, ".mcp.json");
const PROJECT_AIZEN_DIR = join(PROJECT_DIR, ".ai-zen");
const PROJECT_SKILLS_DIR = join(PROJECT_AIZEN_DIR, "skills");
const PROJECT_TOOLS_DIR = join(PROJECT_AIZEN_DIR, "tools");
const PROJECT_SUB_AGENTS_DIR = join(PROJECT_AIZEN_DIR, "sub-agents");
const PROJECT_AIZEN_MCP = join(PROJECT_AIZEN_DIR, "mcp.json");

async function checkPaths() {
  try {
    await fs.access(TEST_CONFIG);
  } catch {
    throw new Error(`测试数据不存在，请先创建 ${TEST_CONFIG}`);
  }
}

/** 一个四维全开的探针 Agent 定义（仅用于 filter/buildTools） */
function allowAllDef(): AgentDefinition {
  return {
    id: "probe",
    name: "Probe",
    messages: [],
    permissions: {
      tools: { allow: ["*"] },
      skills: { allow: ["*"] },
      mcps: { allow: ["*"] },
      subagents: { allow: ["*"] },
    },
  } as unknown as AgentDefinition;
}

/** 用真实路径装配一个标准 Scope（allInOne）并完成发现 */
async function makeScope(): Promise<Scope> {
  const scope = new Scope({
    getConfig: () => new ConfigManager(TEST_CONFIG).read(),
    agentsDir: TEST_AGENTS_DIR,
  }).use(
    ...allInOne({
      subAgentsPaths: [PROJECT_SUB_AGENTS_DIR, TEST_SUB_AGENTS_DIR],
      skillsPaths: [PROJECT_SKILLS_DIR, TEST_SKILLS_DIR],
      toolsPaths: [PROJECT_TOOLS_DIR, TEST_TOOLS_DIR],
      mcpPaths: [PROJECT_AIZEN_MCP, PROJECT_MCP, TEST_MCP],
    }),
  );
  await scope.init();
  return scope;
}

describe("真实路径装配", () => {
  it("四维候选都从真实目录里出来了（用户工具并进 tools 维度）", async () => {
    await checkPaths();
    const scope = await makeScope();
    const result = scope.filter(allowAllDef());

    expect(result.subagents.length).toBeGreaterThanOrEqual(3);
    expect(result.skills.length).toBeGreaterThanOrEqual(3);
    expect(result.mcps.length).toBeGreaterThanOrEqual(4);
    expect(result.tools).toContain("count_lines");
    expect(result.tools).toContain("greet");
    expect(result.tools).toContain("project_stats");
  });

  it("allow all 的定义：装配出完整 Agent（含按配置给的 generate_image）", async () => {
    await checkPaths();
    const scope = await makeScope();

    const agent = await createAgent(scope, "code-assistant");

    expect(agent).toBeInstanceOf(SdkAgent);
    expect(agent.scope).toBe(scope);
    expect(agent.model).toBeDefined();
    expect(agent.messages[0]?.role).toBe("system");

    const names = agent.tools.map((t: Tool) => t.function.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("exec");
    expect(names).toContain("sub_agent_default");
    expect(names).toContain("load_skill");
    // 夹具配了 imageModels，这一颗就该在
    expect(names).toContain("generate_image");
  });

  it("受限权限的定义：同一套路径下，多出来的能力一个都不露", async () => {
    await checkPaths();
    const scope = await makeScope();

    const agent = await createAgent(scope, "translator");

    const names = agent.tools.map((t: Tool) => t.function.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("exec");
    expect(names).not.toContain("rm");
    expect(names).not.toContain("sub_agent_default");
    expect(names).not.toContain("load_skill");
  });

  it("插件能挂在真 Agent 上：刷新之后工具名单不变", async () => {
    await checkPaths();
    const scope = await makeScope();

    const agent = await createAgent(scope, "code-assistant");
    const beforeNames = agent.tools.map((t: Tool) => t.function.name);

    agent.use(new AutoRefreshToolsPlugin());
    // 内循环开头那一缝的 ctx（core 那一侧是 `{ agent, body }`）
    const ctx = { agent, body: { messages: [] } };
    await agent.init();
    const plugin = (agent as any)._plugins[0];
    await plugin.onInnerLoopStart(ctx);

    const afterNames = agent.tools.map((t: Tool) => t.function.name);
    expect(afterNames).toEqual(beforeNames);
  });
});
