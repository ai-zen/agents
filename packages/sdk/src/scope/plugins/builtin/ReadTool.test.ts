import { describe, it, expect } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { ReadTool } from "./ReadTool.js";
import { makeEnv } from "../../../test-support/test-helpers.js";
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
    rmSync(filePath, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(filePath.substring(0, filePath.lastIndexOf("/")), { recursive: true, force: true });
  } catch {}
}

describe("ReadTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new ReadTool(makeEnv());
    expect(tool.function.name).toBe("read");
    expect(tool.function.description).toBe("Read a file");
  });

  it("读取文件内容", async () => {
    const tool = new ReadTool(makeEnv());
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
      const tool = new ReadTool(makeEnv(dir));
      const result = await tool.call({ path: "rel.txt" });
      expect(result).toBe("relative ok");
    } finally {
      try {
        rmSync(filePath, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("文件不存在时返回错误信息", async () => {
    const tool = new ReadTool(makeEnv());
    const result = await tool.call({ path: "/tmp/not-exists-xxx.txt" });
    expect(result).toContain("ENOENT");
  });

  it("超过 300KB 的文件拒绝读取", async () => {
    const tool = new ReadTool(makeEnv());
    const filePath = tmpFile("x".repeat(400 * 1024));
    try {
      const result = await tool.call({ path: filePath });
      expect(result).toContain("File too large");
    } finally {
      cleanUp(filePath);
    }
  });

  it("range 不是四个数字时当没给（读全文）", async () => {
    const tool = new ReadTool(makeEnv());
    const filePath = tmpFile("line0\nline1");
    try {
      // 严格模式下正确写法是 null；模型也可能给空数组、半截数组、带 null 的数组
      for (const range of [null, [], [0], [0, 0, null, -1], [0, 0, 1]]) {
        const result = await tool.call({ path: filePath, range: range as unknown as number[] });
        expect(result).toBe("line0\nline1");
      }
    } finally {
      cleanUp(filePath);
    }
  });

  it("range 什么都没选到时说清该怎么办，而不是交一个空串", async () => {
    const tool = new ReadTool(makeEnv());
    const filePath = tmpFile("line0\nline1");
    try {
      const result = (await tool.call({ path: filePath, range: [1, 0, 0, -1] })) as string;
      expect(result).toContain("selected nothing");
      expect(result).toContain("range: null");
    } finally {
      cleanUp(filePath);
    }
  });

  it("range 按行列范围读取（0-based，-1 表末位）", async () => {
    const tool = new ReadTool(makeEnv());
    const filePath = tmpFile("line0\nline1\nline2\nline3");
    try {
      // 第 1 行第 0 列 → 第 2 行末列
      expect(await tool.call({ path: filePath, range: [1, 0, 2, -1] })).toBe("line1\nline2");
      // 单行区间：第 0 行第 0 列 → 第 0 行第 4 列
      expect(await tool.call({ path: filePath, range: [0, 0, 0, 4] })).toBe("line0");
      // 起始列偏移
      expect(await tool.call({ path: filePath, range: [1, 2, 1, -1] })).toBe("ne1");
      // 末位写法：最后一行整行
      expect(await tool.call({ path: filePath, range: [-1, 0, -1, -1] })).toBe("line3");
    } finally {
      cleanUp(filePath);
    }
  });

  it("输出超过 maxToolOutput 时只警告、不落盘，并提示 range 用法", async () => {
    const tool = new ReadTool(makeEnv(process.cwd(), { maxToolOutput: 10 } as AppConfig));
    const filePath = tmpFile("0123456789\nabcdefghij");
    try {
      const result = (await tool.call({ path: filePath })) as string;
      expect(result).toContain("exceeding the limit of 10 characters");
      expect(result).toContain("not written to disk");
      expect(result).toContain("range");
      expect(result).toContain("2 lines");
      // 只警告：不返回落盘路径
      expect(result).not.toContain("files");
    } finally {
      cleanUp(filePath);
    }
  });

  it("range 缩小后的输出未超限时正常返回内容", async () => {
    const tool = new ReadTool(makeEnv(process.cwd(), { maxToolOutput: 10 } as AppConfig));
    const filePath = tmpFile("0123456789\nabcdefghij");
    try {
      expect(await tool.call({ path: filePath, range: [0, 0, 0, 4] })).toBe("01234");
    } finally {
      cleanUp(filePath);
    }
  });
});
