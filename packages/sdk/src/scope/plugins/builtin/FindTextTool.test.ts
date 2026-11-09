import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { FindTextTool } from "./FindTextTool.js";
import { makeEnv } from "./test-helpers.js";
import { cleanupDumpDir } from "../../../test-support/tool-output.js";
import type { ToolCallContext } from "@ai-zen/agents-core";
import type { AppConfig } from "../../../types/index.js";

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("FindTextTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new FindTextTool(makeEnv());
    expect(tool.function.name).toBe("find_text");
    expect(tool.function.description).toContain("Find where text occurs");
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
      try {
        rmSync(join(dir, "test.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
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
      try {
        rmSync(join(dir, "code.ts"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("未提供 text 和 regex 时返回提示", async () => {
    const tool = new FindTextTool(makeEnv());
    const result = await tool.call({ path: "/tmp", pattern: "*.txt" });
    expect(result).toContain("Provide either the text or the regex");
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
      try {
        rmSync(join(dir, "index.js"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(join(dir, "node_modules", "pkg.js"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(join(dir, "node_modules"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("signal 已 aborted 时返回 aborted 结果", async () => {
    const tool = new FindTextTool(makeEnv());
    const dir = tmpDir();
    const controller = new AbortController();
    controller.abort();
    try {
      writeFileSync(join(dir, "a.js"), "hello world", "utf-8");
      const result = await tool.call({ path: dir, pattern: "*.js", text: "hello" }, {
        signal: controller.signal,
      } as unknown as ToolCallContext);
      const parsed = JSON.parse(result as string);
      expect(parsed.aborted).toBe(true);
      expect(Array.isArray(parsed.results)).toBe(true);
    } finally {
      try {
        rmSync(join(dir, "a.js"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("maxMatches 截断结果并标记 truncated", async () => {
    const tool = new FindTextTool(makeEnv());
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "data.txt"), "x\nx\nx\nx\nx", "utf-8");
      const result = await tool.call({ path: dir, pattern: "*.txt", text: "x", maxMatches: 2 });
      const parsed = JSON.parse(result as string);
      expect(parsed.truncated).toBe(true);
      expect(parsed.totalMatches).toBe(2);
      expect(parsed.results.length).toBe(1);
      expect(parsed.results[0].matches.length).toBe(2);
    } finally {
      try {
        rmSync(join(dir, "data.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("maxFileSize 跳过过大的文件", async () => {
    const tool = new FindTextTool(makeEnv());
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "small.txt"), "needle", "utf-8");
      writeFileSync(join(dir, "big.txt"), "needle" + "a".repeat(100), "utf-8");
      const result = await tool.call({
        path: dir,
        pattern: "*.txt",
        text: "needle",
        maxFileSize: 10,
      });
      const parsed = JSON.parse(result as string);
      expect(parsed.length).toBe(1);
      expect(parsed[0].file).toBe("small.txt");
    } finally {
      try {
        rmSync(join(dir, "small.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(join(dir, "big.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("maxLineLength 截断行内容", async () => {
    const tool = new FindTextTool(makeEnv());
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "data.txt"), "abcdefghij_needle_rest_of_long_line", "utf-8");
      const result = await tool.call({
        path: dir,
        pattern: "*.txt",
        text: "needle",
        maxLineLength: 10,
      });
      const parsed = JSON.parse(result as string);
      expect(parsed[0].matches[0].content).toBe("abcdefghij…");
    } finally {
      try {
        rmSync(join(dir, "data.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("输出超过 maxToolOutput 时落盘 result.json 并返回警告与头尾预览", async () => {
    const tool = new FindTextTool(makeEnv(process.cwd(), { maxToolOutput: 100 } as AppConfig));
    const dir = tmpDir();
    let dumpPath: string | undefined;
    try {
      const lines = Array.from({ length: 30 }, (_, i) => `needle-${i}`).join("\n");
      writeFileSync(join(dir, "data.txt"), lines, "utf-8");

      const result = await tool.call({ path: dir, pattern: "*.txt", text: "needle" });
      const parsed = JSON.parse(result as string);

      expect(parsed.outputTooLarge).toBe(true);
      expect(parsed.warning).toContain("exceeding the limit of 100 characters");

      // 完整结果落盘
      dumpPath = dirname(parsed.files["result.json"]);
      const dumped = JSON.parse(readFileSync(parsed.files["result.json"], "utf-8"));
      expect(dumped[0].file).toBe("data.txt");
      expect(dumped[0].matches.length).toBe(30);
      expect(parsed.chars).toBeGreaterThan(100);
      // 仅头部预览
      expect(typeof parsed.head).toBe("string");
      expect(parsed.omitted).toBeGreaterThan(0);
      expect(parsed.tail).toBeUndefined();
    } finally {
      // 工具真的往 <tmp>/ai-zen/tool-output/ 写了一勺，用例要自己擦
      if (dumpPath) cleanupDumpDir(dumpPath);
      try {
        rmSync(join(dir, "data.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("输出未超过 maxToolOutput 时原样返回结果，不落盘", async () => {
    const tool = new FindTextTool(makeEnv(process.cwd(), { maxToolOutput: 100_000 } as AppConfig));
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "data.txt"), "needle", "utf-8");
      const result = await tool.call({ path: dir, pattern: "*.txt", text: "needle" });
      const parsed = JSON.parse(result as string);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].matches.length).toBe(1);
    } finally {
      try {
        rmSync(join(dir, "data.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("基目录不存在时报错，而不是返回空数组", async () => {
    const tool = new FindTextTool(makeEnv());
    const result = await tool.call({
      path: "/tmp/definitely-not-exists-98765",
      pattern: "*.ts",
      text: "needle",
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("does not exist");
  });

  it("基路径是文件而非目录时报错", async () => {
    const tool = new FindTextTool(makeEnv());
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "a.txt"), "needle", "utf-8");
      const result = await tool.call({
        path: join(dir, "a.txt"),
        pattern: "*.txt",
        text: "needle",
      });
      expect(typeof result).toBe("string");
      expect(result).toContain("Not a directory");
    } finally {
      try {
        rmSync(join(dir, "a.txt"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("exclude 未指定时默认排除 node_modules（描述里写明）", async () => {
    const tool = new FindTextTool(makeEnv());
    const exclude = (tool.function.parameters.properties as any).exclude;
    expect(exclude.description).toContain("node_modules");
  });
});
