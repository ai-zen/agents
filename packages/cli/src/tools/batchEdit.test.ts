import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { batchEditTool } from "./batchEdit.js";

function tmpFile(content: string): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "test.txt");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function cleanUp(filePath: string): void {
  try {
    unlinkSync(filePath);
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    try {
      unlinkSync(dir);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

describe("batchEditTool", () => {
  it("工具名称和描述正确", () => {
    expect(batchEditTool.function.name).toBe("batchEdit");
    expect(batchEditTool.function.description).toContain("批量编辑文件文本");
  });

  it("isReplaceAll 默认值为 false", () => {
    const isReplaceAllDef = batchEditTool.function.parameters.properties.replacements.items.properties.isReplaceAll;
    expect(isReplaceAllDef.default).toBe(false);
  });

  it("替换首次匹配（isReplaceAll 默认 false）", async () => {
    const filePath = tmpFile("hello world, hello universe");
    try {
      const result = await batchEditTool.callback({
        path: filePath,
        replacements: [{ oldText: "hello", newText: "hi" }],
      });
      const parsed = JSON.parse(result as string);
      expect(parsed[0].result).toBe("success");
      const content = readFileSync(filePath, "utf-8");
      expect(content).toBe("hi world, hello universe");
    } finally {
      cleanUp(filePath);
    }
  });

  it("isReplaceAll true 时替换所有匹配", async () => {
    const filePath = tmpFile("hello world, hello universe");
    try {
      const result = await batchEditTool.callback({
        path: filePath,
        replacements: [{ oldText: "hello", newText: "hi", isReplaceAll: true }],
      });
      const parsed = JSON.parse(result as string);
      expect(parsed[0].result).toBe("success");
      const content = readFileSync(filePath, "utf-8");
      expect(content).toBe("hi world, hi universe");
    } finally {
      cleanUp(filePath);
    }
  });

  it("isReplaceAll false 时仅替换首次匹配", async () => {
    const filePath = tmpFile("hello world, hello universe");
    try {
      const result = await batchEditTool.callback({
        path: filePath,
        replacements: [{ oldText: "hello", newText: "hi", isReplaceAll: false }],
      });
      const parsed = JSON.parse(result as string);
      expect(parsed[0].result).toBe("success");
      const content = readFileSync(filePath, "utf-8");
      expect(content).toBe("hi world, hello universe");
    } finally {
      cleanUp(filePath);
    }
  });

  it("未匹配到文本时返回提示信息，不修改文件", async () => {
    const filePath = tmpFile("hello world");
    try {
      const result = await batchEditTool.callback({
        path: filePath,
        replacements: [{ oldText: "not-exists", newText: "hi" }],
      });
      const parsed = JSON.parse(result as string);
      expect(parsed[0].result).toBe("文件中未精确匹配到要替换的文本");
      const content = readFileSync(filePath, "utf-8");
      expect(content).toBe("hello world");
    } finally {
      cleanUp(filePath);
    }
  });

  it("多次替换按顺序执行", async () => {
    const filePath = tmpFile("a b c");
    try {
      const result = await batchEditTool.callback({
        path: filePath,
        replacements: [
          { oldText: "a", newText: "x" },
          { oldText: "b", newText: "y" },
          { oldText: "c", newText: "z" },
        ],
      });
      const parsed = JSON.parse(result as string);
      expect(parsed.every((r: any) => r.result === "success")).toBe(true);
      const content = readFileSync(filePath, "utf-8");
      expect(content).toBe("x y z");
    } finally {
      cleanUp(filePath);
    }
  });

  it("文件不存在时返回错误信息", async () => {
    const result = await batchEditTool.callback({
      path: "/tmp/not-exists-file-12345.txt",
      replacements: [{ oldText: "a", newText: "b" }],
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("ENOENT");
  });
});
