import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentNS, Message } from "@ai-zen/agents-core";
import { createAgent } from "./createAgent.js";
import { AgentRepository } from "../crud/AgentRepository.js";
import { Scope } from "../scope/Scope.js";
import { allInOne } from "../scope/plugins/allInOne.js";
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
  endpoints: [
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "sk-xxx" },
  ],
  models: [
    {
      id: "gpt4",
      name: "GPT-4",
      endpointId: "openai",
      tokenThresholds: { handoff: 500000, guard: 750000 },
      // 出厂参数：参数解析的用例要能看出「覆盖有没有生效」（以及没覆盖时它还在）
      defaultParams: { temperature: 0.3 },
    },
    // 三级解析要用到第二个模型（会话级覆盖 / 全局兜底各取一个，才能看出谁赢）
    {
      id: "gpt4-mini",
      name: "GPT-4 mini",
      endpointId: "openai",
      tokenThresholds: { handoff: 400000, guard: 600000 },
      defaultParams: { thinking: { type: "enabled" } },
    },
  ],
};

async function makeScope(
  opts: {
    subAgentsPaths?: string[];
    skillsPaths?: string[];
    toolsPaths?: string[];
    mcpPaths?: string[];
    /** 覆盖/追加配置（三级解析的用例要看 `defaultModel`） */
    config?: Partial<AppConfig>;
  } = {},
): Promise<Scope> {
  const scope = new Scope({
    config: { ...config, ...opts.config },
    agentsDir: join(dir, "agents"),
    cwd: dir,
  }).use(...allInOne(opts));
  await scope.init();
  return scope;
}

