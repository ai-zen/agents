import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { MkdirTool } from "./MkdirTool.js";
import { makeEnv } from "./test-helpers.js";

function tmpDir(): string {
  return join(tmpdir(), randomBytes(8).toString("hex"));
}

describe("MkdirTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new MkdirTool(makeEnv());
    expect(tool.function.name).toBe("mkdir");
    expect(tool.function.description).toBe("创建目录");
  });

  it("创建单层目录", async () => {
    const tool = new MkdirTool(makeEnv());
    const dir = tmpDir();
    try {
      const result = await tool.call({ path: dir });
      expect(result).toBe("success");
      expect(existsSync(dir)).toBe(true);
    } finally {
      try { unlinkSync(dir); } catch {}
    }
  });

  it("相对路径按 env.cwd 解析", async () => {
    const base = tmpDir();
    mkdirSync(base, { recursive: true });
    try {
      const tool = new MkdirTool(makeEnv(base));
      const result = await tool.call({ path: "sub" });
      expect(result).toBe("success");
      expect(existsSync(join(base, "sub"))).toBe(true);
    } finally {
      try { unlinkSync(join(base, "sub")); } catch {}
      try { unlinkSync(base); } catch {}
    }
  });

  it("递归创建多层目录", async () => {
    const tool = new MkdirTool(makeEnv());
    const base = tmpDir();
    const nested = join(base, "a", "b", "c");
    try {
      const result = await tool.call({ path: nested, recursive: true });
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
    const tool = new MkdirTool(makeEnv());
    const base = tmpDir();
    const nested = join(base, "a", "b");
    const result = await tool.call({ path: nested });
    expect(result).toContain("ENOENT");
    expect(existsSync(nested)).toBe(false);
  });
});
