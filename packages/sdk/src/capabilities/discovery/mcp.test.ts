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
  writeFileSync(join(dir, filename), JSON.stringify({ mcpServers: servers }, null, 2));
}

describe("discoverMcpServers", () => {
  it("文件不存在返回空数组", () => {
    expect(discoverMcpServers([join(dir, "nonexistent.json")])).toEqual([]);
  });

  it("发现所有 server", () => {
    writeMcpConfig("mcp.json", {
      github: { type: "stdio", command: "github-mcp" },
      slack: { type: "http", url: "https://slack.example.com" },
    });

    const result = discoverMcpServers([join(dir, "mcp.json")]);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toEqual(["github", "slack"]);
  });

  it("兼容 transport 字段名", () => {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: {
        legacy: { transport: "stdio", command: "legacy-mcp" },
      },
    }, null, 2));

    const result = discoverMcpServers([join(dir, "mcp.json")]);
    expect(result).toHaveLength(1);
    expect(result[0].transport).toBe("stdio");
  });

  it("兼容 transportType 字段名", () => {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: {
        compat: { transportType: "stdio", command: "compat-mcp" },
      },
    }, null, 2));

    const result = discoverMcpServers([join(dir, "mcp.json")]);
    expect(result).toHaveLength(1);
    expect(result[0].transport).toBe("stdio");
  });

  it("type 优先于 transport 和 transportType", () => {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: {
        multi: { type: "http", transport: "stdio", transportType: "sse", url: "https://example.com" },
      },
    }, null, 2));

    const result = discoverMcpServers([join(dir, "mcp.json")]);
    expect(result).toHaveLength(1);
    expect(result[0].transport).toBe("http");
  });

  it("自动推断 transport 类型（有 command 则为 stdio）", () => {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: {
        inferred: { command: "npx", args: ["-y", "some-server"] },
      },
    }, null, 2));

    const result = discoverMcpServers([join(dir, "mcp.json")]);
    expect(result).toHaveLength(1);
    expect(result[0].transport).toBe("stdio");
  });

  it("自动推断 transport 类型（有 url 则为 http）", () => {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: {
        inferred: { url: "https://api.example.com/mcp" },
      },
    }, null, 2));

    const result = discoverMcpServers([join(dir, "mcp.json")]);
    expect(result).toHaveLength(1);
    expect(result[0].transport).toBe("http");
  });

  it("既无 command 也无 url 时跳过", () => {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: {
        invalid: { someField: "value" },
      },
    }, null, 2));

    const result = discoverMcpServers([join(dir, "mcp.json")]);
    expect(result).toHaveLength(0);
  });

  it("跳过 disabled: true 的 server", () => {
    writeMcpConfig("mcp.json", {
      active: { type: "stdio", command: "active-mcp" },
      inactive: { type: "stdio", command: "inactive-mcp", disabled: true },
    });

    const result = discoverMcpServers([join(dir, "mcp.json")]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("active");
  });

  it("空 mcpServers 返回空数组", () => {
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
        mcpServers: {
          github: { type: "stdio", command: "gh" },
        },
      }, null, 2));

      writeFileSync(join(dir2, "mcp.json"), JSON.stringify({
        mcpServers: {
          github: { type: "http", url: "https://other.example.com" },
        },
      }, null, 2));

      const result = discoverMcpServers([join(dir, "mcp.json"), join(dir2, "mcp.json")]);
      expect(result).toHaveLength(1);
      // dir 在前，应优先
      expect(result[0].id).toBe("github");
      expect(result[0].transport).toBe("stdio");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("多路径：合并不同 server", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-discovery2-"));
    try {
      writeFileSync(join(dir, "mcp.json"), JSON.stringify({
        mcpServers: {
          github: { type: "stdio", command: "gh" },
        },
      }, null, 2));

      writeFileSync(join(dir2, "mcp.json"), JSON.stringify({
        mcpServers: {
          slack: { type: "http", url: "https://slack.example.com" },
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
