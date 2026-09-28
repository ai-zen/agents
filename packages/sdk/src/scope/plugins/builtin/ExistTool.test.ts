import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { ExistTool } from "./ExistTool.js";
import { makeEnv } from "./test-helpers.js";

describe("ExistTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new ExistTool(makeEnv());
    expect(tool.function.name).toBe("exist");
    expect(tool.function.description).toBe("检查文件或目录是否存在");
  });

  it("存在的文件返回 true", async () => {
    const tool = new ExistTool(makeEnv());
    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    const filePath = join(dir, "test.txt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, "hello", "utf-8");
    try {
      const result = await tool.call({ path: filePath });
      expect(result).toBe("true");
    } finally {
      try { unlinkSync(filePath); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("相对路径按 env.cwd 解析", async () => {
    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rel.txt"), "x", "utf-8");
    try {
      const tool = new ExistTool(makeEnv(dir));
      expect(await tool.call({ path: "rel.txt" })).toBe("true");
      expect(await tool.call({ path: "missing.txt" })).toBe("false");
    } finally {
      try { unlinkSync(join(dir, "rel.txt")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("不存在的路径返回 false", async () => {
    const tool = new ExistTool(makeEnv());
    const result = await tool.call({ path: "/tmp/not-exists-xxx" });
    expect(result).toBe("false");
  });

  it("存在的目录返回 true", async () => {
    const tool = new ExistTool(makeEnv());
    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    mkdirSync(dir, { recursive: true });
    try {
      const result = await tool.call({ path: dir });
      expect(result).toBe("true");
    } finally {
      try { unlinkSync(dir); } catch {}
    }
  });
});
