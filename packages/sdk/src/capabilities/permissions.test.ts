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
  describe("permissions 缺失", () => {
    it("四维度全部拒绝", () => {
      const result = filterByPermissions(undefined, candidates);
      expect(result.tools).toEqual([]);
      expect(result.skills).toEqual([]);
      expect(result.mcps).toEqual([]);
      expect(result.subagents).toEqual([]);
    });
  });

  describe("permissions 存在但某维度缺失", () => {
    it("缺失维度等同于 deny: ['*']", () => {
      const result = filterByPermissions(
        { tools: { allow: ["*"] } },
        candidates,
      );
      expect(result.tools).toEqual(["readFile", "exec", "rm"]);
      expect(result.skills).toEqual([]);
      expect(result.mcps).toEqual([]);
      expect(result.subagents).toEqual([]);
    });
  });

  describe("四维度独立过滤", () => {
    it("各维度互不干扰", () => {
      const result = filterByPermissions(
        {
          tools: { allow: ["readFile", "exec"] },
          skills: { deny: ["deploy"] },
          mcps: { allow: ["*"] },
          subagents: { deny: ["*"] },
        },
        candidates,
      );
      expect(result.tools).toEqual(["readFile", "exec"]);
      expect(result.skills).toEqual(["code-review"]);
      expect(result.mcps).toEqual(["github", "slack"]);
      expect(result.subagents).toEqual([]);
    });
  });

  describe("同时配置 allow 和 deny（非法）", () => {
    it("抛出异常", () => {
      const badPermissions = {
        tools: { allow: ["readFile"], deny: ["rm"] },
      } as AgentPermissions;

      expect(() => filterByPermissions(badPermissions, candidates)).toThrow();
    });
  });
});
