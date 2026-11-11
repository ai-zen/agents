import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "@ai-zen/agents-server";
import { encodeFrame } from "./wire/frames.js";
import { SocketServerClient } from "./socket-server-client.js";
import type { ClientInfo, ServerAddress } from "./types.js";

const client: ClientInfo = { name: "@ai-zen/cli", version: "0.0.0-test" };

let dir: string;
let daemon: Daemon | null = null;
let fakeServer: Server | null = null;
/** 假服务端接受的连接：收尾时得亲手掐掉，否则 `server.close()` 会等到超时 */
const fakeSockets = new Set<Socket>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-cli-server-client-"));
  daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test" });
});

afterEach(async () => {
  await daemon?.stop("test");
  daemon = null;
  for (const socket of fakeSockets) socket.destroy();
  fakeSockets.clear();
  if (fakeServer) {
    const server = fakeServer;
    fakeServer = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 真起一个服务端，返回它的地址 */
async function startServer(): Promise<ServerAddress> {
  await daemon!.start();
  return { host: "127.0.0.1", port: daemon!.port };
}

/** 起一个只会建连、一个字都不回的假服务端（用来测握手超时/被拒） */
async function startFakeServer(onConnection?: (socket: Socket) => void): Promise<ServerAddress> {
  fakeServer = createServer((socket) => {
    fakeSockets.add(socket);
    socket.on("close", () => fakeSockets.delete(socket));
    socket.setEncoding("utf-8");
    onConnection?.(socket);
  });
  await new Promise<void>((resolve) => fakeServer!.listen(0, "127.0.0.1", () => resolve()));
  const address = fakeServer.address() as { port: number };
  return { host: "127.0.0.1", port: address.port };
}

describe("SocketServerClient", () => {
  it("握手后可以直接调 ping / status（不用自己发 hello）", async () => {
    const connection = await SocketServerClient.connect({ address: await startServer(), client });
    try {
      expect(await connection.call("ping")).toEqual({ pong: true });

      const status = await connection.call<{ port: number; pid: number; protocol: number }>(
        "status",
      );
      expect(status.port).toBe(daemon!.port);
      expect(status.pid).toBe(process.pid);
      expect(status.protocol).toBe(1);

      // 握手回执里服务端自报的身份
      expect(connection.server?.name).toBe("@ai-zen/agents-server");
    } finally {
      connection.close();
    }
  });

  it("方法不存在 → 抛 unknown-method（错误码原样带出来）", async () => {
    const connection = await SocketServerClient.connect({ address: await startServer(), client });
    try {
      await expect(connection.call("nope")).rejects.toThrow(/unknown-method/);
    } finally {
      connection.close();
    }
  });

  it("服务端收摊后：调用立刻失败，不挂到超时", async () => {
    const connection = await SocketServerClient.connect({ address: await startServer(), client });
    await daemon!.stop("test");
    daemon = null;

    await expect(connection.call("ping", undefined, { timeoutMs: 1000 })).rejects.toThrow(
      /closed|connection closed/,
    );
    connection.close();
  });

  it("握手被拒（版本不符）→ connect 抛错并带上服务端的 code", async () => {
    const address = await startFakeServer((socket) => {
      socket.once("data", () => {
        socket.write(
          encodeFrame({
            kind: "hello",
            ok: false,
            error: { code: "version-mismatch", message: "server speaks protocol 2" },
          }),
        );
      });
    });

    await expect(SocketServerClient.connect({ address, client })).rejects.toThrow(
      /version-mismatch/,
    );
  });

  it("服务端不回 hello → connect 在 connectTimeoutMs 后超时失败", async () => {
    const address = await startFakeServer(); // 接受连接但永不回话
    await expect(
      SocketServerClient.connect({ address, client, connectTimeoutMs: 100 }),
    ).rejects.toThrow(/handshake timeout/);
  });

  it("连不上（没人监听）→ connect 抛错", async () => {
    const address = await startFakeServer();
    const deadPort = address.port;
    await new Promise<void>((resolve) => fakeServer!.close(() => resolve()));
    fakeServer = null;

    await expect(
      SocketServerClient.connect({ address: { host: "127.0.0.1", port: deadPort }, client }),
    ).rejects.toThrow(/ECONNREFUSED|connect/i);
  });
});
