import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { globTool } from "./glob.js";

function tmpDir(): string {
  const dir = join(tmpdir(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("globTool", () => {
  it("工具名称和描述正确", () => {
    expect(globTool.function.name).toBe("glob");
    expect(globTool.function.description).toContain("扫描和查找文件");
  });

  it("查找匹配的文件", async () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "a.ts"), "", "utf-8");
      writeFileSync(join(dir, "b.ts"), "", "utf-8");
      writeFileSync(join(dir, "c.js"), "", "utf-8");

      const result = await globTool.callback({ path: dir, pattern: "*.ts" });
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

  it("默认排除 node_modules", async () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "pkg.js"), "", "utf-8");
      writeFileSync(join(dir, "index.js"), "", "utf-8");

      const result = await globTool.callback({ path: dir, pattern: "**/*.js" });
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
});
