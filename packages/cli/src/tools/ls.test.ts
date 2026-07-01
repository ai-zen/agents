import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { lsTool } from "./ls.js";

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("lsTool", () => {
  it("工具名称和描述正确", () => {
    expect(lsTool.function.name).toBe("ls");
    expect(lsTool.function.description).toBe("列出目录");
  });

  it("列出目录内容", async () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "a.txt"), "", "utf-8");
      writeFileSync(join(dir, "b.txt"), "", "utf-8");

      const result = await lsTool.callback({ path: dir });
      const files = JSON.parse(result as string);
      expect(files).toContain("a.txt");
      expect(files).toContain("b.txt");
    } finally {
      try { unlinkSync(join(dir, "a.txt")); } catch {}
      try { unlinkSync(join(dir, "b.txt")); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("列出空目录返回空数组", async () => {
    const dir = tmpDir();
    try {
      const result = await lsTool.callback({ path: dir });
      expect(JSON.parse(result as string)).toEqual([]);
    } finally {
      try { unlinkSync(dir); } catch {}
    }
  });

  it("不存在的目录返回错误", async () => {
    const result = await lsTool.callback({ path: "/tmp/not-exists-xxx-dir" });
    expect(result).toContain("ENOENT");
  });
});
