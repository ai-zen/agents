import { describe, it, expect } from "vitest";
import { PermissionEvaluator } from "./PermissionEvaluator.js";

describe("PermissionEvaluator.match", () => {
  describe("allow 模式", () => {
    it("命中 — 精确匹配", () => {
      expect(PermissionEvaluator.match("readFile", { allow: ["readFile", "exec"] })).toBe(true);
    });

    it("未命中 — 不在列表中", () => {
      expect(PermissionEvaluator.match("rm", { allow: ["readFile", "exec"] })).toBe(false);
    });

    it("通配符 * 匹配任意", () => {
      expect(PermissionEvaluator.match("anything", { allow: ["*"] })).toBe(true);
    });

    it("通配符在列表中同样生效", () => {
      expect(PermissionEvaluator.match("rm", { allow: ["readFile", "*"] })).toBe(true);
    });
  });

  describe("deny 模式", () => {
    it("命中 — 被拒绝", () => {
      expect(PermissionEvaluator.match("rm", { deny: ["rm"] })).toBe(false);
    });

    it("未命中 — 放行", () => {
      expect(PermissionEvaluator.match("readFile", { deny: ["rm"] })).toBe(true);
    });

    it("通配符 * 拒绝所有", () => {
      expect(PermissionEvaluator.match("anything", { deny: ["*"] })).toBe(false);
    });
  });
});
