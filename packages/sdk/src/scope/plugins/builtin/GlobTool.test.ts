import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { GlobTool } from "./GlobTool.js";
import { makeEnv } from "./test-helpers.js";
import { cleanupDumpDir } from "../../../test-support/tool-output.js";
import type { ToolCallContext } from "@ai-zen/agents-core";
import type { AppConfig } from "../../../types/index.js";

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("GlobTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new GlobTool(makeEnv());
    expect(tool.function.name).toBe("glob");
    expect(tool.function.description).toContain("scan for and find files");
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
      try {
        rmSync(join(dir, "a.ts"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(join(dir, "b.ts"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(join(dir, "c.js"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
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
      try {
        rmSync(join(dir, "x.js"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
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
    const tool = new GlobTool(makeEnv());
    const dir = tmpDir();
    const controller = new AbortController();
    controller.abort();
    try {
      writeFileSync(join(dir, "a.ts"), "", "utf-8");
      const result = await tool.call({ path: dir, pattern: "*.ts" }, {
        signal: controller.signal,
      } as unknown as ToolCallContext);
      const parsed = JSON.parse(result as string);
      expect(parsed.aborted).toBe(true);
      expect(Array.isArray(parsed.files)).toBe(true);
    } finally {
      try {
        rmSync(join(dir, "a.ts"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("输出超过 maxToolOutput 时落盘 result.json 并返回警告与头部预览", async () => {
    const tool = new GlobTool(makeEnv(process.cwd(), { maxToolOutput: 100 } as AppConfig));
    const dir = tmpDir();
    const names = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    let dumpPath: string | undefined;
    try {
      for (const name of names) writeFileSync(join(dir, name), "", "utf-8");

      const result = await tool.call({ path: dir, pattern: "*.ts" });
      const parsed = JSON.parse(result as string);

      expect(parsed.outputTooLarge).toBe(true);
      expect(parsed.warning).toContain("exceeding the limit of 100 characters");

      // 完整结果落盘
      dumpPath = dirname(parsed.files["result.json"]);
      const dumped = JSON.parse(readFileSync(parsed.files["result.json"], "utf-8"));
      expect(dumped.length).toBe(30);
      expect(parsed.chars).toBeGreaterThan(100);
      expect(typeof parsed.head).toBe("string");
    } finally {
      // 工具真的往 <tmp>/ai-zen/tool-output/ 写了一勺，用例要自己擦
      if (dumpPath) cleanupDumpDir(dumpPath);
      for (const name of names)
        try {
          rmSync(join(dir, name), { recursive: true, force: true });
        } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("输出未超过 maxToolOutput 时原样返回结果，不落盘", async () => {
    const tool = new GlobTool(makeEnv(process.cwd(), { maxToolOutput: 100_000 } as AppConfig));
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "a.ts"), "", "utf-8");
      const result = await tool.call({ path: dir, pattern: "*.ts" });
      const parsed = JSON.parse(result as string);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toContain("a.ts");
    } finally {
      try {
        rmSync(join(dir, "a.ts"), { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("基目录不存在时报错，而不是返回空数组", async () => {
    const tool = new GlobTool(makeEnv());
    const result = await tool.call({ path: "/tmp/definitely-not-exists-98765", pattern: "*.ts" });
    expect(typeof result).toBe("string");
    expect(result).toContain("does not exist");
  });

  it("基路径是文件而非目录时报错", async () => {
    const tool = new GlobTool(makeEnv());
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "a.txt"), "", "utf-8");
      const result = await tool.call({ path: join(dir, "a.txt"), pattern: "*.ts" });
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
    const tool = new GlobTool(makeEnv());
    const exclude = (tool.function.parameters.properties as any).exclude;
    expect(exclude.description).toContain("node_modules");
  });
});
