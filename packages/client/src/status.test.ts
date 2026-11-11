import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "@ai-zen/agents-server";
import { writeDescriptor } from "./wire/discovery.js";
import { readServerStatus } from "./status.js";
import type { ClientInfo } from "./types.js";

const clientInfo: ClientInfo = { name: "@ai-zen/cli", version: "0.0.0-test" };

let dir: string;
let daemon: Daemon | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-cli-status-"));
});

afterEach(async () => {
  await daemon?.stop("test");
  daemon = null;
  rmSync(dir, { recursive: true, force: true });
});

/** 找一个刚空出来的端口（用它来构造"发现文件在、没人监听"） */
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("readServerStatus", () => {
  it("没有发现文件 → running:false（原因写明是没发现文件）", async () => {
    expect(await readServerStatus({ aiZenDir: dir, clientInfo })).toEqual({
      running: false,
      reason: "no descriptor",
    });
  });

  it("服务端在跑 → running:true，带回它自报的 pid / 端口 / 协议号", async () => {
    daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test" });
    await daemon.start();

    const status = await readServerStatus({ aiZenDir: dir, clientInfo });
    expect(status.running).toBe(true);
    if (!status.running) return; // 类型收窄（失败时上面已断言）
    expect(status.port).toBe(daemon.port);
    expect(status.pid).toBe(process.pid);
    expect(status.protocol).toBe(3);
    // 这条连接自己也算在内：status 报告的是「此刻有几条连着的」
    expect(status.connections).toBe(1);
  });

  it("发现文件在但连不上 → running:false，带上那个 pid 与失败原因", async () => {
    await writeDescriptor(dir, {
      pid: process.pid,
      host: "127.0.0.1",
      port: await unusedPort(),
      protocol: 3,
      version: "0.0.0-test",
      startedAt: new Date().toISOString(),
      schema: 1,
    });

    const status = await readServerStatus({ aiZenDir: dir, clientInfo });
    expect(status.running).toBe(false);
    if (status.running) return;
    expect(status.pid).toBe(process.pid);
    expect(status.reason).toMatch(/ECONNREFUSED|connect/i);
  });

  it("给了显式地址：直接问那个地址，**不读**发现文件（远程场景从前永远回 no descriptor）", async () => {
    daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test" });
    await daemon.start();
    // 显式地址 + 本机凭证（`<aiZenDir>/run/token`，服务端 `start()` 时生成的）：地址与凭证两条
    // 优先级链都走了一遍
    const status = await readServerStatus({
      aiZenDir: dir,
      clientInfo,
      serverUrl: `ws://127.0.0.1:${daemon.port}`,
    });
    expect(status.running).toBe(true);
    if (!status.running) return;
    expect(status.port).toBe(daemon.port);
  });

  it("显式地址 + 显式凭证不对：reason 说的是去那台服务端核对凭证，而不是去重启它", async () => {
    daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test" });
    await daemon.start();

    const status = await readServerStatus({
      aiZenDir: dir,
      clientInfo,
      serverUrl: `ws://127.0.0.1:${daemon.port}`,
      serverToken: "not-the-token",
    });
    expect(status.running).toBe(false);
    if (status.running) return;
    expect(status.reason).toMatch(/unauthorized/);
    // 诊断命令不能只说「没发现」，也不能指错方向：凭证是用户显式给的，重启不解决任何事
    expect(status.reason).toMatch(/核对/);
    expect(status.reason).not.toMatch(/重启服务端/);
    // 且那句提示里的凭证路径是**真路径**：`aiZenDir` 这一层本来就有，没理由印占位符
    expect(status.reason).toContain(join(dir, "run", "token"));
    expect(status.reason).not.toContain("<aiZenDir>");
    // 凭证串本身绝不回显（这句话会进终端、进日志）
    expect(status.reason).not.toContain("not-the-token");
  });

  it("显式地址 + 本机**没有**凭证文件（远程服务端）：reason 让人去设 AI_ZEN_SERVER_TOKEN，而不是重启", async () => {
    // 真进程冒烟拓出来的那个 bug：用户给了一条远程地址，本地 aiZenDir 里根本没 token 文件。
    // 此时的建议只能是「去设 AI_ZEN_SERVER_TOKEN」——「重启服务端」既没说重启哪台，重启完也不会好
    daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test" });
    await daemon.start();

    // 另一个 aiZenDir = 「本机没有凭证文件」的那个世界
    const emptyDir = mkdtempSync(join(tmpdir(), "aiz-cli-status-empty-"));
    try {
      const status = await readServerStatus({
        aiZenDir: emptyDir,
        clientInfo,
        serverUrl: `ws://127.0.0.1:${daemon.port}`,
      });
      expect(status.running).toBe(false);
      if (status.running) return;
      expect(status.reason).toContain("AI_ZEN_SERVER_TOKEN");
      expect(status.reason).not.toMatch(/重启服务端/);
      // 地址与真路径都在：得知道去哪台机器上拄哪一份文件
      expect(status.reason).toContain(`ws://127.0.0.1:${daemon.port}`);
      expect(status.reason).toContain(join(emptyDir, "run", "token"));
      expect(status.reason).not.toContain("<aiZenDir>");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
