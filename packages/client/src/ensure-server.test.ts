import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "@ai-zen/agents-server";
import { writeDescriptor } from "./wire/discovery.js";
import { ensureServer } from "./ensure-server.js";
import type { ClientInfo } from "./types.js";

const clientInfo: ClientInfo = { name: "@ai-zen/cli", version: "0.0.0-test" };
/** 不可能存在的 pid：证明"发现文件还在、进程已经没了"这条路径 */
const DEAD_PID = 2 ** 22 + 12345;

let dir: string;
let daemon: Daemon | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-cli-ensure-"));
});

afterEach(async () => {
  await daemon?.stop("test");
  daemon = null;
  rmSync(dir, { recursive: true, force: true });
});

/** 写一份"上一个进程留下的"发现文件 */
async function writeStaleDescriptor(): Promise<void> {
  await writeDescriptor(dir, {
    pid: DEAD_PID,
    host: "127.0.0.1",
    port: 1,
    protocol: 1,
    version: "0.0.0",
    startedAt: new Date(0).toISOString(),
    schema: 1,
  });
}

describe("ensureServer", () => {
  it("已有活着的服务端：直接连上，不拉起新进程", async () => {
    daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test" });
    await daemon.start();

    let spawnCount = 0;
    const result = await ensureServer({
      aiZenDir: dir,
      clientInfo,
      startServerProcess: async () => {
        spawnCount++;
      },
    });

    try {
      expect(spawnCount).toBe(0);
      expect(result.started).toBe(false);
      expect(result.address.port).toBe(daemon.port);
      expect(await result.client.call("ping")).toEqual({ pong: true });
    } finally {
      result.client.close();
    }
  });

  it("发现文件是残留（pid 已死）：拉起新进程，连上**新的那个**", async () => {
    await writeStaleDescriptor();

    let spawnCount = 0;
    const result = await ensureServer({
      aiZenDir: dir,
      clientInfo,
      // 注入"拉起"：进程内起一个真 Daemon，模拟 detached 子进程最终把发现文件覆盖掉
      startServerProcess: async () => {
        spawnCount++;
        daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test" });
        await daemon.start();
      },
    });

    try {
      expect(spawnCount).toBe(1);
      expect(result.started).toBe(true);
      expect(result.address.port).toBe(daemon!.port);
      expect(await result.client.call("ping")).toEqual({ pong: true });
    } finally {
      result.client.close();
    }
  });

  it("拉起后迟迟起不来：超时报错，并指出日志路径（不无限等）", async () => {
    let waits = 0;
    await expect(
      ensureServer({
        aiZenDir: dir,
        clientInfo,
        startServerProcess: async () => {
          /* 什么都没起 */
        },
        waitBeforeRetry: async () => {
          waits++;
        },
        timeoutMs: 30,
        retryIntervalMs: 10,
      }),
    ).rejects.toThrow(/logs[/\\]server\.log/);

    expect(waits).toBeGreaterThan(0);
  });

  it("拉起进程本身失败（如找不到可执行文件）：错误直接冒出来，不走超时", async () => {
    await expect(
      ensureServer({
        aiZenDir: dir,
        clientInfo,
        startServerProcess: async () => {
          throw new Error("spawn ENOENT");
        },
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/spawn ENOENT/);
  });
});
