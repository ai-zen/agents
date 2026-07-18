import { describe, it, expect } from "vitest";
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { renameTool } from "./rename.js";

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("renameTool", () => {
  it("工具名称和描述正确", () => {
    expect(renameTool.function.name).toBe("rename");
    expect(renameTool.function.description).toContain("重命名");
  });

  it("重命名文件", async () => {
    const dir = tmpDir();
    const oldPath = join(dir, "old.txt");
    const newPath = join(dir, "new.txt");
    writeFileSync(oldPath, "content", "utf-8");
    try {
      const result = await renameTool.callback({ oldPath, newPath });
      expect(result).toBe("success");
      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(newPath)).toBe(true);
    } finally {
      try { unlinkSync(newPath); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("移动文件到不同目录", async () => {
    const dir = tmpDir();
    const subDir = join(dir, "sub");
    mkdirSync(subDir, { recursive: true });
    const oldPath = join(dir, "file.txt");
    const newPath = join(subDir, "file.txt");
    writeFileSync(oldPath, "content", "utf-8");
    try {
      const result = await renameTool.callback({ oldPath, newPath });
      expect(result).toBe("success");
      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(newPath)).toBe(true);
    } finally {
      try { unlinkSync(newPath); } catch {}
      try { unlinkSync(subDir); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("原路径不存在时返回错误", async () => {
    const result = await renameTool.callback({ oldPath: "/tmp/not-exists-xxx", newPath: "/tmp/new-name" });
    expect(result).toContain("ENOENT");
  });
});
