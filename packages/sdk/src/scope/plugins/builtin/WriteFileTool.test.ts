import { describe, it, expect } from "vitest";
import { readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { WriteFileTool } from "./WriteFileTool.js";
import { makeEnv } from "./test-helpers.js";

function tmpDir(): string {
  return join(tmpdir(), randomBytes(8).toString("hex"));
}

describe("WriteFileTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new WriteFileTool(makeEnv());
    expect(tool.function.name).toBe("writeFile");
    expect(tool.function.description).toBe("写入文件");
  });

  it("写入文件内容", async () => {
    const tool = new WriteFileTool(makeEnv());
    const dir = tmpDir();
    const filePath = join(dir, "test.txt");
    try {
      const result = await tool.call({ path: filePath, content: "hello world" });
      expect(result).toBe("success");
      expect(readFileSync(filePath, "utf-8")).toBe("hello world");
    } finally {
      try { unlinkSync(filePath); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("相对路径按 env.cwd 解析", async () => {
    const dir = tmpDir();
    try {
      const tool = new WriteFileTool(makeEnv(dir));
      const result = await tool.call({ path: "rel.txt", content: "relative ok" });
      expect(result).toBe("success");
      expect(readFileSync(join(dir, "rel.txt"), "utf-8")).toBe("relative ok");
    } finally {
      try { unlinkSync(join(dir, "rel.txt")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("自动创建不存在的目录", async () => {
    const tool = new WriteFileTool(makeEnv());
    const dir = tmpDir();
    const filePath = join(dir, "sub", "nested", "test.txt");
    try {
      const result = await tool.call({ path: filePath, content: "nested" });
      expect(result).toBe("success");
      expect(readFileSync(filePath, "utf-8")).toBe("nested");
    } finally {
      try { unlinkSync(filePath); } catch {}
      try { unlinkSync(join(dir, "sub", "nested")); } catch {}
      try { unlinkSync(join(dir, "sub")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });
});
