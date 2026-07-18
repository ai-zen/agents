import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { editTool } from "./edit.js";

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

describe("editTool", () => {
  it("工具名称和描述正确", () => {
    expect(editTool.function.name).toBe("edit");
    expect(editTool.function.description).toContain("编辑文件中的文本");
  });

  it("isReplaceAll 默认值为 false", () => {
    const isReplaceAllDef = editTool.function.parameters.properties.isReplaceAll;
    expect(isReplaceAllDef.default).toBe(false);
  });

  it("未开启替换所有，单次匹配时正常替换", async () => {
    const filePath = tmpFile("hello world");
    try {
      const result = await editTool.callback({ path: filePath, oldText: "hello", newText: "hi" });
      const parsed = JSON.parse(result as string);
      expect(parsed.result).toBe("success");
      expect(parsed.matchCount).toBe(1);
      expect(parsed.replacedCount).toBe(1);
      expect(readFileSync(filePath, "utf-8")).toBe("hi world");
    } finally {
      cleanUp(filePath);
    }
  });

  it("isReplaceAll true 时替换所有匹配", async () => {
    const filePath = tmpFile("hello world, hello universe");
    try {
      const result = await editTool.callback({ path: filePath, oldText: "hello", newText: "hi", isReplaceAll: true });
      const parsed = JSON.parse(result as string);
      expect(parsed.result).toBe("success");
      expect(parsed.matchCount).toBe(2);
      expect(parsed.replacedCount).toBe(2);
      expect(readFileSync(filePath, "utf-8")).toBe("hi world, hi universe");
    } finally {
      cleanUp(filePath);
    }
  });

  it("isReplaceAll false 时仅替换首次匹配，多处匹配时报警告", async () => {
    const filePath = tmpFile("hello world, hello universe");
    try {
      const result = await editTool.callback({ path: filePath, oldText: "hello", newText: "hi", isReplaceAll: false });
      const parsed = JSON.parse(result as string);
      expect(parsed.result).toContain("警告");
      expect(parsed.matchCount).toBe(2);
      expect(parsed.replacedCount).toBe(1);
      expect(readFileSync(filePath, "utf-8")).toBe("hi world, hello universe");
    } finally {
      cleanUp(filePath);
    }
  });

  it("未匹配到文本时返回提示", async () => {
    const filePath = tmpFile("hello world");
    try {
      const result = await editTool.callback({ path: filePath, oldText: "not-exists", newText: "hi" });
      const parsed = JSON.parse(result as string);
      expect(parsed.result).toBe("文件中未精确匹配到要替换的文本");
      expect(parsed.matchCount).toBe(0);
      expect(readFileSync(filePath, "utf-8")).toBe("hello world");
    } finally {
      cleanUp(filePath);
    }
  });

  it("文件不存在时返回错误信息", async () => {
    const result = await editTool.callback({ path: "/tmp/not-exists-file-12345.txt", oldText: "a", newText: "b" });
    expect(typeof result).toBe("string");
    expect(result).toContain("ENOENT");
  });
});
