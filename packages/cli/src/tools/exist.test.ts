import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { existTool } from "./exist.js";

describe("existTool", () => {
  it("工具名称和描述正确", () => {
    expect(existTool.function.name).toBe("exist");
    expect(existTool.function.description).toBe("检查文件或目录是否存在");
  });

  it("存在的文件返回 true", async () => {
    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    const filePath = join(dir, "test.txt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, "hello", "utf-8");
    try {
      const result = await existTool.callback({ path: filePath });
      expect(result).toBe("true");
    } finally {
      try { unlinkSync(filePath); } catch {}
      try { unlinkSync(dir); } catch {}
    }
  });

  it("不存在的路径返回 false", async () => {
    const result = await existTool.callback({ path: "/tmp/not-exists-xxx" });
    expect(result).toBe("false");
  });

  it("存在的目录返回 true", async () => {
    const dir = join(tmpdir(), randomBytes(8).toString("hex"));
    mkdirSync(dir, { recursive: true });
    try {
      const result = await existTool.callback({ path: dir });
      expect(result).toBe("true");
    } finally {
      try { unlinkSync(dir); } catch {}
    }
  });
});
