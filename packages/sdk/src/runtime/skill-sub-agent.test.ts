import { describe, it, expect } from "vitest";
import { createSkillSubAgent } from "./skill-sub-agent";
import type { AgentDefinition, AppConfig, AgentPermissions } from "../types";
import type { SkillInfo } from "../capabilities/discovery/skills";
import { CallbackTool } from "@ai-zen/agents-core";
import type { Tool } from "@ai-zen/agents-core";

function makeTool(name: string): Tool {
  return new CallbackTool({
    function: { name, description: `${name} tool`, parameters: { type: "object", properties: {}, required: [] } },
    callback: async () => name,
  });
}

const config: AppConfig = {
  defaultModel: "gpt4",
  endpoints: [
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "sk-xxx" },
  ],
  models: [
    { id: "gpt4", name: "GPT-4", endpointId: "openai", maxContextTokens: 500000 },
  ],
};

const fullPermissions: AgentPermissions = {
  tools: { allow: ["*"] },
  skills: { allow: ["*"] },
  mcps: { allow: ["*"] },
  subagents: { allow: ["*"] },
};

const restrictedPermissions: AgentPermissions = {
  tools: { allow: ["readFile"] },
  skills: { deny: ["*"] },
  mcps: { deny: ["*"] },
  subagents: { deny: ["*"] },
};

const createSkill = (overrides: Partial<SkillInfo> = {}): SkillInfo => ({
  id: "code-review",
  name: "代码审查",
  description: "审查代码质量",
  content: "# 代码审查指南\n\n## 安全性\n检查安全漏洞。",
  subAgent: true,
  ...overrides,
});

describe("createSkillSubAgent", () => {
  it("以 SKILL.md 正文作为 system prompt", () => {
    const result = createSkillSubAgent({
      skill: createSkill(),
      task: "审查 app.ts",
      config,
      callerPermissions: fullPermissions,
    });

    const systemMsg = result.definition.messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain("# 代码审查指南");
    expect(systemMsg!.content).toContain("安全性");
  });

  it("task 作为 user 消息", () => {
    const result = createSkillSubAgent({
      skill: createSkill(),
      task: "审查 app.ts",
      config,
      callerPermissions: fullPermissions,
    });

    const userMsg = result.definition.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe("审查 app.ts");
  });

  it("继承调用者 permissions", () => {
    const result = createSkillSubAgent({
      skill: createSkill(),
      task: "test",
      config,
      callerPermissions: restrictedPermissions,
    });

    expect(result.definition.permissions).toEqual(restrictedPermissions);
  });

  it("isSkillSubAgent=true 预过滤递归工具", () => {
    const result = createSkillSubAgent({
      skill: createSkill(),
      task: "test",
      config,
      callerPermissions: fullPermissions,
      builtinTools: ["readFile", "exec", "call_skill_sub_agent", "load_skill"].map(makeTool),
    });

    const toolNames = result.capabilities.tools.map((t: Tool) => t.function.name);
    expect(toolNames).not.toContain("call_skill_sub_agent");
    expect(toolNames).not.toContain("load_skill");
    expect(toolNames).toContain("readFile");
    expect(toolNames).toContain("exec");
  });

  it("skill 无 sub-agent 标记时抛出错误", () => {
    expect(() =>
      createSkillSubAgent({
        skill: createSkill({ subAgent: false }),
        task: "test",
        config,
        callerPermissions: fullPermissions,
      }),
    ).toThrow("不支持子 Agent 模式");
  });

  it("返回的 Agent 使用默认模型", () => {
    const result = createSkillSubAgent({
      skill: createSkill(),
      task: "test",
      config,
      callerPermissions: fullPermissions,
    });

    expect(result.model.id).toBe("gpt4");
  });
});
