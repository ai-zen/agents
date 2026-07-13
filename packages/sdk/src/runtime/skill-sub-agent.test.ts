import { describe, it, expect } from "vitest";
import { createSkillSubAgent } from "./skill-sub-agent";
import type { SkillInfo } from "../capabilities/discovery/skills";
import type { AppConfig, AgentPermissions } from "../types";

const mockConfig: AppConfig = {
  defaultModel: "gpt-4",
  endpoints: [{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "sk-test" }],
  models: [{ id: "gpt-4", name: "GPT-4", endpointId: "openai", maxContextTokens: 500_000 }],
};

const mockSkill: SkillInfo = {
  id: "code-review",
  name: "代码审查",
  description: "审查代码质量",
  subAgent: true,
  content: `---
name: 代码审查
description: 审查代码质量
sub-agent: true
---
# 代码审查指南

你必须严格审查代码的：
1. 安全性
2. 性能
3. 可维护性`,
};

const fullPermissions: AgentPermissions = {
  tools: { allow: ["*"] },
  skills: { allow: ["*"] },
  mcps: { allow: ["*"] },
  subagents: { allow: ["*"] },
};

describe("createSkillSubAgent", () => {
  it("以 SKILL.md 正文作为 system prompt", () => {
    const result = createSkillSubAgent({
      skill: mockSkill,
      task: "审查这段代码",
      config: mockConfig,
      callerPermissions: fullPermissions,
    });

    expect(result.systemPrompt).toContain("# 代码审查指南");
    expect(result.systemPrompt).toContain("安全性");
  });

  it("task 作为 user 消息", () => {
    const result = createSkillSubAgent({
      skill: mockSkill,
      task: "审查 src/app.ts",
      config: mockConfig,
      callerPermissions: fullPermissions,
    });

    const userMsg = result.definition.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe("审查 src/app.ts");
  });

  it("继承调用者 permissions", () => {
    const restrictedPermissions: AgentPermissions = {
      tools: { allow: ["readFile", "exec"] },
      skills: { deny: ["deploy"] },
    };

    const result = createSkillSubAgent({
      skill: mockSkill,
      task: "审查代码",
      config: mockConfig,
      callerPermissions: restrictedPermissions,
    });

    // permissions 应该被传递到 definition 中
    expect(result.definition.permissions).toEqual(restrictedPermissions);
  });

  it("isSkillSubAgent=true 预过滤递归工具", () => {
    const result = createSkillSubAgent({
      skill: mockSkill,
      task: "审查代码",
      config: mockConfig,
      callerPermissions: fullPermissions,
      builtinTools: ["readFile", "exec", "call_skill_sub_agent", "load_skill"],
    });

    // call_skill_sub_agent 和 load_skill 应被预过滤
    const tools = result.capabilities.tools;
    expect(tools).not.toContain("call_skill_sub_agent");
    expect(tools).not.toContain("load_skill");
    expect(tools).toContain("readFile");
    expect(tools).toContain("exec");
  });

  it("skill 无 sub-agent 标记时抛出错误", () => {
    const plainSkill: SkillInfo = {
      ...mockSkill,
      subAgent: false,
    };

    expect(() =>
      createSkillSubAgent({
        skill: plainSkill,
        task: "test",
        config: mockConfig,
        callerPermissions: fullPermissions,
      }),
    ).toThrow("不支持子 Agent 模式");
  });

  it("返回的 Agent 使用默认模型", () => {
    const result = createSkillSubAgent({
      skill: mockSkill,
      task: "task",
      config: mockConfig,
      callerPermissions: fullPermissions,
    });

    expect(result.model.id).toBe("gpt-4");
  });
});
