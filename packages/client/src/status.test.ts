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
    expect(status.protocol).toBe(2);
    // 这条连接自己也算在内：status 报告的是「此刻有几条连着的」
    expect(status.connections).toBe(1);
  });

  it("发现文件在但连不上 → running:false，带上那个 pid 与失败原因", async () => {
    await writeDescriptor(dir, {
      pid: process.pid,
      host: "127.0.0.1",
      port: await unusedPort(),
      protocol: 2,
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
});
