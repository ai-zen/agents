import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { ReadFileTool } from "./ReadFileTool.js";
import { makeEnv } from "./test-helpers.js";

function tmpFile(content: string): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "test.txt");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function cleanUp(filePath: string): void {
  try { unlinkSync(filePath); } catch {}
  try { unlinkSync(filePath.substring(0, filePath.lastIndexOf("/"))); } catch {}
}

describe("ReadFileTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new ReadFileTool(makeEnv());
    expect(tool.function.name).toBe("readFile");
    expect(tool.function.description).toBe("读取文件");
  });

  it("读取文件内容", async () => {
    const tool = new ReadFileTool(makeEnv());
    const filePath = tmpFile("hello world");
    try {
      const result = await tool.call({ path: filePath });
      expect(result).toBe("hello world");
    } finally {
      cleanUp(filePath);
    }
  });

  it("相对路径按 env.cwd 解析", async () => {
    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "rel.txt");
    writeFileSync(filePath, "relative ok", "utf-8");
    try {
      const tool = new ReadFileTool(makeEnv(dir));
      const result = await tool.call({ path: "rel.txt" });
      expect(result).toBe("relative ok");
    } finally {
      try { unlinkSync(filePath); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("文件不存在时返回错误信息", async () => {
    const tool = new ReadFileTool(makeEnv());
    const result = await tool.call({ path: "/tmp/not-exists-xxx.txt" });
    expect(result).toContain("ENOENT");
  });

  it("超过 300KB 的文件拒绝读取", async () => {
    const tool = new ReadFileTool(makeEnv());
    const filePath = tmpFile("x".repeat(400 * 1024));
    try {
      const result = await tool.call({ path: filePath });
      expect(result).toContain("文件过大");
    } finally {
      cleanUp(filePath);
    }
  });
});
