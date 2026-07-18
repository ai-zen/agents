import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { copyTool } from "./copy.js";

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("copyTool", () => {
  it("工具名称和描述正确", () => {
    expect(copyTool.function.name).toBe("copy");
    expect(copyTool.function.description).toContain("复制");
  });

  it("复制文件", async () => {
    const dir = tmpDir();
    const src = join(dir, "src.txt");
    const dest = join(dir, "dest.txt");
    writeFileSync(src, "content", "utf-8");
    try {
      const result = await copyTool.callback({ src, dest });
      expect(result).toBe("success");
      expect(readFileSync(dest, "utf-8")).toBe("content");
    } finally {
      try { unlinkSync(dest); } catch {}
      try { unlinkSync(src); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("递归复制目录", async () => {
    const dir = tmpDir();
    const srcDir = join(dir, "src");
    const destDir = join(dir, "dest");
    mkdirSync(join(srcDir, "sub"), { recursive: true });
    writeFileSync(join(srcDir, "a.txt"), "a", "utf-8");
    writeFileSync(join(srcDir, "sub", "b.txt"), "b", "utf-8");
    try {
      const result = await copyTool.callback({ src: srcDir, dest: destDir, recursive: true });
      expect(result).toBe("success");
      expect(readFileSync(join(destDir, "a.txt"), "utf-8")).toBe("a");
      expect(readFileSync(join(destDir, "sub", "b.txt"), "utf-8")).toBe("b");
    } finally {
      try { unlinkSync(join(destDir, "sub", "b.txt")); } catch {}
      try { unlinkSync(join(destDir, "a.txt")); } catch {}
      try { unlinkSync(join(destDir, "sub")); } catch {}
      try { unlinkSync(destDir); } catch {}
      try { unlinkSync(join(srcDir, "sub", "b.txt")); } catch {}
      try { unlinkSync(join(srcDir, "a.txt")); } catch {}
      try { unlinkSync(join(srcDir, "sub")); } catch {}
      try { unlinkSync(srcDir); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("不递归时复制目录返回错误", async () => {
    const dir = tmpDir();
    const srcDir = join(dir, "src");
    const destDir = join(dir, "dest");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a.txt"), "a", "utf-8");
    try {
      const result = await copyTool.callback({ src: srcDir, dest: destDir });
      expect(typeof result).toBe("string");
      expect(result).not.toBe("success");
    } finally {
      try { unlinkSync(join(srcDir, "a.txt")); } catch {}
      try { unlinkSync(srcDir); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });
});
