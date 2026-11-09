import { describe, it, expect } from "vitest";
import { readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { WriteTool } from "./WriteTool.js";
import { makeEnv } from "./test-helpers.js";

function tmpDir(): string {
  return join(tmpdir(), randomBytes(8).toString("hex"));
}

describe("WriteTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new WriteTool(makeEnv());
    expect(tool.function.name).toBe("write");
    expect(tool.function.description).toBe("Write a file");
  });

  it("写入文件内容", async () => {
    const tool = new WriteTool(makeEnv());
    const dir = tmpDir();
    const filePath = join(dir, "test.txt");
    try {
      const result = await tool.call({ path: filePath, content: "hello world" });
      expect(result).toBe("success");
      expect(readFileSync(filePath, "utf-8")).toBe("hello world");
    } finally {
      try {
        rmSync(filePath, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("相对路径按 env.cwd 解析", async () => {
    const dir = tmpDir();
    try {
      const tool = new WriteTool(makeEnv(dir));
      const result = await tool.call({ path: "rel.txt", content: "relative ok" });
      expect(result).toBe("success");
      expect(readFileSync(join(dir, "rel.txt"), "utf-8")).toBe("relative ok");
    } finally {
      try {
        rmSync(join(dir, "rel.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("自动创建不存在的目录", async () => {
    const tool = new WriteTool(makeEnv());
    const dir = tmpDir();
    const filePath = join(dir, "sub", "nested", "test.txt");
    try {
      const result = await tool.call({ path: filePath, content: "nested" });
      expect(result).toBe("success");
      expect(readFileSync(filePath, "utf-8")).toBe("nested");
    } finally {
      try {
        rmSync(filePath, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(join(dir, "sub", "nested"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(join(dir, "sub"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});
