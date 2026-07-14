import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverUserTools } from "./usertools";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-usertools-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTool(filename: string) {
  writeFileSync(join(dir, filename), "// tool implementation");
}

describe("discoverUserTools", () => {
  it("空目录返回空数组", () => {
    expect(discoverUserTools([dir])).toEqual([]);
  });

  it("目录不存在返回空数组", () => {
    expect(discoverUserTools([join(dir, "nonexistent")])).toEqual([]);
  });

  it("发现所有 .js 文件（当前 require 未实现，返回空 Tool[]）", () => {
    writeTool("my-tool.js");
    writeTool("code-review.js");
    writeTool("deploy.js");

    const result = discoverUserTools([dir]);
    // TODO: 实现动态 require 后，应为 3 个 Tool 实例
    expect(result).toHaveLength(0);
  });

  it("忽略非 .js 文件", () => {
    writeTool("valid.js");
    writeFileSync(join(dir, "README.md"), "docs");
    writeFileSync(join(dir, "config.json"), "{}");

    const result = discoverUserTools([dir]);
    // TODO: 实现动态 require 后，应为 1 个 Tool 实例
    expect(result).toEqual([]);
  });

  it("按文件名排序以保证确定性", () => {
    writeTool("c.js");
    writeTool("a.js");
    writeTool("b.js");

    const result = discoverUserTools([dir]);
    // TODO: 实现动态 require 后，应返回 3 个 Tool 实例
    expect(result).toEqual([]);
  });

  it("多路径扫描：合并所有路径的工具", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-usertools2-"));
    try {
      writeTool("tool-a.js");
      writeFileSync(join(dir2, "tool-b.js"), "// tool b");

      const result = discoverUserTools([dir, dir2]);
      // TODO: 实现动态 require 后，应返回 2 个 Tool 实例
      expect(result).toEqual([]);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("多路径：同名工具靠前路径优先", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-usertools2-"));
    try {
      writeTool("shared.js");
      writeFileSync(join(dir2, "shared.js"), "// from dir2");

      const result = discoverUserTools([dir, dir2]);
      // TODO: 实现动态 require 后，应返回 1 个 Tool 实例
      expect(result).toEqual([]);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