async function writeAgentFile(id: string, def: Partial<AgentDefinition> = {}) {
  const agentsDir = join(dir, "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  const agent: AgentDefinition = {
    id,
    name: id,
    modelId: "gpt4",
    messages: [Message.System("You are helpful.")],
    permissions: {
      tools: { allow: ["*"] },
      skills: { allow: ["*"] },
      mcps: { allow: ["*"] },
      subagents: { allow: ["*"] },
    },
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
    messages: [Message.System("You are a sub-agent."), Message.User("{{task}}")],
    function: {
      name: functionName,
      description: "A sub-agent",
      parameters: { type: "object", properties: {}, required: [] },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(join(subDir, `${id}.json`), JSON.stringify(agent, null, 2));
}

async function writeSkill(id: string, description: string) {
  const skillDir = join(dir, "skills", id);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n# ${id}`,
  );
}

async function writeMcpConfig(servers: Record<string, unknown>) {
  await fs.writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

describe("createAgent", () => {
  it("从磁盘完整装配 Agent", async () => {
    await writeAgentFile("my-agent");
    await writeSubAgent("sa1", "sub_agent_default");
    await writeSkill("code-review", "代码审查");
    await writeMcpConfig({ github: { transport: "stdio", command: "gh" } });

    const scope = await makeScope({
      subAgentsPaths: [join(dir, "sub-agents")],
      skillsPaths: [join(dir, "skills")],
      mcpPaths: [join(dir, "mcp.json")],
    });
    const agent = await createAgent(scope, "my-agent");

    // SdkAgent 定义携带 permissions
    expect(agent.definition.permissions).toBeDefined();
    expect(agent.definition.permissions!.tools).toEqual({ allow: ["*"] });

    const names = agent.tools.map((t: any) => t.function.name);
    expect(names).toContain("sub_agent_default");
  });

  it("Agent 不存在时抛异常", async () => {
    const scope = await makeScope();

    await expect(createAgent(scope, "nonexistent")).rejects.toThrow();
  });

  it("可选的发现目录不存在不抛异常", async () => {
    await writeAgentFile("my-agent");

    const scope = await makeScope();

    const agent = await createAgent(scope, "my-agent");
    expect(agent.tools.length).toBeGreaterThan(0); // 内置工具默认存在
  });

  it("append 不应污染 Agent 定义模板（definition.messages 引用隔离）", async () => {
    await writeAgentFile("my-agent");

    const scope = await makeScope();
    const agent = await createAgent(scope, "my-agent");

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

  it("Agent 未绑定模型（且无全局兜底）时报错，带上 agentId、不隐式回退", async () => {
    const agentsDir = join(dir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    const def: AgentDefinition = {
      id: "no-model",
      name: "No Model",
      messages: [Message.System("hi")],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(join(agentsDir, "no-model.json"), JSON.stringify(def, null, 2));

    const scope = await makeScope();
    // 带上 agentId：同一条错误在服务端日志里必须能指出是哪份定义没绑模型
    await expect(createAgent(scope, "no-model")).rejects.toThrow(/Agent "no-model" has no model/);
  });

  it("会话级覆盖优先：传了 options.modelId 就用它，Agent 定义不被改写", async () => {
    await writeAgentFile("my-agent", { modelId: "gpt4" });
    const scope = await makeScope();

    const agent = await createAgent(scope, "my-agent", { modelId: "gpt4-mini" });

    // 运行期看到的就是覆盖后的模型（状态栏 / 阀值 / 插件都读 definition.modelId）
    expect(agent.definition.modelId).toBe("gpt4-mini");
    expect(agent.modelLevel).toBe("session");
    // 磁盘上的定义一个字没动：覆盖只属于这一段会话
    const onDisk = await new AgentRepository(join(dir, "agents")).read("my-agent");
    expect(onDisk!.modelId).toBe("gpt4");
  });

  it("没会话级覆盖时用 Agent 定义（全局兜底不该越位）", async () => {
    await writeAgentFile("my-agent", { modelId: "gpt4" });
    const scope = await makeScope({ config: { defaultModel: "gpt4-mini" } });

    const agent = await createAgent(scope, "my-agent");

    expect(agent.definition.modelId).toBe("gpt4");
    expect(agent.modelLevel).toBe("agent");
  });

  it("Agent 定义没绑模型时用 config.defaultModel 兜底", async () => {
    await writeAgentFile("my-agent", { modelId: undefined });
    const scope = await makeScope({ config: { defaultModel: "gpt4-mini" } });

    const agent = await createAgent(scope, "my-agent");

    expect(agent.definition.modelId).toBe("gpt4-mini");
    expect(agent.modelLevel).toBe("global");
  });

  it("会话级覆盖与全局兜底同时在场时取会话级（三级顺序不许乱）", async () => {
    await writeAgentFile("my-agent", { modelId: undefined });
    const scope = await makeScope({ config: { defaultModel: "gpt4-mini" } });

    const agent = await createAgent(scope, "my-agent", { modelId: "gpt4" });

    expect(agent.definition.modelId).toBe("gpt4");
    expect(agent.modelLevel).toBe("session");
  });

  /**
   * 参数与模型同源：**参数取「模型来自哪一级」那一份**。
   *
   * 三条用例对应三档。跨级那一对（会话级模型 + 定义参数）是重点：定义那份参数是配给旧
   * 模型的（这里用 `thinking` 举例子），跟到会话级模型上就是「旧模型参数发给新模型」。
   */
  describe("模型参数跟着档位走", () => {
    it("会话级：取会话级参数，定义那份一个字段都不进来", async () => {
      await writeAgentFile("my-agent", {
        modelId: "gpt4",
        modelParams: { thinking: { type: "disabled" } },
      });
      const scope = await makeScope();

      const agent = await createAgent(scope, "my-agent", {
        modelId: "gpt4-mini",
        modelParams: { reasoning_effort: "high" },
      });

      // 出厂参数照旧在，覆盖只有会话级那一份
      expect(agent.modelConfig).toEqual({
        thinking: { type: "enabled" },
        reasoning_effort: "high",
      });
    });

    it("会话级换模型但没给参数：只用新模型的出厂参数（不退回定义那份）", async () => {
      await writeAgentFile("my-agent", {
        modelId: "gpt4",
        modelParams: { thinking: { type: "disabled" } },
      });
      const scope = await makeScope();

      const agent = await createAgent(scope, "my-agent", { modelId: "gpt4-mini" });

      expect(agent.modelConfig).toEqual({ thinking: { type: "enabled" } });
    });

    it("定义级：取 Agent 定义参数（三级解析之前的行为，逐字不变）", async () => {
      await writeAgentFile("my-agent", {
        modelId: "gpt4",
        modelParams: { reasoning_effort: "low" },
      });
      const scope = await makeScope();

      const agent = await createAgent(scope, "my-agent");

      expect(agent.modelLevel).toBe("agent");
      expect(agent.modelConfig).toEqual({ temperature: 0.3, reasoning_effort: "low" });
    });

    it("全局兜底：没有任何一层的参数，只用模型出厂参数", async () => {
      // 定义没绑模型、却写着参数：那一层参数属于「定义绑定的模型」，不该跟到兜底模型上
      await writeAgentFile("my-agent", {
        modelId: undefined,
        modelParams: { thinking: { type: "disabled" } },
      });
      const scope = await makeScope({ config: { defaultModel: "gpt4-mini" } });

      const agent = await createAgent(scope, "my-agent", {
        modelParams: { reasoning_effort: "max" },
      });

      expect(agent.modelLevel).toBe("global");
      expect(agent.modelConfig).toEqual({ thinking: { type: "enabled" } });
    });
  });

  it("Agent 定义缺少 messages 字段时也能正常创建（空值兜底）", async () => {
    await writeAgentFile("my-agent", { messages: undefined });

    const scope = await makeScope();
    const agent = await createAgent(scope, "my-agent");

    expect(agent.messages).toEqual([]);
    agent.append(Message.User("你好"));
    expect(agent.messages).toHaveLength(1);
    // definition.messages 为 undefined 时不应抛错（createAgent 已用 ?? [] 兜底）
    expect(agent.definition.messages).toBeUndefined();
  });

  it("中断策略取自 scope.config；显式参数优先", async () => {
    await writeAgentFile("my-agent");
    const scope = new Scope({
      config: {
        ...config,
        abortedMessageStrategy: "drop",
        abortedToolRoundStrategy: "drop",
      },
      agentsDir: join(dir, "agents"),
      cwd: dir,
    }).use(...allInOne());
    await scope.init();

    const agent = await createAgent(scope, "my-agent");
    expect(agent.abortedMessageStrategy).toBe("drop");
    expect(agent.abortedToolRoundStrategy).toBe("drop");

    // 显式参数覆盖配置（个别端要临时换策略时不必改文件）
    const overridden = await createAgent(scope, "my-agent", { abortedMessageStrategy: "keep" });
    expect(overridden.abortedMessageStrategy).toBe("keep");
    expect(overridden.abortedToolRoundStrategy).toBe("drop");
  });

  it("scope.config 没写策略时回落 core 默认（消息 drop / 工具轮次 fill）", async () => {
    await writeAgentFile("my-agent");
    const scope = await makeScope();
    const agent = await createAgent(scope, "my-agent");

    expect(agent.abortedMessageStrategy).toBe("drop");
    expect(agent.abortedToolRoundStrategy).toBe("fill");
  });
});
