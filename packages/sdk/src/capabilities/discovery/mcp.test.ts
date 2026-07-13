import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverMcpServers } from "./mcp";
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
});
