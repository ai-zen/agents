/**
 * 守护进程集成测试 —— 真起一个监听端口，用真 WebSocket 走一遍握手与调用。
 *
 * 用 `WsTestClient`（`WsTestClientTestSupport.ts`）而不是自己搭一整套抽象：被测的是线上协议
 * 本身，换成假的传输就等于没测。
 *
 * 本文件盯的是**消息语义**（哪一类消息回哪个码、什么时候断连），传输抽象本身的可替换性在
 * `wire.test.ts`。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, type AnyHandler } from "./Daemon.js";
import { readDescriptor } from "../wire/discovery.js";
import { PROTOCOL_VERSION } from "../wire/messages.js";
import { MAX_TEXT_BYTES } from "../wire/frames.js";
import { WsTestClient } from "./WsTestClientTestSupport.js";

let dir: string;
let daemon: Daemon | null = null;
const clients: WsTestClient[] = [];

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

async function connect(port: number = daemon!.port): Promise<WsTestClient> {
  const client = await WsTestClient.connect(port);
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
  it("第一条请求不是 hello → handshake-required，且**不断连**（补上 hello 就能继续用）", async () => {
    await startDaemon();
    const client = await connect();

    const refused = await client.request("ping");
    expect(refused).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000, data: { code: "handshake-required" } },
    });
    // 回执挂在请求自己的 id 上（这条请求是能对上号的）
    expect(typeof refused.id).toBe("number");

    // 连接照旧：补上握手之后 ping 可用
    expect(await client.handshake()).toMatchObject({ result: { protocol: PROTOCOL_VERSION } });
    expect(await client.call("ping")).toEqual({ pong: true });
  });

  it("协议版本不符 → version-mismatch，且**断连**（断代，不做竭力兼容）", async () => {
    await startDaemon();
    const client = await connect();

    const refused = await client.handshake({ protocol: PROTOCOL_VERSION + 1 });
    expect(refused).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000, data: { code: "version-mismatch" } },
    });
    expect(await client.closed()).toBe(true);
  });

  it("握手成功回服务端身份（版本 / pid / startedAt）", async () => {
    const instance = await startDaemon();
    const client = await connect();
    const hello = await client.handshake();
    expect(hello.result).toMatchObject({
      name: "@ai-zen/agents-server",
      version: "0.1.0-test",
      protocol: PROTOCOL_VERSION,
      pid: process.pid,
    });
    expect(typeof hello.result.startedAt).toBe("string");
    expect(instance.connectionCount).toBe(1);
  });

  it("hello 的 params.protocol 缺失或不是数字 → bad-params（-32602），**不断连**（形状错不是版本错）", async () => {
    await startDaemon();
    const client = await connect();

    const wrongShapes = [
      {}, // 没有任何键
      { client: { name: "t", version: "0" } }, // 只有 client，没有 protocol
      { protocol: "2" }, // 是字符串，不是数字（"2" 看上去很像，但不是）
      { protocol: null },
    ];
    for (const params of wrongShapes) {
      client.send({ jsonrpc: "2.0", id: 12, method: "hello", params });
      expect(await client.nextMatching((frame) => frame.id === 12)).toMatchObject({
        jsonrpc: "2.0",
        // 形状错误和版本不匹配是两件事：混用会让人跑去改版本号（A31）
        error: { code: -32602, data: { code: "bad-params" } },
      });
    }
    // 一条都没把连接断掉：补上一次正确的握手就继续用
    expect(await client.handshake()).toMatchObject({ result: { protocol: PROTOCOL_VERSION } });
    expect(await client.call("ping")).toEqual({ pong: true });
  });

  it("握手完成后再发 hello → invalid-request，且**不断连**", async () => {
    await startDaemon();
    const client = await connect();
    await client.handshake();

    const again = await client.handshake();
    expect(again).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32600, data: { code: "invalid-request" } },
    });
    // 连接照旧
    expect(await client.call("ping")).toEqual({ pong: true });
  });

  it("hello 的 params 不是对象 → bad-params（-32602），**不断连**（与 params 只接受对象形式同一把尺子）", async () => {
    await startDaemon();
    const client = await connect();

    for (const params of ["2", [2], null, 2]) {
      client.send({ jsonrpc: "2.0", id: 11, method: "hello", params });
      expect(await client.nextMatching((frame) => frame.id === 11)).toMatchObject({
        jsonrpc: "2.0",
        // 报成 `version-mismatch` 会误导用户以为版本不对，而他该改的是请求体
        error: { code: -32602, data: { code: "bad-params" } },
      });
    }
    // 断代只在「版本真的不同」时发生：这条连接还能补上一次正确的握手
    expect(await client.handshake()).toMatchObject({ result: { protocol: PROTOCOL_VERSION } });
    expect(await client.call("ping")).toEqual({ pong: true });
  });
});

describe("消息分类（A22：六条断连之外一律回错误、不断连）", () => {
  it("非法 JSON → bad-frame（-32700），连接不断", async () => {
    await startDaemon();
    const client = await connect();
    await client.handshake();

    client.sendRaw("this is not json");
    const refused = await client.next();
    expect(refused).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, data: { code: "bad-frame" } },
    });
    // 这是本批的原则性修正：上一版在这里断连
    expect(await client.call("ping")).toEqual({ pong: true });
  });

  it("顶层数组（批量）→ invalid-request（-32600，id 为 null），连接不断", async () => {
    await startDaemon();
    const client = await connect();
    await client.handshake();

    client.send([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(await client.next()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, data: { code: "invalid-request" } },
    });
    expect(await client.call("ping")).toEqual({ pong: true });
  });

  it("缺 method（有 id / 有 result）→ invalid-request，id 为 null（归不到任何请求）", async () => {
    await startDaemon();
    const client = await connect();
    await client.handshake();

    // 服务端不会收到响应：收到就是违规。它带着 id，但那个 id 属于对端的记账，回不了它
    client.send({ jsonrpc: "2.0", id: 7, result: null });
    expect(await client.next()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, data: { code: "invalid-request" } },
    });
    expect(await client.call("ping")).toEqual({ pong: true });
  });

  it("外壳不合法（缺 jsonrpc 字面量 / id 不合规）→ invalid-request，连接不断", async () => {
    await startDaemon();
    const client = await connect();
    await client.handshake();

    for (const frame of [
      { id: 1, method: "ping" }, // 缺 `jsonrpc: "2.0"`
      { jsonrpc: "2.0", id: "1", method: "ping" }, // id 是字符串（本版只允许整数）
      { jsonrpc: "2.0", id: -1, method: "ping" }, // 负数
      { jsonrpc: "2.0", id: 2 ** 32, method: "ping" }, // 超过 2³²-1
    ]) {
      client.send(frame);
      expect(await client.next()).toMatchObject({
        error: { code: -32600, data: { code: "invalid-request" } },
      });
    }
    expect(await client.call("ping")).toEqual({ pong: true });
  });

  it("通知（有 method、没有 id）→ **静默丢弃**（JSON-RPC：服务端 MUST NOT reply to a Notification）", async () => {
    await startDaemon();
    const client = await connect();
    await client.handshake();

    client.send({ jsonrpc: "2.0", method: "ping" });
    // 一条回帧都不该有：通知不需要回执，回错是违反标准（也把「只管发」的用法变成噪声）
    await client.settle();
    expect(client.pending()).toBe(0);
    // 连接照旧可用
    expect(await client.call("ping")).toEqual({ pong: true });
  });
  it("文本超过实现层的 8 MiB 上限 → 断连且不回错误响应（二进制才可以用满 WS 的 64 MiB）", async () => {
    await startDaemon();
    const client = await connect();
    await client.handshake();

    // 8 MiB + 1 的文本：WS 的 maxPayload（64 MiB）放行，实现层这一档拦下
    client.sendRaw("x".repeat(MAX_TEXT_BYTES + 1));
    expect(await client.closed()).toBe(true);
    // 超限不属于「这条消息不合法」，所以没有错误响应可等
    expect(client.pending()).toBe(0);
  });
});

describe("方法调用", () => {
  it("ping / status 可用，status 报出端口与连接数", async () => {
    const instance = await startDaemon();
    const client = await connect();
    await client.handshake();

    expect(await client.call("ping")).toEqual({ pong: true });

    const status = await client.call("status");
    expect(status.port).toBe(instance.port);
    expect(status.connections).toBe(1);
    expect(status.protocol).toBe(PROTOCOL_VERSION);
  });

  it("未知方法 → unknown-method（-32601，不是静默超时）", async () => {
    await startDaemon();
    const client = await connect();
    await client.handshake();
    expect(await client.request("nope")).toMatchObject({
      error: { code: -32601, data: { code: "unknown-method" } },
    });
  });

  it("业务方法由调用方注入：抛错变成错误响应，不影响连接", async () => {
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

    expect(await client.request("boom")).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32602, message: "业务炸了", data: { code: "bad-params" } },
    });

    // 上一条失败不影响这条
    expect(await client.call("echo", { x: 1 })).toEqual({ x: 1 });
  });

  it("handler 抛了一个不带码的错误 → internal（-32603，不冒充参数错）", async () => {
    await startDaemon({
      handlers: {
        boom: () => {
          throw new Error("没写码");
        },
      },
    });
    const client = await connect();
    await client.handshake();
    expect(await client.request("boom")).toMatchObject({
      error: { code: -32603, data: { code: "internal" }, message: "没写码" },
    });
  });

  it("并发请求按 id 各自回包（不是一个全局队列）", async () => {
    await startDaemon({ handlers: { echo: (p) => p } });
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

describe("二进制载荷（A4 / A15 / A21）", () => {
  /** 假 handler：只记下拿到的载荷（真件在 `contentHandlers.test.ts` 里测） */
  const uploadHandlers = (seen: Buffer[]): Record<string, AnyHandler> => ({
    "content.upload": (_params, _connection, payload) => {
      seen.push(payload!);
      return { got: payload?.byteLength ?? -1 };
    },
  });

  it("文本请求 + 二进制消息靠 4 字节 id 配对：载荷原样交给 handler", async () => {
    const seen: Buffer[] = [];
    await startDaemon({ handlers: uploadHandlers(seen) });
    const client = await connect();
    await client.handshake();

    const bytes = Buffer.from([0x89, 0x50, 0x0a, 0x00]); // 中间就有一个 0x0A
    const id = 42;
    client.send({ jsonrpc: "2.0", id, method: "content.upload", params: { mime: "image/png" } });
    client.sendBinary(id, bytes);

    expect(await client.nextMatching((frame) => frame.id === id)).toMatchObject({
      jsonrpc: "2.0",
      result: { got: 4 },
    });
    expect(seen[0]).toEqual(bytes);
  });

  it("二进制帧先到（没有在飞请求的 id）→ 断连（WS 保序，只可能是实现错误）", async () => {
    const seen: Buffer[] = [];
    await startDaemon({ handlers: uploadHandlers(seen) });
    const client = await connect();
    await client.handshake();

    client.sendBinary(999, Buffer.from("AB"));
    expect(await client.closed()).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("同一个 id 收到第二块二进制 → 断连", async () => {
    const seen: Buffer[] = [];
    await startDaemon({ handlers: uploadHandlers(seen) });
    const client = await connect();
    await client.handshake();

    client.send({ jsonrpc: "2.0", id: 7, method: "content.upload", params: { mime: "image/png" } });
    client.sendBinary(7, Buffer.from("AB"));
    expect(await client.nextMatching((frame) => frame.id === 7)).toMatchObject({
      result: { got: 2 },
    });

    client.sendBinary(7, Buffer.from("CD"));
    expect(await client.closed()).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("连 4 字节 id 都读不出来 → 断连（无从回复，只可能是实现错误）", async () => {
    await startDaemon({ handlers: uploadHandlers([]) });
    const client = await connect();
    await client.handshake();

    client.sendRawBinary(Buffer.from([0x00, 0x01]));
    expect(await client.closed()).toBe(true);
  });

  it("空载荷（正好 4 字节）→ 不断连，0 字节照样交给 handler", async () => {
    const seen: Buffer[] = [];
    await startDaemon({ handlers: uploadHandlers(seen) });
    const client = await connect();
    await client.handshake();

    client.send({ jsonrpc: "2.0", id: 5, method: "content.upload", params: { mime: "image/png" } });
    client.sendBinary(5, Buffer.alloc(0));

    expect(await client.nextMatching((frame) => frame.id === 5)).toMatchObject({
      result: { got: 0 },
    });
    expect(seen[0]?.byteLength).toBe(0);
    // 连接照旧
    expect(await client.call("ping")).toEqual({ pong: true });
  });

  it("带字节的方法在收到二进制帧之前不派发", async () => {
    const seen: Buffer[] = [];
    await startDaemon({ handlers: uploadHandlers(seen) });
    const client = await connect();
    await client.handshake();

    client.send({ jsonrpc: "2.0", id: 8, method: "content.upload", params: { mime: "image/png" } });
    await client.settle();
    expect(seen).toHaveLength(0);

    client.sendBinary(8, Buffer.from("XYZ"));
    expect(await client.nextMatching((frame) => frame.id === 8)).toMatchObject({
      result: { got: 3 },
    });
    expect(seen[0]).toEqual(Buffer.from("XYZ"));
  });
});
