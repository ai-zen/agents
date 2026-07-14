import { describe, it, expect } from "vitest";
import { assembleCapabilities } from "./pipeline";
import type { AgentPermissions, AgentDefinition } from "../types";
import type { DisclosureItem } from "./disclosure";
import type { Tool } from "@ai-zen/agents-core";
import { CallbackTool } from "@ai-zen/agents-core";

function makeTool(name: string): Tool {
  return new CallbackTool({
    function: { name, description: `${name} tool`, parameters: { type: "object", properties: {}, required: [] } },
    callback: async () => name,
  });
}

function makeSubAgent(name: string): AgentDefinition {
  return {
    id: name,
    name,
    messages: [
      { role: "system", content: `You are ${name}.` },
      { role: "user", content: "{{task}}" },
    ],
    function: { name, description: `${name} sub-agent`, parameters: { type: "object", properties: { task: { type: "string", description: "Task" } }, required: ["task"] } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const builtinTools: Tool[] = ["readFile", "exec", "rm", "writeFile", "glob"].map(makeTool);
const userTools: Tool[] = [makeTool("my-custom-tool")];
const subagents: AgentDefinition[] = ["general_assistant", "code-reviewer"].map(makeSubAgent);
const skills: DisclosureItem[] = [
  { id: "code-review", description: "代码审查" },
  { id: "deploy", description: "部署工具" },
];
const mcps: DisclosureItem[] = [
  { id: "github", description: "GitHub API" },
];

function toolNames(result: { tools: Tool[] }): string[] {
  return result.tools.map((t: Tool) => t.function.name);
}

describe("assembleCapabilities", () => {
  it("全开 — 返回全部候选（内置工具 + 用户工具 + 动态工具 id）", () => {
    const result = assembleCapabilities({
      permissions: {
        tools: { allow: ["*"] },
        skills: { allow: ["*"] },
        mcps: { allow: ["*"] },
        subagents: { allow: ["*"] },
      },
      builtinTools,
      userTools,
      subagents,
      skills,
      mcps,
    });

    // 内置 + 用户
    expect(toolNames(result)).toContain("readFile");
    expect(toolNames(result)).toContain("my-custom-tool");
    // 动态工具 id 在 pipeline 内部处理（无 mcpManager 时跳过）
    // subagents 已转为 AgentToolLazy
    expect(toolNames(result)).toContain("general_assistant");
    expect(toolNames(result)).toContain("code-reviewer");
  });

  it("skills 维度 deny: ['*'] — 无 skill 枚举，动态工具不注册", () => {
    const result = assembleCapabilities({
      permissions: {
        tools: { allow: ["*"] },
        skills: { deny: ["*"] },
        mcps: { allow: ["*"] },
        subagents: { allow: ["*"] },
      },
      builtinTools,
      userTools,
      subagents,
      skills,
      mcps,
    });

    expect(toolNames(result)).not.toContain("load_skill");
    expect(toolNames(result)).not.toContain("call_skill_sub_agent");
  });

  it("tools 维度拒绝 load_skill — load_skill 不在结果中", () => {
    const result = assembleCapabilities({
      permissions: {
        tools: { deny: ["load_skill"] },
        skills: { allow: ["*"] },
        mcps: { allow: ["*"] },
        subagents: { allow: ["*"] },
      },
      builtinTools,
      userTools,
      subagents,
      skills,
      mcps,
    });

    expect(toolNames(result)).not.toContain("load_skill");
  });

  it("SubAgent 递归保护 — 剔除自身", () => {
    const result = assembleCapabilities({
      permissions: {
        tools: { allow: ["*"] },
        subagents: { allow: ["*"] },
      },
      builtinTools,
      userTools,
      subagents,
      skills: [],
      mcps: [],
      selfFunctionName: "code-reviewer",
    });

    expect(toolNames(result)).not.toContain("code-reviewer");
    expect(toolNames(result)).toContain("general_assistant");
  });

  it("Skill 子 Agent — 剔除递归工具", () => {
    const result = assembleCapabilities({
      permissions: {
        tools: { allow: ["*"] },
        skills: { allow: ["*"] },
        mcps: { allow: ["*"] },
        subagents: { allow: ["*"] },
      },
      builtinTools,
      userTools,
      subagents,
      skills,
      mcps,
      isSkillSubAgent: true,
    });

    expect(toolNames(result)).not.toContain("call_skill_sub_agent");
    expect(toolNames(result)).not.toContain("load_skill");
    expect(toolNames(result)).toContain("readFile");
  });

  it("空 skills 和 mcps — 动态工具不注册", () => {
    const result = assembleCapabilities({
      permissions: {
        tools: { allow: ["*"] },
        skills: { allow: ["*"] },
        mcps: { allow: ["*"] },
        subagents: { allow: ["*"] },
      },
      builtinTools,
      userTools,
      subagents,
      skills: [],
      mcps: [],
    });

    expect(toolNames(result)).not.toContain("load_skill");
    expect(toolNames(result)).not.toContain("load_mcp");
  });

  it("同名工具：用户工具覆盖内置工具（后注册优先）", () => {
    const customReadFile = makeTool("readFile");
    const result = assembleCapabilities({
      permissions: {
        tools: { allow: ["*"] },
        skills: { allow: ["*"] },
        mcps: { allow: ["*"] },
        subagents: { allow: ["*"] },
      },
      builtinTools,
      userTools: [customReadFile, makeTool("custom")],
      subagents,
      skills,
      mcps,
    });

    expect(toolNames(result)).toContain("readFile");
    expect(toolNames(result)).toContain("custom");
    expect(result.tools.filter((t: Tool) => t.function.name === "readFile")).toHaveLength(1);
  });
});
