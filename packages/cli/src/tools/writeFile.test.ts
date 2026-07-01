import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { writeFileTool } from "./writeFile.js";

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  return dir;
}

describe("writeFileTool", () => {
  it("工具名称和描述正确", () => {
    expect(writeFileTool.function.name).toBe("writeFile");
    expect(writeFileTool.function.description).toBe("写入文件");
  });

  it("写入文件内容", async () => {
    const dir = tmpDir();
    const filePath = join(dir, "test.txt");
    try {
      const result = await writeFileTool.callback({ path: filePath, content: "hello world" });
      expect(result).toBe("success");
      expect(readFileSync(filePath, "utf-8")).toBe("hello world");
    } finally {
      try { unlinkSync(filePath); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("自动创建不存在的目录", async () => {
    const dir = tmpDir();
    const filePath = join(dir, "sub", "nested", "test.txt");
    try {
      const result = await writeFileTool.callback({ path: filePath, content: "nested" });
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
