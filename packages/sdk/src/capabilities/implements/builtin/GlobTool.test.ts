import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { GlobTool } from "./GlobTool.js";
import { makeEnv } from "./test-helpers.js";
import type { ToolCallContext } from "@ai-zen/agents-core";

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("GlobTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new GlobTool(makeEnv());
    expect(tool.function.name).toBe("glob");
    expect(tool.function.description).toContain("扫描和查找文件");
  });

  it("查找匹配的文件", async () => {
    const tool = new GlobTool(makeEnv());
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "a.ts"), "", "utf-8");
      writeFileSync(join(dir, "b.ts"), "", "utf-8");
      writeFileSync(join(dir, "c.js"), "", "utf-8");

      const result = await tool.call({ path: dir, pattern: "*.ts" });
      const files = JSON.parse(result as string);
      expect(files).toContain("a.ts");
      expect(files).toContain("b.ts");
      expect(files).not.toContain("c.js");
    } finally {
      try { unlinkSync(join(dir, "a.ts")); } catch {}
      try { unlinkSync(join(dir, "b.ts")); } catch {}
      try { unlinkSync(join(dir, "c.js")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("未指定 path 时以 env.cwd 为基准", async () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "x.js"), "", "utf-8");
      const tool = new GlobTool(makeEnv(dir));
      const result = await tool.call({ pattern: "*.js" });
      const files = JSON.parse(result as string);
      expect(files).toContain("x.js");
    } finally {
      try { unlinkSync(join(dir, "x.js")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("默认排除 node_modules", async () => {
    const tool = new GlobTool(makeEnv());
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "pkg.js"), "", "utf-8");
      writeFileSync(join(dir, "index.js"), "", "utf-8");

      const result = await tool.call({ path: dir, pattern: "**/*.js" });
      const files = JSON.parse(result as string);
      expect(files).toContain("index.js");
      expect(files).not.toContain("node_modules/pkg.js");
    } finally {
      try { unlinkSync(join(dir, "index.js")); } catch {}
      try { unlinkSync(join(dir, "node_modules", "pkg.js")); } catch {}
      try { unlinkSync(join(dir, "node_modules")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("signal 已 aborted 时返回 aborted 结果", async () => {
    const tool = new GlobTool(makeEnv());
    const dir = tmpDir();
    const controller = new AbortController();
    controller.abort();
    try {
      writeFileSync(join(dir, "a.ts"), "", "utf-8");
      const result = await tool.call(
        { path: dir, pattern: "*.ts" },
        { signal: controller.signal } as unknown as ToolCallContext,
      );
      const parsed = JSON.parse(result as string);
      expect(parsed.aborted).toBe(true);
      expect(Array.isArray(parsed.files)).toBe(true);
    } finally {
      try { unlinkSync(join(dir, "a.ts")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });
});
