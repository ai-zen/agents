import { describe, it, expect } from "vitest";
import { matchPermission } from "./permission.js";

describe("matchPermission", () => {
  describe("allow 模式", () => {
    it("命中 — 精确匹配", () => {
      expect(matchPermission("readFile", { allow: ["readFile", "exec"] })).toBe(true);
    });

    it("未命中 — 不在列表中", () => {
      expect(matchPermission("rm", { allow: ["readFile", "exec"] })).toBe(false);
    });

    it("通配符 * 匹配任意", () => {
      expect(matchPermission("anything", { allow: ["*"] })).toBe(true);
    });

    it("通配符在列表中同样生效", () => {
      expect(matchPermission("rm", { allow: ["readFile", "*"] })).toBe(true);
    });
  });

  describe("deny 模式", () => {
    it("命中 — 被拒绝", () => {
      expect(matchPermission("rm", { deny: ["rm"] })).toBe(false);
    });

    it("未命中 — 放行", () => {
      expect(matchPermission("readFile", { deny: ["rm"] })).toBe(true);
    });

    it("通配符 * 拒绝所有", () => {
      expect(matchPermission("anything", { deny: ["*"] })).toBe(false);
    });
  });
});
