import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "@ai-zen/agents-core";
import { createLoadSkillTool, createCallSkillSubAgentTool } from "./skillTools.js";
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

function writeSkill(id: string, content: string) {
  const dir = join(skillDirs[0], id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: Skill ${id}\n---\n${content}`);
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
      model: { createCompletion: vi.fn() } as any,
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
  it("工具名称和参数正确", () => {
    const tool = createCallSkillSubAgentTool(skillDirs, skills);
    expect(tool.function.name).toBe("call_skill_sub_agent");
    expect(tool.function.parameters.required).toContain("skill_id");
    expect(tool.function.parameters.required).toContain("task");
  });

  it("Skill 不存在时返回错误", async () => {
    const tool = createCallSkillSubAgentTool(skillDirs, skills);
    const result = await tool.callback.call({ agent: { model: {} } }, { skill_id: "non-existent", task: "do something" });
    expect(result).toContain("不存在");
  });

  it("Skill 不支持子 Agent 模式时返回提示", async () => {
    writeSkill("plain", "# 普通 Skill");
    const tool = createCallSkillSubAgentTool(skillDirs, skills);
    const result = await tool.callback.call({ agent: { model: {} } }, { skill_id: "plain", task: "do something" });
    expect(result).toContain("不支持子 Agent");
  });
});
