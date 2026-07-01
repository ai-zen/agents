import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { readFileTool } from "./readFile.js";

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

describe("readFileTool", () => {
  it("工具名称和描述正确", () => {
    expect(readFileTool.function.name).toBe("readFile");
    expect(readFileTool.function.description).toBe("读取文件");
  });

  it("读取文件内容", async () => {
    const filePath = tmpFile("hello world");
    try {
      const result = await readFileTool.callback({ path: filePath });
      expect(result).toBe("hello world");
    } finally {
      cleanUp(filePath);
    }
  });

  it("文件不存在时返回错误信息", async () => {
    const result = await readFileTool.callback({ path: "/tmp/not-exists-xxx.txt" });
    expect(result).toContain("ENOENT");
  });

  it("超过 300KB 的文件拒绝读取", async () => {
    const filePath = tmpFile("x".repeat(400 * 1024));
    try {
      const result = await readFileTool.callback({ path: filePath });
      expect(result).toContain("文件过大");
    } finally {
      cleanUp(filePath);
    }
  });
});
