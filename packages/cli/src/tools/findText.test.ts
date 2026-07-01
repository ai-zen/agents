import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { findTextTool } from "./findText.js";

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("findTextTool", () => {
  it("工具名称和描述正确", () => {
    expect(findTextTool.function.name).toBe("findText");
    expect(findTextTool.function.description).toContain("查找文本");
  });

  it("普通文本查找", async () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "test.txt"), "hello world\nfoo bar\nhello again", "utf-8");
      const result = await findTextTool.callback({ path: dir, pattern: "*.txt", text: "hello" });
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
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "code.ts"), "const x = 1\nlet y = 2\nvar z = 3", "utf-8");
      const result = await findTextTool.callback({ path: dir, pattern: "*.ts", regex: "\\b(const|let)\\b" });
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
    const result = await findTextTool.callback({ path: "/tmp", pattern: "*.txt" });
    expect(result).toContain("请提供 text 或 regex");
  });

  it("默认排除 node_modules", async () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      writeFileSync(join(dir, "index.js"), "hello world", "utf-8");
      writeFileSync(join(dir, "node_modules", "pkg.js"), "hello world", "utf-8");

      const result = await findTextTool.callback({ path: dir, pattern: "**/*.js", text: "hello" });
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
});
