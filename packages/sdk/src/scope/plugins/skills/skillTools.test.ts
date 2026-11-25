import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent, AgentToolLazy, CallbackTool, Message, ToolCallContext } from "@ai-zen/agents-core";
import { createLoadSkillTool, createCallSkillSubAgentTool } from "./skillTools.js";
import type { SkillInfo } from "./discover.js";
import { PEER_SESSION_TOOL_NAMES } from "../peers/peerSessionTools.js";
import { ASYNC_TASK_TOOL_NAMES } from "../builtin/asyncTasks.js";

let tmpDir: string;
let skillDirs: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ai-zen-skill-tools-"));
  skillDirs = [join(tmpDir, "skills")];
  mkdirSync(skillDirs[0], { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSkill(id: string, content: string, options?: { subAgent?: boolean }) {
  const dir = join(skillDirs[0], id);
  mkdirSync(dir, { recursive: true });
  const frontmatter = [
    "---",
    `name: ${id}`,
    `description: Skill ${id}`,
    ...(options?.subAgent ? ["sub-agent: true"] : []),
    "---",
    "",
  ].join("\n");
  writeFileSync(join(dir, "SKILL.md"), frontmatter + content);
}

/** 造 SkillInfo 夹具（只关心 id/description/subAgent，其余取占位值） */
function skillInfo(id: string, overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id,
    name: id,
    description: `Skill ${id}`,
    subAgent: false,
    content: "",
    dirPath: "",
    ...overrides,
  };
}

const skills: SkillInfo[] = [
  skillInfo("git", { description: "Git 版本控制" }),
  skillInfo("docker", { description: "Docker 容器管理" }),
];

/** 测试视角：load_skill 的回调一定存在，且只关心输入参数 */
const loadSkill = (tool: { callback?: any }) => (args: Record<string, unknown>) =>
  tool.callback!.call({ agent: null }, args);

describe("createLoadSkillTool", () => {
  it("工具名称和参数正确", () => {
    const tool = createLoadSkillTool(skillDirs, skills);
    expect(tool.function.name).toBe("load_skill");
    expect((tool.function.parameters.properties as any).skill_id.enum).toEqual(["git", "docker"]);
    expect((tool.function.parameters as any).required).toContain("skill_id");
  });

  it("Skill 在允许列表内但磁盘上没有时返回 not found", async () => {
    const tool = createLoadSkillTool(skillDirs, skills);
    // git 在 filteredSkills 里，但没写到磁盘
    const result = await loadSkill(tool)({ skill_id: "git" });
    expect(result).toContain("not found");
  });

  it("被权限过滤掉的 Skill 即使磁盘上有也加载不到", async () => {
    // secret 有完整正文，但不在 filteredSkills 里（例如被 skills.deny 挡掉）
    writeSkill("secret", "# SECRET BODY\nconfidential instructions");
    const tool = createLoadSkillTool(skillDirs, [skills[0]!]); // 只允许 git

    const result = await loadSkill(tool)({ skill_id: "secret" });
    expect(result).toContain("not available");
    expect(result).not.toContain("SECRET BODY");
  });

  it("越界的 skill_id（../ 穿越）一律拒绝", async () => {
    const tool = createLoadSkillTool(skillDirs, skills);
    const result = await loadSkill(tool)({ skill_id: "../../etc" });
    expect(result).toContain("not available");
  });

  it("成功加载 Skill 返回完整内容与路径信息", async () => {
    writeSkill("git", "# Git operations guide\n\n## Committing code\nUse git commit");
    const tool = createLoadSkillTool(skillDirs, skills);
    const agent = new Agent({
      client: {} as any,
      model: "test",
      messages: [Message.System("你是一个AgentDefinition")],
      tools: [],
    });

    const result = await tool.callback!({ skill_id: "git" }, { agent } as any);
    expect(result).toContain("loaded");
    expect(result).toContain("Skill directory path:");
    expect(result).toContain("Git operations guide");
    expect(result).toContain("Skill content starts");
    // load_skill 只把正文拼进返回值，不往 agent.messages 里塞东西
    const injected = agent.messages.find((m) => String(m.content).includes("Skill"));
    expect(injected).toBeUndefined();
  });
});

describe("createCallSkillSubAgentTool", () => {
  /** 仅 subAgent: true 的 Skill 进入枚举 */
  const subAgentSkills: SkillInfo[] = [
    skillInfo("git", { description: "Git 版本控制", subAgent: true }),
    skillInfo("docker", { description: "Docker 容器管理", subAgent: true }),
  ];

  /** mock 流式客户端：subagent run 时返回固定文本 */
  function createMockClient(responseText = "sub-agent result") {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield {
          id: "chunk-1",
          object: "chat.completion.chunk",
          created: 0,
          model: "mock",
          choices: [{ index: 0, delta: { content: responseText }, finish_reason: null }],
        };
        yield {
          id: "chunk-2",
          object: "chat.completion.chunk",
          created: 0,
          model: "mock",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
      },
    };
    return { chat: { completions: { create: vi.fn(async () => stream) } } } as any;
  }

  /** 一个只有名字的假工具（“父手上有这件工具”只要名字就够） */
  const namedTool = (name: string) =>
    new CallbackTool({
      function: {
        name,
        description: `${name} 的描述`,
        parameters: { type: "object", properties: {}, required: [] },
      },
      callback: () => "ok",
    });

  /** 宿主 Agent：带 read 工具，并挂载被测工具（模拟 Scope.instantiate 的结果） */
  function buildHost(tool: AgentToolLazy, extraTools: CallbackTool[] = []) {
    const readFileTool = new CallbackTool({
      function: {
        name: "read",
        description: "读文件",
        parameters: { type: "object", properties: {}, required: [] },
      },
      callback: () => "ok",
    });
    return new Agent({
      client: createMockClient(),
      model: "gpt-4",
      messages: [Message.System("父 Agent")],
      tools: [readFileTool, ...extraTools, tool],
    });
  }

  function buildCtx(host: Agent, args: Record<string, unknown>) {
    return new ToolCallContext({
      agent: host,
      tool_call: {
        function: { name: "call_skill_sub_agent", arguments: JSON.stringify(args) },
      },
      resultMessage: Message.Tool({ id: "1", function: { name: "call_skill_sub_agent" } }),
    });
  }

  it("工具名称与参数契约保持不变", () => {
    const tool = createCallSkillSubAgentTool(skillDirs, subAgentSkills);
    expect(tool.function.name).toBe("call_skill_sub_agent");
    expect((tool.function.parameters as any).required).toContain("skill_id");
    expect((tool.function.parameters as any).required).toContain("task");
  });

  it("由 AgentToolLazy 承载，以复用统一的委派边界", () => {
    const tool = createCallSkillSubAgentTool(skillDirs, subAgentSkills);
    expect(tool).toBeInstanceOf(AgentToolLazy);
  });

  it("Skill 在允许列表内但磁盘上没有时抛出 not found", async () => {
    const tool = createCallSkillSubAgentTool(skillDirs, subAgentSkills);
    const host = buildHost(tool);
    // git 在列表里但没落盘
    await expect(
      tool.exec(buildCtx(host, { skill_id: "git", task: "do something" })),
    ).rejects.toThrow("not found");
  });

  it("被权限过滤掉的 Skill 不能被点名启动subagent", async () => {
    writeSkill("secret", "# 机密技能", { subAgent: true });
    const tool = createCallSkillSubAgentTool(skillDirs, subAgentSkills); // 不含 secret
    const host = buildHost(tool);
    await expect(
      tool.exec(buildCtx(host, { skill_id: "secret", task: "do something" })),
    ).rejects.toThrow("not available");
  });

  it("Skill 不支持subagent 模式时抛出错误", async () => {
    // 磁盘上的 frontmatter 没有 sub-agent: true，而发现结果声称支持（后改的 frontmatter）：
    // 以磁盘为准，明确告知模型改用 load_skill 自己处理
    writeSkill("plain", "# 普通 Skill");
    const tool = createCallSkillSubAgentTool(skillDirs, [
      ...subAgentSkills,
      skillInfo("plain", { description: "普通", subAgent: true }),
    ]);
    const host = buildHost(tool);
    await expect(
      tool.exec(buildCtx(host, { skill_id: "plain", task: "do something" })),
    ).rejects.toThrow("does not support SubAgent mode");
  });

  it("委派边界：分发 onSubAgentStart 与 subAgentStarted，subagent 沿用父工具集并剔除 call_skill_sub_agent", async () => {
    writeSkill("git", "# Git operations guide\n\n## Committing code\nUse git commit", {
      subAgent: true,
    });
    const tool = createCallSkillSubAgentTool(skillDirs, subAgentSkills);
    // 父手上还有后台任务与会话级能力：这两类在一次性 Agent 身上只有必错的路
    const host = buildHost(tool, [
      namedTool(ASYNC_TASK_TOOL_NAMES[0]),
      namedTool(ASYNC_TASK_TOOL_NAMES[1]),
      namedTool(PEER_SESSION_TOOL_NAMES[0]),
    ]);

    let captured: Agent | undefined;
    host.use({
      onSubAgentStart: (c) => {
        captured = c.subAgent;
      },
    });
    const startEvent = vi.fn();
    host.on("subAgentStarted", startEvent);

    const result = await tool.exec(
      buildCtx(host, { skill_id: "git", task: "commit these changes" }),
    );

    expect(result).toBe("sub-agent result");
    expect(startEvent).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    // 沿用父 Agent 工具能力，但剔除 call_skill_sub_agent 防自递归
    expect(captured!.tools.map((t) => t.function.name)).toEqual(["read"]);
    // 而 `async_*` 与会话级那几件一件都不能带：这个 Agent 是一次性的，结果回来时它已经关收
    const names = captured!.tools.map((t) => t.function.name);
    for (const name of [...ASYNC_TASK_TOOL_NAMES, ...PEER_SESSION_TOOL_NAMES]) {
      expect(names).not.toContain(name);
    }
    // 初始消息来自 SKILL.md 与 task 参数
    expect(String(captured!.messages[0].content)).toContain("Git operations guide");
    expect(captured!.messages[1].content).toBe("commit these changes");
    // 委派造出来的必须是**一次性** agent（core 的 `buildAgent` 契约）
    expect(captured!.lifetime).toBe("one-shot");
    // 注入的那条 user 消息由委派工具补 `source`（谁注入谁填）
    expect(captured!.messages[1].source).toEqual({ kind: "agent", label: "call_skill_sub_agent" });
  });

  it("被派出去的Agent没有平级会话那三个工具，别的工具还在", async () => {
    writeSkill("git", "# Git operations guide", { subAgent: true });
    const tool = createCallSkillSubAgentTool(skillDirs, subAgentSkills);

    /** 照 `read` 的写法造一个只回占位值的工具（本用例只关心工具名字） */
    const stubTool = (name: string) =>
      new CallbackTool({
        function: {
          name,
          description: `工具 ${name}`,
          parameters: { type: "object", properties: {}, required: [] },
        },
        callback: () => "ok",
      });

    // 父 Agent 手上有 `read`，也有 PeerSession 那三个
    const host = new Agent({
      client: createMockClient(),
      model: "gpt-4",
      messages: [Message.System("父 Agent")],
      tools: [stubTool("read"), ...PEER_SESSION_TOOL_NAMES.map(stubTool), tool],
    });

    let captured: Agent | undefined;
    host.use({
      onSubAgentStart: (c) => {
        captured = c.subAgent;
      },
    });

    const result = await tool.exec(
      buildCtx(host, { skill_id: "git", task: "commit these changes" }),
    );

    expect(result).toBe("sub-agent result");
    expect(captured).toBeDefined();
    const subAgentNames = captured!.tools.map((t) => t.function.name);
    // PeerSession 是会话级能力：父会话的 Agent 可以有，被派出去的没有
    for (const name of PEER_SESSION_TOOL_NAMES) {
      expect(subAgentNames).not.toContain(name);
    }
    // 剔除只掐那三个名字：其它工具照旧沿用
    expect(subAgentNames).toContain("read");
  });
});
