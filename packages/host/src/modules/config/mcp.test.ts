/**
 * 两条验收，都针对会安静出错的地方：
 *
 * 1. 传输方式不写 `type` 时按形状推断 —— 收紧成必填会让别的工具写的那份 `.mcp.json` 整层读不
 *    出来，而那一层宿主只读不改，报「配置坏了」既不真、又没法修。
 * 2. 写回一条不洗掉文件里其他键 —— 洗掉之后没有任何报错，只在用户下次打开文件时发现字段没了。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { McpConfig } from "./mcp.js";

function setup(): { dataRoot: string; homeDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "ai-zen-mcp-"));
  const dirs = {
    dataRoot: join(root, "data"),
    homeDir: join(root, "home"),
    cwd: join(root, "proj"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return dirs;
}

function configOf(dirs: { dataRoot: string; homeDir: string; cwd: string }): McpConfig {
  return new McpConfig({
    dataRoot: dirs.dataRoot,
    homeDir: dirs.homeDir,
    events: createBus(),
    t: (text: string) => text,
  });
}

describe("MCP 配置", () => {
  it("不带 type 的文件也读得出来：给 command 就是 stdio，否则按 http 算", async () => {
    const dirs = setup();
    writeFileSync(
      join(dirs.cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          files: { command: "npx", args: ["-y", "server-files"] },
          remote: { url: "https://example.com/mcp" },
        },
      }),
    );

    const servers = await configOf(dirs).effective(dirs.cwd);

    expect(servers.map((server) => [server.id, server.transport])).toEqual([
      ["files", "stdio"],
      ["remote", "http"],
    ]);
  });

  it("保存一条只动那一条，文件里其他键原样留着", async () => {
    const dirs = setup();
    const path = join(dirs.dataRoot, "mcp.json");
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          a: { type: "stdio", command: "x", timeout: 30000 },
          b: { type: "http", url: "https://example.com" },
        },
        somethingElse: { keep: true },
      }),
    );

    await configOf(dirs).save("user", dirs.cwd, { id: "a", transport: "stdio", command: "y" });

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.somethingElse).toEqual({ keep: true });
    expect(written.mcpServers.a).toEqual({ type: "stdio", command: "y", timeout: 30000 });
    expect(written.mcpServers.b).toEqual({ type: "http", url: "https://example.com" });
  });
});
