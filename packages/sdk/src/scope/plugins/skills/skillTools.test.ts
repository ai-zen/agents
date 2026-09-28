import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent, AgentToolLazy, CallbackTool, Message, ToolCallContext } from "@ai-zen/agents-core";
import { createLoadSkillTool, createCallSkillSubAgentTool } from "./skillTools.js";
import type { SkillInfo } from "./discover.js";
import type { Capabilities } from "../Capabilities.js";

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

const skills: { id: string; description: string }[] = [
  { id: "git", description: "Git 版本控制" },
  { id: "docker", description: "Docker 容器管理" },
];

describe("createLoadSkillTool", () => {
  it("工具名称和参数正确", () => {
    const tool = createLoadSkillTool(skillDirs, skills);
    expect(tool.function.name).toBe("load_skill");
    expect(tool.function.parameters.properties.skill_id.enum).toEqual(["git", "docker"]);
    expect(tool.function.parameters.required).toContain("skill_id");
  });

  it("Skill 不存在时返回错误", async () => {
    const tool = createLoadSkillTool(skillDirs, skills);
    const result = await tool.callback.call({ agent: null }, { skill_id: "non-existent" });
    expect(result).toContain("不存在");
  });

  it("成功加载 Skill 返回完整内容与路径信息", async () => {
    writeSkill("git", "# Git 操作指南\n\n## 提交代码\n使用 git commit");
    const tool = createLoadSkillTool(skillDirs, skills);
    const agent = new Agent({
      client: {} as any,
      model: "test",
      messages: [{ role: "system", content: "你是一个助手" }],
      tools: [],
    });

    const result = await tool.callback.call({ agent }, { skill_id: "git" });
    expect(result).toContain("已加载");
    expect(result).toContain("Skill 目录路径:");
    expect(result).toContain("Git 操作指南");
    expect(result).toContain("Skill 内容开始");
    // 不再注入 system message
    const injected = agent.messages.find((m) => String(m.content).includes("Skill"));
    expect(injected).toBeUndefined();
  });
});

describe("createCallSkillSubAgentTool", () => {
  /** 仅 subAgent: true 的 Skill 进入枚举 */
  const subAgentSkills = [
    { id: "git", description: "Git 版本控制", subAgent: true },
    { id: "docker", description: "Docker 容器管理", subAgent: true },
  ] as unknown as SkillInfo[];

  /** mock 流式客户端：子 Agent run 时返回固定文本 */
  function createMockClient(responseText = "子Agent结果") {
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

  /** 宿主 Agent：带 read_file 工具，并挂载被测工具（模拟 Provider.instantiate 的结果） */
  function buildHost(tool: AgentToolLazy) {
    const readFileTool = new CallbackTool({
      function: {
        name: "read_file",
        description: "读文件",
        parameters: { type: "object", properties: {}, required: [] },
      },
      callback: () => "ok",
    });
    return new Agent({
      client: createMockClient(),
      model: "gpt-4",
      messages: [Message.System("父 Agent")],
      tools: [readFileTool, tool],
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
    expect(tool.function.parameters.required).toContain("skill_id");
    expect(tool.function.parameters.required).toContain("task");
  });

  it("由 AgentToolLazy 承载，以复用统一的委派边界", () => {
    const tool = createCallSkillSubAgentTool(skillDirs, subAgentSkills);
    expect(tool).toBeInstanceOf(AgentToolLazy);
  });

  it("Skill 不存在时抛出错误", async () => {
    const tool = createCallSkillSubAgentTool(skillDirs, subAgentSkills);
    const host = buildHost(tool);
    await expect(
      tool.exec(buildCtx(host, { skill_id: "non-existent", task: "do something" })),
    ).rejects.toThrow("不存在");
  });

  it("Skill 不支持子 Agent 模式时抛出错误", async () => {
    writeSkill("plain", "# 普通 Skill");
    const tool = createCallSkillSubAgentTool(skillDirs, subAgentSkills);
    const host = buildHost(tool);
    await expect(
      tool.exec(buildCtx(host, { skill_id: "plain", task: "do something" })),
    ).rejects.toThrow("不支持子 Agent");
  });

  it("委派边界：分发 onSubAgentStart 与 sub-agent-start，子 Agent 沿用父工具集并剔除 call_skill_sub_agent", async () => {
    writeSkill("git", "# Git 操作指南\n\n## 提交代码\n使用 git commit", { subAgent: true });
    const tool = createCallSkillSubAgentTool(skillDirs, subAgentSkills);
    const host = buildHost(tool);

    let captured: Agent | undefined;
    host.use({
      onSubAgentStart: (c) => {
        captured = c.subAgent;
      },
    });
    const startEvent = vi.fn();
    host.events.on("sub-agent-start", startEvent);

    const result = await tool.exec(
      buildCtx(host, { skill_id: "git", task: "提交这些改动" }),
    );

    expect(result).toBe("子Agent结果");
    expect(startEvent).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    // 沿用父 Agent 工具能力，但剔除 call_skill_sub_agent 防自递归
    expect(captured!.tools.map((t) => t.function.name)).toEqual(["read_file"]);
    // 初始消息来自 SKILL.md 与 task 参数
    expect(String(captured!.messages[0].content)).toContain("Git 操作指南");
    expect(captured!.messages[1].content).toBe("提交这些改动");
  });
});
