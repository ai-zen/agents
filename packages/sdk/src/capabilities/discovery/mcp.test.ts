import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverMcpServers } from "./mcp.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-discovery-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeMcpConfig(filename: string, servers: Record<string, unknown>) {
  writeFileSync(join(dir, filename), JSON.stringify({ servers }, null, 2));
}

describe("discoverMcpServers", () => {
  it("文件不存在返回空数组", () => {
    expect(discoverMcpServers([join(dir, "nonexistent.json")])).toEqual([]);
  });

  it("发现所有 server", () => {
    writeMcpConfig("mcp.json", {
      github: { transport: "stdio", command: "github-mcp" },
      slack: { transport: "http", url: "https://slack.example.com" },
    });

    const result = discoverMcpServers([join(dir, "mcp.json")]);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toEqual(["github", "slack"]);
  });

  it("空 servers 返回空数组", () => {
    writeMcpConfig("mcp.json", {});
    expect(discoverMcpServers([join(dir, "mcp.json")])).toEqual([]);
  });

  it("跳过解析失败的文件", () => {
    writeFileSync(join(dir, "mcp.json"), "{ bad json");
    expect(discoverMcpServers([join(dir, "mcp.json")])).toEqual([]);
  });

  it("多路径：同名 server 靠前路径优先（先到先得）", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-discovery2-"));
    try {
      writeFileSync(join(dir, "mcp.json"), JSON.stringify({
        servers: {
          github: { transport: "stdio", command: "gh" },
        },
      }, null, 2));

      writeFileSync(join(dir2, "mcp.json"), JSON.stringify({
        servers: {
          github: { transport: "http", url: "https://other.example.com" },
        },
      }, null, 2));

      const result = discoverMcpServers([join(dir, "mcp.json"), join(dir2, "mcp.json")]);
      expect(result).toHaveLength(1);
      // dir 在前，应优先
      expect(result[0].id).toBe("github");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("多路径：合并不同 server", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-discovery2-"));
    try {
      writeFileSync(join(dir, "mcp.json"), JSON.stringify({
        servers: {
          github: { transport: "stdio", command: "gh" },
        },
      }, null, 2));

      writeFileSync(join(dir2, "mcp.json"), JSON.stringify({
        servers: {
          slack: { transport: "http", url: "https://slack.example.com" },
        },
      }, null, 2));

      const result = discoverMcpServers([join(dir, "mcp.json"), join(dir2, "mcp.json")]);
      expect(result).toHaveLength(2);
      const ids = result.map((s) => s.id);
      expect(ids).toContain("github");
      expect(ids).toContain("slack");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
