import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
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
    protocol: 3,
    version: "0.0.0",
    startedAt: new Date(0).toISOString(),
    schema: 1,
  });
}

/** 找一个刚空出来的端口（用它来构造「显式地址上没人」） */
async function unusedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
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

  it("显式地址：直接连那一个（发现文件不看、也不拉起）", async () => {
    daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test" });
    await daemon.start();

    let spawnCount = 0;
    const result = await ensureServer({
      aiZenDir: dir,
      clientInfo,
      serverUrl: `ws://127.0.0.1:${daemon.port}`,
      startServerProcess: async () => {
        spawnCount++;
      },
    });

    try {
      expect(spawnCount).toBe(0);
      expect(result.started).toBe(false);
      expect(result.explicit).toBe(true);
      expect(await result.client.call("ping")).toEqual({ pong: true });
    } finally {
      result.client.close();
    }
  });

  it("显式地址连不上：抛错（带地址），且 startServerProcess **一次都没被调用**（D10）", async () => {
    // D10 的唯一证据：本地 `npx` 起的进程一定不在那个地址上，拉起只会白等满 10 秒，
    // 然后报一个指向错误方向的超时 —— 所以「没调用」本身就是那个决定
    const port = await unusedPort();
    let spawnCount = 0;

    await expect(
      ensureServer({
        aiZenDir: dir,
        clientInfo,
        serverUrl: `ws://127.0.0.1:${port}`,
        startServerProcess: async () => {
          spawnCount++;
        },
      }),
    ).rejects.toThrow(/127\.0\.0\.1/);

    expect(spawnCount).toBe(0);
  });

  it("显式地址 + 本地文件那串凭证不对：错误里让人去设 AI_ZEN_SERVER_TOKEN（D9 的第一句）", async () => {
    daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test" });
    await daemon.start();
    // 服务端手上那把锁是启动时读进内存的那一串；把文件改掉 = 「这个地址上可能是另一份凭证」
    writeFileSync(join(dir, "run", "token"), "another-deployment-token", "utf-8");

    let spawnCount = 0;
    const error = await ensureServer({
      aiZenDir: dir,
      clientInfo,
      serverUrl: `ws://127.0.0.1:${daemon.port}`,
      startServerProcess: async () => {
        spawnCount++;
      },
    }).then(
      () => null,
      (failure: unknown) => failure as Error & { code?: unknown },
    );

    expect(spawnCount).toBe(0);
    expect(error?.message).toContain("AI_ZEN_SERVER_TOKEN");
    // 码也带出来了：宿主靠它决定「改凭证」还是「改地址」
    expect(error?.code).toBe("unauthorized");
    // 凭证串本身绝不回显（这句话会进终端、进日志）
    expect(error?.message).not.toContain("another-deployment-token");
  });

  it("显式地址 + 本机**没有**凭证文件：错误里唯一的方向是去设 AI_ZEN_SERVER_TOKEN（本批 bug 的回归锁）", async () => {
    // 真进程冒烟拓出来的那个 bug：给了远程地址，本地 aiZenDir 里根本没有 token 文件，而得到的
    // 建议是「重启服务端」—— 重启哪台、重启完也不会好。判据必须是凭证的**来源三态**：
    // 「没有凭证」与「显式凭证」都是 `fromLocalFile: false`，靠布尔分不开
    daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test" });
    await daemon.start();

    // 另一个 aiZenDir = 「本机没有任何凭证」的那个世界
    const emptyDir = mkdtempSync(join(tmpdir(), "aiz-cli-ensure-empty-"));
    try {
      const error = await ensureServer({
        aiZenDir: emptyDir,
        clientInfo,
        serverUrl: `ws://127.0.0.1:${daemon.port}`,
        startServerProcess: async () => {
          /* D10：显式地址时绝不拉起 */
        },
      }).then(
        () => null,
        (failure: unknown) => failure as Error & { code?: unknown },
      );

      expect(error?.message).toContain("AI_ZEN_SERVER_TOKEN");
      expect(error?.code).toBe("unauthorized");
      // 地址与**真路径**都在：得知道去哪台机器上拄哪一份文件
      expect(error?.message).toContain(`127.0.0.1:${daemon.port}`);
      expect(error?.message).toContain(join(emptyDir, "run", "token"));
      expect(error?.message).not.toContain("<aiZenDir>");
      // 本机连一份凭证都没有：没有本机服务端可重启，也不存在「重启就好」这一说
      expect(error?.message).not.toMatch(/重启服务端/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("显式地址 + 本地凭证不对：提示里的凭证路径是**真路径**（`AI_ZEN_DIR` 可能被自定义过）", async () => {
    daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test" });
    await daemon.start();
    writeFileSync(join(dir, "run", "token"), "another-deployment-token", "utf-8");

    const error = await ensureServer({
      aiZenDir: dir,
      clientInfo,
      serverUrl: `ws://127.0.0.1:${daemon.port}`,
      startServerProcess: async () => {
        /* D10：显式地址时绝不拉起 */
      },
    }).then(
      () => null,
      (failure: unknown) => failure as Error,
    );

    // 这个调用点拿得到 `aiZenDir`，所以提示里必须印它算出来的那一份 ——
    // 印占位符等于让用户自己去猜这个进程眼里的目录解析成了什么
    expect(error?.message).toContain(join(dir, "run", "token"));
    expect(error?.message).not.toContain("<aiZenDir>");
  });
});
