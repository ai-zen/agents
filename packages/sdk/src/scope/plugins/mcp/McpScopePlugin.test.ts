import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scope } from "../../Scope.js";
import { McpConnectionManager } from "./McpConnectionManager.js";
import { McpScopePlugin, staleMcpConnections } from "./McpScopePlugin.js";
import type { AppConfig, McpServerConfig } from "../../../types/index.js";

/**
 * MCP 连接与发现结果的对账。
 *
 * 配置改动的本质是「磁盘上 mcp.json 变成另一个样子」，所以刷一次 Scope 就得让连接跟着变；
 * 这里盯的是对账口径本身（哪些算「定义变了」）以及它落到 `disconnect()` 上的效果。
 */

const CONFIG: AppConfig = { endpoints: [], models: [] };

/** 一个 stdio 定义（覆盖时只写关心的字段） */
function stdio(id: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id, transport: "stdio", command: "gh", ...extra };
}

function http(id: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id, transport: "http", url: "https://example.test/mcp", ...extra };
}

describe("staleMcpConnections — 哪些连接该断", () => {
  it("这次发现里消失的 server 要断", () => {
    expect(staleMcpConnections([stdio("a"), stdio("b")], [stdio("a")])).toEqual(["b"]);
  });

  it("定义变了的要断：command / args / env / url / headers / transport 任一不同", () => {
    const cases: McpServerConfig[][] = [
      [stdio("s"), stdio("s", { command: "gh-next" })],
      [stdio("s"), stdio("s", { args: ["--stdio"] })],
      [stdio("s", { env: { TOKEN: "旧" } }), stdio("s", { env: { TOKEN: "新" } })],
      [http("s"), http("s", { url: "https://example.test/mcp2" })],
      [
        http("s", { headers: { Authorization: "a" } }),
        http("s", { headers: { Authorization: "b" } }),
      ],
      [http("s"), stdio("s")],
    ];
    for (const [before, after] of cases) {
      expect(staleMcpConnections([before!], [after!])).toEqual(["s"]);
    }
  });

  it("定义没变的一个字节都不动：字段顺序不同、只改 description 都不算变", () => {
    const before = stdio("s", {
      args: ["--a", "--b"],
      env: { A: "1", B: "2" },
      description: "旧描述",
    });
    // 同一个的定义，只是对象键的书写顺序不同 + description 换了
    const after: McpServerConfig = {
      description: "新描述",
      env: { B: "2", A: "1" },
      args: ["--a", "--b"],
      command: "gh",
      transport: "stdio",
      id: "s",
    };
    expect(staleMcpConnections([before], [after])).toEqual([]);
  });

  it("新增的不在结论里（新增不主动连，保持懒连接）", () => {
    expect(staleMcpConnections([stdio("a")], [stdio("a"), stdio("b")])).toEqual([]);
    expect(staleMcpConnections([], [stdio("b")])).toEqual([]);
  });
});

describe("McpScopePlugin.discover — 连接跟着发现结果对账", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-zen-mcp-reconcile-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeServers(servers: Record<string, unknown>): void {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }), "utf8");
  }

  /** 装配一个只有 MCP 插件的 Scope（配置文件就在 tmp 目录里） */
  async function makeScope(): Promise<Scope> {
    const scope = new Scope({ getConfig: () => CONFIG, agentsDir: "", cwd: dir }).use(
      new McpScopePlugin({ paths: [join(dir, "mcp.json")] }),
    );
    await scope.init();
    return scope;
  }

  /** 替身记账：断开了哪些 server、有没有偷偷建链 */
  function recordConnections() {
    const disconnect = vi
      .spyOn(McpConnectionManager.prototype, "disconnect")
      .mockResolvedValue(undefined);
    const connect = vi.spyOn(McpConnectionManager.prototype, "connect");
    return {
      disconnected: () => disconnect.mock.calls.map((call) => call[0]),
      connects: () => connect.mock.calls.length,
    };
  }

  it("定义变了的 server 会断开旧连接，且不主动建新连接", async () => {
    writeServers({ github: { type: "stdio", command: "gh" } });
    const scope = await makeScope();
    const ledger = recordConnections();

    writeServers({ github: { type: "stdio", command: "gh", args: ["--repo"] } });
    await scope.refresh();

    expect(ledger.disconnected()).toEqual(["github"]);
    expect(ledger.connects()).toBe(0);
  });

  it("消失的断开、没变的不动、新增的不主动连", async () => {
    writeServers({
      stay: { type: "stdio", command: "gh" },
      gone: { type: "stdio", command: "node" },
    });
    const scope = await makeScope();
    const ledger = recordConnections();

    writeServers({
      stay: { type: "stdio", command: "gh" },
      fresh: { type: "http", url: "https://example.test/mcp" },
    });
    await scope.refresh();

    expect(ledger.disconnected()).toEqual(["gone"]);
    expect(ledger.connects()).toBe(0);
    // 候选集按新的发现结果：消失了的不在、新增的在
    const candidates = scope.filter({
      id: "t",
      name: "t",
      messages: [],
      permissions: { mcps: { allow: ["*"] } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(candidates.mcps).toEqual(["stay", "fresh"]);
  });

  it("配置没动时一个连接都不碰", async () => {
    writeServers({ stay: { type: "stdio", command: "gh" } });
    const scope = await makeScope();
    const ledger = recordConnections();

    await scope.refresh();

    expect(ledger.disconnected()).toEqual([]);
    expect(ledger.connects()).toBe(0);
  });
});
