/**
 * 六条验收，都针对会安静出错的地方：
 *
 * 1. 近层写 `disabled: true` 确实取消了远处同名的定义 —— 这条规则现在在 SDK 的发现里（停用的
 *    条目也占住名字），这一层只把五个路径交过去。它排在这里是因为「不报错、只是多连了一个
 *    用户明确停掉的服务器」正是这一层交路径时最容易漏的那一条。
 * 2. 写回一条不洗掉文件里其他键 —— 洗掉之后没有任何报错，只在用户下次打开文件时发现字段没了。
 * 3. 层归属按「近的赢」算，远处同名的看不见：界面上把一条写到远层、再发现它「没生效」，
 *    原因只在这一条里。
 * 4. 停用的那一条要列得出来（并标出它停在哪一层）、但不在 `effective` 里 —— 两个问题不能由
 *    一份清单回答；只给 `effective`，界面上就永远点不亮「重新启用」。
 * 5. 一层读不出 JSON 不影响别的层：坏文件该让它的那几条少掉，而不是让界面上一片空。
 * 6. 不可写的那三层拒掉（`unsupported`）：不报错而默默写进别人仓库里的 `.mcp.json`，是不可逆的。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    // 近的那一层（项目根）只写停用与另一条完好的；能用的那份同名定义在远的数据根那一层
    writeFileSync(
      join(dirs.cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          files: { disabled: true },
          kept: { command: "npx", args: ["-y", "server-kept"] },
        },
      }),
    );
    writeFileSync(
      join(dirs.dataRoot, "mcp.json"),
      JSON.stringify({
        mcpServers: { files: { type: "stdio", command: "npx", args: ["-y", "server-files"] } },
      }),
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

  it("层归属：近的赢，远处同名的看不见", async () => {
    const dirs = setup();
    // 同一个名字（`files`）写进最近那一层与本层两点：近处写的是 near，远处写的是 far
    mkdirSync(join(dirs.cwd, ".ai-zen"), { recursive: true });
    writeFileSync(
      join(dirs.cwd, ".ai-zen", "mcp.json"),
      JSON.stringify({ mcpServers: { files: { type: "stdio", command: "near" } } }),
    );
    writeFileSync(
      join(dirs.dataRoot, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          files: { type: "stdio", command: "far" },
          search: { type: "http", url: "https://example.com" },
        },
      }),
    );

    const described = await configOf(dirs).describe(dirs.cwd);

    // 同名的只有一条（近的那一条：command 是 near，不是 far），只有远处有的那一条归到 user
    expect(described.map((item) => [item.server.id, item.scope, item.server.command])).toEqual([
      ["files", "workspaceAiZen", "near"],
      ["search", "user", undefined],
    ]);
  });

  it("停用的也列出来，标着它停在哪一层，且不出现在 effective 里", async () => {
    const dirs = setup();
    writeFileSync(
      join(dirs.dataRoot, "mcp.json"),
      JSON.stringify({
        mcpServers: { files: { type: "stdio", command: "npx", disabled: true } },
      }),
    );

    const config = configOf(dirs);
    const described = await config.describe(dirs.cwd);

    expect(described).toHaveLength(1);
    expect(described[0]?.scope).toBe("user");
    expect(described[0]?.server.disabled).toBe(true);
    // 停用的那一条不改变这里：`effective` 回答的是「现在能连哪些」
    await expect(config.effective(dirs.cwd)).resolves.toEqual([]);
  });

  it("一层读不出 JSON 时不影响别的层", async () => {
    const dirs = setup();
    // 项目根那一层（最近的一层）是半截 JSON；用户那一层是好的
    writeFileSync(join(dirs.cwd, ".mcp.json"), '{ "mcpServers": { "broken": { "command": "npx"');
    writeFileSync(
      join(dirs.dataRoot, "mcp.json"),
      JSON.stringify({ mcpServers: { kept: { type: "stdio", command: "npx" } } }),
    );

    const described = await configOf(dirs).describe(dirs.cwd);

    expect(described.map((item) => [item.server.id, item.scope])).toEqual([["kept", "user"]]);
  });

  it("写的那一层不是可写层就拒", async () => {
    const dirs = setup();

    await expect(
      configOf(dirs).save("workspace", dirs.cwd, { id: "x", transport: "stdio", command: "x" }),
    ).rejects.toMatchObject({ code: "unsupported" });

    // 拒得干净：那个项目根上的 `.mcp.json` 里一个键都没多
    expect(existsSync(join(dirs.cwd, ".mcp.json"))).toBe(false);
  });
});
