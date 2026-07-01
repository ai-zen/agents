import { describe, it, expect } from "vitest";
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { rmTool } from "./rm.js";

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("rmTool", () => {
  it("工具名称和描述正确", () => {
    expect(rmTool.function.name).toBe("rm");
    expect(rmTool.function.description).toBe("删除文件或目录");
  });

  it("删除文件", async () => {
    const dir = tmpDir();
    const filePath = join(dir, "test.txt");
    writeFileSync(filePath, "hello", "utf-8");
    expect(existsSync(filePath)).toBe(true);

    const result = await rmTool.callback({ path: filePath });
    expect(result).toBe("success");
    expect(existsSync(filePath)).toBe(false);

    try { unlinkSync(dir); } catch {}
  });

  it("递归删除目录", async () => {
    const dir = tmpDir();
    const subDir = join(dir, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "file.txt"), "content", "utf-8");
    expect(existsSync(dir)).toBe(true);

    const result = await rmTool.callback({ path: dir, recursive: true });
    expect(result).toBe("success");
    expect(existsSync(dir)).toBe(false);
  });

  it("不递归时删除非空目录返回错误", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "file.txt"), "content", "utf-8");

    const result = await rmTool.callback({ path: dir });
    expect(result).not.toBe("success");

    try { await rmTool.callback({ path: dir, recursive: true }); } catch {}
  });

  it("删除不存在的路径返回错误", async () => {
    const result = await rmTool.callback({ path: "/tmp/not-exists-xxx" });
    expect(result).toContain("ENOENT");
  });
});
