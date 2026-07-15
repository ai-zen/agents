import { describe, it, expect } from "vitest";
import { filterByPermissions } from "./permissions";
import type { AgentPermissions } from "../types";

const candidates = {
  tools: ["readFile", "exec", "rm"],
  skills: ["code-review", "deploy"],
  mcps: ["github", "slack"],
  subagents: ["general_assistant", "code-reviewer"],
};

describe("filterByPermissions", () => {
  it("四维度全部拒绝", () => {
    const permissions: AgentPermissions = {
      tools: { deny: ["*"] },
      skills: { deny: ["*"] },
      mcps: { deny: ["*"] },
      subagents: { deny: ["*"] },
    };

    const result = filterByPermissions(permissions, candidates);

    expect(result.tools).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.mcps).toEqual([]);
    expect(result.subagents).toEqual([]);
  });

  it("缺失维度等同于 deny: ['*']", () => {
    const permissions: AgentPermissions = {
      tools: { allow: ["*"] },
    };

    const result = filterByPermissions(permissions, candidates);

    expect(result.tools).toEqual(["readFile", "exec", "rm"]);
    expect(result.skills).toEqual([]);
    expect(result.mcps).toEqual([]);
    expect(result.subagents).toEqual([]);
  });

  describe("四维度独立过滤", () => {
    it("各维度互不干扰", () => {
      const permissions: AgentPermissions = {
        tools: { allow: ["readFile", "exec"] },
        skills: { allow: ["code-review"] },
        mcps: { deny: ["slack"] },
        subagents: { allow: ["*"] },
      };

      const result = filterByPermissions(permissions, candidates);

      expect(result.tools).toEqual(["readFile", "exec"]);
      expect(result.skills).toEqual(["code-review"]);
      expect(result.mcps).toEqual(["github"]);
      expect(result.subagents).toEqual(["general_assistant", "code-reviewer"]);
    });
  });

  it("抛出异常", () => {
    const permissions: AgentPermissions = {
      tools: { allow: ["readFile"], deny: ["rm"] },
    };

    expect(() => filterByPermissions(permissions, candidates)).toThrow();
  });
});
