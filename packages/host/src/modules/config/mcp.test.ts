/**
 * 两条验收，都针对会安静出错的地方：
 *
 * 1. 近层写 `disabled: true` 取消远处同名的定义 —— SDK 的合并没有这条规则（停用的条目不进
 *    `seen`，远处那份反而赢），只能由这一层补。补齐之后不再有人重做归一化：别名、推断、坏文件
 *    都归 SDK，抄回来就又有两份。
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
    log: { info: () => {}, warn: () => {}, error: () => {} },
    t: (text: string) => text,
  });
}

describe("MCP 配置", () => {
  it("近层的 disabled 取消远处同名的定义", async () => {
    const dirs = setup();
    mkdirSync(join(dirs.cwd, ".ai-zen"), { recursive: true });
    writeFileSync(
      join(dirs.cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          files: { type: "stdio", command: "npx", args: ["-y", "server-files"] },
          kept: { command: "npx", args: ["-y", "server-kept"] },
        },
      }),
    );
    writeFileSync(
      join(dirs.cwd, ".ai-zen", "mcp.json"),
      JSON.stringify({ mcpServers: { files: { disabled: true } } }),
    );
    writeFileSync(
      join(dirs.dataRoot, "mcp.json"),
      JSON.stringify({ mcpServers: { files: { type: "stdio", command: "another" } } }),
    );

    const servers = await configOf(dirs).effective(dirs.cwd);

    expect(servers.map((server) => server.id)).toEqual(["kept"]);
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
