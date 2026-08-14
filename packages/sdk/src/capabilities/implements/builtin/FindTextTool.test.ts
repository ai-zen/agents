import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { FindTextTool } from "./FindTextTool.js";
import { makeEnv } from "./test-helpers.js";
import type { ToolCallContext } from "@ai-zen/agents-core";

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("FindTextTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new FindTextTool(makeEnv());
    expect(tool.function.name).toBe("findText");
    expect(tool.function.description).toContain("查找文本");
  });

  it("普通文本查找", async () => {
    const tool = new FindTextTool(makeEnv());
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "test.txt"), "hello world\nfoo bar\nhello again", "utf-8");
      const result = await tool.call({ path: dir, pattern: "*.txt", text: "hello" });
      const parsed = JSON.parse(result as string);
      expect(parsed.length).toBe(1);
      expect(parsed[0].file).toBe("test.txt");
      expect(parsed[0].matches.length).toBe(2);
      expect(parsed[0].matches[0].line).toBe(1);
      expect(parsed[0].matches[1].line).toBe(3);
    } finally {
      try { unlinkSync(join(dir, "test.txt")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("正则表达式查找", async () => {
    const tool = new FindTextTool(makeEnv());
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "code.ts"), "const x = 1\nlet y = 2\nvar z = 3", "utf-8");
      const result = await tool.call({ path: dir, pattern: "*.ts", regex: "\\b(const|let)\\b" });
      const parsed = JSON.parse(result as string);
      expect(parsed.length).toBe(1);
      expect(parsed[0].matches.length).toBe(2);
      expect(parsed[0].matches[0].match).toBe("const");
      expect(parsed[0].matches[1].match).toBe("let");
    } finally {
      try { unlinkSync(join(dir, "code.ts")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("未提供 text 和 regex 时返回提示", async () => {
    const tool = new FindTextTool(makeEnv());
    const result = await tool.call({ path: "/tmp", pattern: "*.txt" });
    expect(result).toContain("请提供 text 或 regex");
  });

  it("默认排除 node_modules", async () => {
    const tool = new FindTextTool(makeEnv());
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      writeFileSync(join(dir, "index.js"), "hello world", "utf-8");
      writeFileSync(join(dir, "node_modules", "pkg.js"), "hello world", "utf-8");

      const result = await tool.call({ path: dir, pattern: "**/*.js", text: "hello" });
      const parsed = JSON.parse(result as string);
      expect(parsed.length).toBe(1);
      expect(parsed[0].file).toBe("index.js");
    } finally {
      try { unlinkSync(join(dir, "index.js")); } catch {}
      try { unlinkSync(join(dir, "node_modules", "pkg.js")); } catch {}
      try { unlinkSync(join(dir, "node_modules")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("signal 已 aborted 时返回 aborted 结果", async () => {
    const tool = new FindTextTool(makeEnv());
    const dir = tmpDir();
    const controller = new AbortController();
    controller.abort();
    try {
      writeFileSync(join(dir, "a.js"), "hello world", "utf-8");
      const result = await tool.call(
        { path: dir, pattern: "*.js", text: "hello" },
        { signal: controller.signal } as unknown as ToolCallContext,
      );
      const parsed = JSON.parse(result as string);
      expect(parsed.aborted).toBe(true);
      expect(Array.isArray(parsed.results)).toBe(true);
    } finally {
      try { unlinkSync(join(dir, "a.js")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });
});
