/**
 * 守护进程集成测试 —— 真起一个监听 socket，用真连接走一遍握手与调用。
 *
 * 用一个很小的 `TestClient` 而不是自己搭一整套抽象：被测的是线上协议本身，
 * 换成假的传输就等于没测。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "./Daemon.js";
import { readDescriptor } from "../wire/discovery.js";
import { encodeFrame, FrameDecoder } from "../wire/frames.js";
import { PROTOCOL_VERSION } from "../wire/messages.js";

let dir: string;
let daemon: Daemon | null = null;
const clients: TestClient[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-server-daemon-"));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function startDaemon(
  options: Partial<ConstructorParameters<typeof Daemon>[0]> = {},
): Promise<Daemon> {
  const instance = new Daemon({
    aiZenDir: dir,
    port: 0, // 系统分配
    version: "0.1.0-test",
    ...options,
  });
  await instance.start();
  daemon = instance;
  return instance;
}

async function connect(port: number = daemon!.port): Promise<TestClient> {
  const client = await TestClient.connect(port);
  clients.push(client);
  return client;
}

describe("Daemon 启动与发现", () => {
  it("端口传 0 时用系统分配的端口，并写进发现文件", async () => {
    const instance = await startDaemon();
    expect(instance.port).toBeGreaterThan(0);
    const descriptor = await readDescriptor(dir);
    expect(descriptor).toMatchObject({
      pid: process.pid,
      port: instance.port,
      protocol: PROTOCOL_VERSION,
      version: "0.1.0-test",
      schema: 1,
    });
  });

  it("停止后删掉发现文件：留着它，客户端会连到一个没人监听的端口", async () => {
    const instance = await startDaemon();
    await instance.stop("test");
    daemon = null;
    expect(await readDescriptor(dir)).toBeNull();
  });

  it("拒绝监听非 loopback（本版没有鉴权，这是硬边界）", async () => {
    const instance = new Daemon({ aiZenDir: dir, host: "0.0.0.0", port: 0, version: "t" });
    await expect(instance.start()).rejects.toThrow(/loopback/);
  });

  it("请求的端口被占 → 退回系统分配（多个 AI_ZEN_DIR 同时跑得起）", async () => {
    const first = await startDaemon();
    const other = mkdtempSync(join(tmpdir(), "aiz-daemon-port-"));
    const second = new Daemon({ aiZenDir: other, port: first.port, version: "0.1.0-test" });
    try {
      await second.start();
      // 8790 拿不到不是错误：客户端的端口永远从自己那个发现文件读
      expect(second.port).not.toBe(first.port);
      expect((await readDescriptor(other))?.port).toBe(second.port);
    } finally {
      await second.stop("test");
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("握手", () => {
  it("首帧必须是 hello：先发请求会被拒绝并断开", async () => {
    await startDaemon();
    const client = await connect();
    client.send({ id: 1, method: "ping" });
    const frame: any = await client.next();
    expect(frame).toMatchObject({ kind: "hello", ok: false });
    expect(frame.error.code).toBe("bad-handshake");
    expect(await client.closed()).toBe(true);
  });

  it("协议版本不符 → version-mismatch（不做竭力兼容）", async () => {
    await startDaemon();
    const client = await connect();
    client.send({
      kind: "hello",
      protocol: PROTOCOL_VERSION + 1,
      client: { name: "t", version: "t" },
    });
    const frame: any = await client.next();
    expect(frame.ok).toBe(false);
    expect(frame.error.code).toBe("version-mismatch");
    expect(await client.closed()).toBe(true);
  });

  it("握手成功回服务端身份（版本 / pid / startedAt）", async () => {
    const instance = await startDaemon();
    const client = await connect();
    const hello = await client.handshake();
    expect(hello).toMatchObject({
      ok: true,
      server: { version: "0.1.0-test", protocol: PROTOCOL_VERSION, pid: process.pid },
    });
    expect(instance.connectionCount).toBe(1);
  });

  it("非法 JSON 帧 → bad-frame，连接断开", async () => {
    await startDaemon();
    const client = await connect();
    client.raw("this is not json\n");
    const frame: any = await client.next();
    expect(frame.error.code).toBe("bad-frame");
    expect(await client.closed()).toBe(true);
  });
});

describe("方法调用", () => {
  it("ping / status 可用，status 报出端口与连接数", async () => {
    const instance = await startDaemon();
    const client = await connect();
    await client.handshake();

    expect(await client.call("ping")).toEqual({ pong: true });

    const status: any = await client.call("status");
    expect(status.port).toBe(instance.port);
    expect(status.connections).toBe(1);
    expect(status.protocol).toBe(PROTOCOL_VERSION);
  });

  it("未知方法 → unknown-method（不是静默超时）", async () => {
    await startDaemon();
    const client = await connect();
    await client.handshake();
    const response: any = await client.rawCall("nope");
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("unknown-method");
  });

  it("业务方法由调用方注入：抛错变成 ok:false，不影响连接", async () => {
    await startDaemon({
      handlers: {
        boom: () => {
          const error: any = new Error("业务炸了");
          error.code = "bad-params";
          throw error;
        },
        echo: (params) => params,
      },
    });
    const client = await connect();
    await client.handshake();

    const bad: any = await client.rawCall("boom");
    expect(bad).toMatchObject({ ok: false, error: { code: "bad-params", message: "业务炸了" } });

    // 上一条失败不影响这条
    expect(await client.call("echo", { x: 1 })).toEqual({ x: 1 });
  });

  it("并发请求按 id 各自回包（不是一个全局队列）", async () => {
    await startDaemon({ handlers: { echo: (p: any) => p } });
    const client = await connect();
    await client.handshake();

    const [a, b, c] = await Promise.all([
      client.call("echo", "a"),
      client.call("echo", "b"),
      client.call("echo", "c"),
    ]);
    expect([a, b, c]).toEqual(["a", "b", "c"]);
  });

  it("shutdown 先回包再收摊", async () => {
    const instance = await startDaemon();
    const client = await connect();
    await client.handshake();

    expect(await client.call("shutdown")).toEqual({ stopping: true });
    await instance.stop("already stopping"); // 幂等：不会重复收摊
    expect(await readDescriptor(dir)).toBeNull();
  });
});

// ==================================================================
// 测试客户端：真 socket + 真帧
// ==================================================================

class TestClient {
  private constructor(
    private readonly socket: Socket,
    private readonly decoder: FrameDecoder,
  ) {}

  static async connect(port: number): Promise<TestClient> {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setEncoding("utf-8");
    const decoder = new FrameDecoder();
    const client = new TestClient(socket, decoder);
    socket.on("data", (chunk: string) => {
      for (const frame of decoder.push(chunk)) client.inbox.push(frame);
      client.wake();
    });
    socket.on("close", () => {
      client.isClosed = true;
      client.wake();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    return client;
  }

  private inbox: unknown[] = [];
  private waiters: Array<() => void> = [];
  private isClosed = false;
  private nextId = 1;

  send(frame: unknown): void {
    this.socket.write(encodeFrame(frame));
  }

  raw(text: string): void {
    this.socket.write(text);
  }

  async next(): Promise<unknown> {
    while (this.inbox.length === 0) {
      if (this.isClosed) throw new Error("connection closed while waiting for a frame");
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.inbox.shift();
  }

  async closed(): Promise<boolean> {
    // 等服务端 destroy 落地（事件循环两三个 tick 足够）
    for (let i = 0; i < 20 && !this.isClosed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.isClosed;
  }

  async handshake(): Promise<any> {
    this.send({
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      client: { name: "test", version: "0" },
    });
    return await this.next();
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const response: any = await this.rawCall(method, params);
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result;
  }

  /** 不抛错，拿原始响应（想看错误码时用） */
  async rawCall(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({ id, method, params });
    for (;;) {
      const frame = await this.next();
      const value = frame as any;
      if (value?.id === id) return value;
    }
  }

  close(): void {
    this.socket.destroy();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}
