import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { CopyTool } from "./CopyTool.js";
import { makeEnv } from "./test-helpers.js";

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("CopyTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new CopyTool(makeEnv());
    expect(tool.function.name).toBe("copy");
    expect(tool.function.description).toContain("Copy a file or directory");
  });

  it("复制文件", async () => {
    const tool = new CopyTool(makeEnv());
    const dir = tmpDir();
    const src = join(dir, "src.txt");
    const dest = join(dir, "dest.txt");
    writeFileSync(src, "content", "utf-8");
    try {
      const result = await tool.call({ src, dest });
      expect(result).toBe("success");
      expect(readFileSync(dest, "utf-8")).toBe("content");
    } finally {
      try {
        rmSync(dest, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(src, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("递归复制目录", async () => {
    const tool = new CopyTool(makeEnv());
    const dir = tmpDir();
    const srcDir = join(dir, "src");
    const destDir = join(dir, "dest");
    mkdirSync(join(srcDir, "sub"), { recursive: true });
    writeFileSync(join(srcDir, "a.txt"), "a", "utf-8");
    writeFileSync(join(srcDir, "sub", "b.txt"), "b", "utf-8");
    try {
      const result = await tool.call({ src: srcDir, dest: destDir, recursive: true });
      expect(result).toBe("success");
      expect(readFileSync(join(destDir, "a.txt"), "utf-8")).toBe("a");
      expect(readFileSync(join(destDir, "sub", "b.txt"), "utf-8")).toBe("b");
    } finally {
      try {
        rmSync(join(destDir, "sub", "b.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(join(destDir, "a.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(join(destDir, "sub"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(destDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(join(srcDir, "sub", "b.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(join(srcDir, "a.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(join(srcDir, "sub"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(srcDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("不递归时复制目录返回错误", async () => {
    const tool = new CopyTool(makeEnv());
    const dir = tmpDir();
    const srcDir = join(dir, "src");
    const destDir = join(dir, "dest");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a.txt"), "a", "utf-8");
    try {
      const result = await tool.call({ src: srcDir, dest: destDir });
      expect(typeof result).toBe("string");
      expect(result).not.toBe("success");
    } finally {
      try {
        rmSync(join(srcDir, "a.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(srcDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});
