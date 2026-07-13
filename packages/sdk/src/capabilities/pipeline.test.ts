import { describe, it, expect } from "vitest";
import { assembleCapabilities } from "./pipeline";
import type { AgentPermissions } from "../types";
import type { DisclosureItem } from "./disclosure";

const builtinTools = ["readFile", "exec", "rm", "writeFile", "glob"];
const userTools = ["my-custom-tool"];
const subagents = ["general_assistant", "code-reviewer"];
const skills: DisclosureItem[] = [
  { id: "code-review", description: "代码审查" },
  { id: "deploy", description: "部署工具" },
];
const mcps: DisclosureItem[] = [
  { id: "github", description: "GitHub API" },
];

describe("assembleCapabilities", () => {
  it("全开 — 返回全部候选", () => {
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

    expect(result.tools).toContain("readFile");
    expect(result.tools).toContain("my-custom-tool");
    expect(result.tools).toContain("load_skill");
    expect(result.tools).toContain("load_mcp");
    expect(result.subagents).toEqual(["general_assistant", "code-reviewer"]);
    expect(result.skillParam.enum).toEqual(["code-review", "deploy"]);
    expect(result.mcpParam.enum).toEqual(["github"]);
  });

  it("skills 维度 deny: ['*'] — 无枚举，描述带提示", () => {
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

    expect(result.skillParam.enum).toBeUndefined();
    expect(result.skillParam.description).toContain("当前没有可用的 Skill");
  });

  it("tools 维度拒绝 load_skill — load_skill 不在 tools 中", () => {
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

    expect(result.tools).not.toContain("load_skill");
    // load_mcp 不受影响
    expect(result.tools).toContain("load_mcp");
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

    expect(result.subagents).not.toContain("code-reviewer");
    expect(result.subagents).toContain("general_assistant");
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

    expect(result.tools).not.toContain("call_skill_sub_agent");
    expect(result.tools).not.toContain("load_skill");
    expect(result.tools).toContain("readFile"); // 其他工具保留
  });

  it("空 skills 和 mcps — 枚举退化，描述带提示", () => {
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

    expect(result.skillParam.enum).toBeUndefined();
    expect(result.skillParam.description).toContain("当前没有可用的 Skill");
    expect(result.mcpParam.enum).toBeUndefined();
    expect(result.mcpParam.description).toContain("当前没有可用的 MCP 服务器");
  });
});
