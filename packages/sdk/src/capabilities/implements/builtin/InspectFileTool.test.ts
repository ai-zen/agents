import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { InspectFileTool } from "./InspectFileTool.js";
import { makeEnv } from "./test-helpers.js";
import type { AppConfig } from "../../../types/index.js";

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
  } catch {}
  try {
    unlinkSync(filePath.substring(0, filePath.lastIndexOf("/")));
  } catch {}
}

describe("InspectFileTool", () => {
  it("工具名称与参数默认值正确", () => {
    const tool = new InspectFileTool(makeEnv());
    expect(tool.function.name).toBe("inspectFile");
    expect(tool.function.description).toContain("结构概况");
    const params = tool.function.parameters as any;
    expect(params.properties.withColCountMap.default).toBe(false);
    expect(params.required).toEqual(["path"]);
  });

  it("返回概况：行数、字符数、最长行、平均列数、行尾类型", async () => {
    const tool = new InspectFileTool(makeEnv());
    const filePath = tmpFile("abc\ndefg\n");
    try {
      const result = await tool.call({ path: filePath });
      const parsed = JSON.parse(result as string);

      expect(parsed.bytes).toBe(9);
      expect(parsed.lines).toBe(2);
      expect(parsed.chars).toBe(7);
      expect(parsed.maxCol).toBe(4);
      expect(parsed.lineIndexOfMaxCol).toBe(1);
      expect(parsed.avgCol).toBe(4);
      expect(parsed.lineEnding).toBe("LF");
      // 默认不返回明细
      expect(parsed.colCountMap).toBeUndefined();
    } finally {
      cleanUp(filePath);
    }
  });

  it("withColCountMap 返回行索引到列数的映射（0-based）", async () => {
    const tool = new InspectFileTool(makeEnv());
    const filePath = tmpFile("abc\ndefg\n");
    try {
      const result = await tool.call({ path: filePath, withColCountMap: true });
      const parsed = JSON.parse(result as string);
      expect(parsed.colCountMap).toEqual({ "0": 3, "1": 4 });
    } finally {
      cleanUp(filePath);
    }
  });

  it("CRLF 文件：行尾类型为 CRLF，列数不含 \\r", async () => {
    const tool = new InspectFileTool(makeEnv());
    const filePath = tmpFile("abc\r\ndefg\r\n");
    try {
      const result = await tool.call({ path: filePath, withColCountMap: true });
      const parsed = JSON.parse(result as string);
      expect(parsed.lineEnding).toBe("CRLF");
      expect(parsed.lines).toBe(2);
      expect(parsed.chars).toBe(7);
      expect(parsed.maxCol).toBe(4);
      expect(parsed.colCountMap).toEqual({ "0": 3, "1": 4 });
    } finally {
      cleanUp(filePath);
    }
  });

  it("混合行尾判定为 mixed", async () => {
    const tool = new InspectFileTool(makeEnv());
    const filePath = tmpFile("a\r\nb\nc");
    try {
      const result = await tool.call({ path: filePath });
      const parsed = JSON.parse(result as string);
      expect(parsed.lineEnding).toBe("mixed");
      expect(parsed.lines).toBe(3);
    } finally {
      cleanUp(filePath);
    }
  });

  it("末行无换行符时仍计入行数", async () => {
    const tool = new InspectFileTool(makeEnv());
    const filePath = tmpFile("abc\ndef");
    try {
      const result = await tool.call({ path: filePath, withColCountMap: true });
      const parsed = JSON.parse(result as string);
      expect(parsed.lines).toBe(2);
      expect(parsed.chars).toBe(6);
      expect(parsed.maxCol).toBe(3);
      expect(parsed.colCountMap).toEqual({ "0": 3, "1": 3 });
    } finally {
      cleanUp(filePath);
    }
  });

  it("空文件行数为 0", async () => {
    const tool = new InspectFileTool(makeEnv());
    const filePath = tmpFile("");
    try {
      const result = await tool.call({ path: filePath });
      const parsed = JSON.parse(result as string);
      expect(parsed.lines).toBe(0);
      expect(parsed.chars).toBe(0);
      expect(parsed.avgCol).toBe(0);
    } finally {
      cleanUp(filePath);
    }
  });

  it("不受 readFile 的 300KB 阈值限制（流式扫描大文件）", async () => {
    const tool = new InspectFileTool(makeEnv());
    const filePath = tmpFile("x".repeat(300 * 1024) + "\nyy");
    try {
      const result = await tool.call({ path: filePath });
      const parsed = JSON.parse(result as string);
      expect(parsed.lines).toBe(2);
      expect(parsed.maxCol).toBe(300 * 1024);
      expect(parsed.lineIndexOfMaxCol).toBe(0);
    } finally {
      cleanUp(filePath);
    }
  });

  it("明细超过 maxToolOutput 时只返回概况 + 提示，不落盘", async () => {
    const tool = new InspectFileTool(makeEnv(process.cwd(), { maxToolOutput: 100 } as AppConfig));
    const filePath = tmpFile("abcdefghij\n".repeat(20));
    try {
      const result = await tool.call({ path: filePath, withColCountMap: true });
      const parsed = JSON.parse(result as string);

      expect(parsed.colCountMapOmitted).toBe(true);
      expect(parsed.warning).toContain("超过上限 100 字符");
      expect(parsed.colCountMap).toBeUndefined();
      // 概况仍然可用
      expect(parsed.lines).toBe(20);
      expect(parsed.maxCol).toBe(10);
      // 不落盘：无 files 字段
      expect(parsed.files).toBeUndefined();
    } finally {
      cleanUp(filePath);
    }
  });

  it("路径为目录时提示不是文件", async () => {
    const tool = new InspectFileTool(makeEnv());
    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    mkdirSync(dir, { recursive: true });
    try {
      const result = await tool.call({ path: dir });
      expect(result).toContain("不是文件");
    } finally {
      try {
        unlinkSync(dir);
      } catch {}
    }
  });

  it("文件不存在时返回错误信息", async () => {
    const tool = new InspectFileTool(makeEnv());
    const result = await tool.call({ path: "/tmp/not-exists-inspect-xxx.txt" });
    expect(result).toContain("ENOENT");
  });
});
