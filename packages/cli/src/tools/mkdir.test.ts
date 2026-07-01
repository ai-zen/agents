import { describe, it, expect } from "vitest";
import { existsSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { mkdirTool } from "./mkdir.js";

function tmpDir(): string {
  return join(tmpdir(), randomBytes(8).toString("hex"));
}

describe("mkdirTool", () => {
  it("工具名称和描述正确", () => {
    expect(mkdirTool.function.name).toBe("mkdir");
    expect(mkdirTool.function.description).toBe("创建目录");
  });

  it("创建单层目录", async () => {
    const dir = tmpDir();
    try {
      const result = await mkdirTool.callback({ path: dir });
      expect(result).toBe("success");
      expect(existsSync(dir)).toBe(true);
    } finally {
      try { unlinkSync(dir); } catch {}
    }
  });

  it("递归创建多层目录", async () => {
    const base = tmpDir();
    const nested = join(base, "a", "b", "c");
    try {
      const result = await mkdirTool.callback({ path: nested, recursive: true });
      expect(result).toBe("success");
      expect(existsSync(nested)).toBe(true);
    } finally {
      try { unlinkSync(join(base, "a", "b", "c")); } catch {}
      try { unlinkSync(join(base, "a", "b")); } catch {}
      try { unlinkSync(join(base, "a")); } catch {}
      try { unlinkSync(base); } catch {}
    }
  });

  it("不递归时创建嵌套目录返回错误", async () => {
    const base = tmpDir();
    const nested = join(base, "a", "b");
    const result = await mkdirTool.callback({ path: nested });
    expect(result).toContain("ENOENT");
    expect(existsSync(nested)).toBe(false);
  });
});
