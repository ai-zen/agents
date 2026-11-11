/**
 * `SocketServerClient` 的用例：**真 Daemon**（真 WebSocket + 真 JSON-RPC）与一个手写的假服务端。
 *
 * ## 为什么有一个手写的「假服务端」
 *
 * 有几条边界真 Daemon 给不出来：握手被拒（它这一版不拒任何合法客户端）、服务端一个字都不回、
 * 以及「这一次调用在**线上**到底是什么形状」。而这些正是本类最该钉住的地方。
 *
 * 本包没有 `ws` 依赖（那是服务端的事，客户端只用全局 `WebSocket`），所以假服务端自己写了一段
 * 最小的帧编解码：升级握手（`Sec-WebSocket-Accept`）+ 收发文本 / 二进制帧。**只写用到的那一
 * 部分**：不处理分片、不协商扩展、收到关闭帧就 `end()`。它同时是「客户端发出去的东西长什么样」
 * 的唯一观察点 —— 二进制那条用例靠它数消息条数与字节。
 *
 * ## 二进制为什么要数「两条消息」
 *
 * 载荷不再跟在文本后面（JSON-lines 时代），而是**另一条 WS 消息**，前 4 字节是请求 `id`。
 * 「一条还是两条」在实现上只差一行，而在线上是两套形状：数出来才算真的按 A4 发了。载荷里故意
 * 放 `0x0a`：任何「按行切」的实现都会在它那里把载荷切断。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "@ai-zen/agents-server";
import { encodeFrame } from "./wire/frames.js";
import { SocketServerClient } from "./socket-server-client.js";
import type { ClientInfo, ServerAddress } from "./types.js";

const client: ClientInfo = { name: "@ai-zen/cli", version: "0.0.0-test" };

let dir: string;
let daemon: Daemon | null = null;
const fakeServers: FakeWsServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-cli-server-client-"));
  daemon = new Daemon({ aiZenDir: dir, port: 0, version: "0.0.0-test" });
});

afterEach(async () => {
  await daemon?.stop("test");
  daemon = null;
  for (const fake of fakeServers.splice(0)) await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 真起一个服务端，返回它的地址 */
async function startServer(): Promise<ServerAddress> {
  await daemon!.start();
  return { host: "127.0.0.1", port: daemon!.port };
}

/** 找一个刚空出来的端口（用它来构造「没人监听」） */
async function unusedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
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
      // E1：本版协议号是 2（发现文件、`status`、`hello` 三处报的都是它）
      expect(status.protocol).toBe(2);

      // 握手回执里服务端自报的身份（扁平的那一份，没有 `server` 那一层）
      expect(connection.server?.name).toBe("@ai-zen/agents-server");
      expect(connection.server?.protocol).toBe(2);
    } finally {
      connection.close();
    }
  });

  it("方法不存在 → 抛 unknown-method（字符串码原样带出来）", async () => {
    const connection = await SocketServerClient.connect({ address: await startServer(), client });
    try {
      await expect(connection.call("nope")).rejects.toThrow(/unknown-method/);
    } finally {
      connection.close();
    }
  });

  it("服务端回的业务失败：`err.code` 是字符串（`error.data.code`），不是数字码", async () => {
    // 真 Daemon + 一个只会抛业务码的 handler：走的是「handler 抛 → 线上错误响应 → 客户端解」全程
    const instance = new Daemon({
      aiZenDir: dir,
      port: 0,
      version: "0.0.0-test",
      handlers: {
        "session.send": () => {
          throw Object.assign(new Error("a turn is already running"), { code: "turn-busy" });
        },
      },
    });
    await instance.start();
    const connection = await SocketServerClient.connect({
      address: { host: "127.0.0.1", port: instance.port },
      client,
    });

    try {
      const error = await connection.call("session.send", {}).then(
        () => null,
        (failure: unknown) => failure as Error & { code?: unknown },
      );
      expect(error).toBeInstanceOf(Error);
      // 字符串码：`turn-busy`，不是 `-32000`（数字码只回答「该不该改请求」，业务语义在这里）
      expect(error!.code).toBe("turn-busy");
      expect(typeof error!.code).toBe("string");
      expect(error!.message).toMatch(/turn-busy/);
      // 连接没被一条失败响应弄坏
      expect(await connection.call("ping")).toEqual({ pong: true });
    } finally {
      connection.close();
      await instance.stop("test");
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
    const fake = await startFakeWsServer((message, reply) => {
      // 收到了 `hello`：回一条失败响应（`id` 挂回它自己），然后断开
      const request = JSON.parse(message.data.toString()) as { id: number };
      reply(
        encodeFrame({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: "client speaks protocol 1, this server speaks 2",
            data: { code: "version-mismatch" },
          },
        }),
      );
    });
    fakeServers.push(fake);

    const error = await SocketServerClient.connect({ address: fake.address, client }).then(
      () => null,
      (failure: unknown) => failure as Error & { code?: unknown },
    );
    expect(error?.message).toMatch(/version-mismatch/);
    expect(error?.code).toBe("version-mismatch");
    // 握手请求本身也长对了：一条普通方法，id 是 1，参数里有协议号与客户端身份
    const hello = JSON.parse(fake.messages[0].data.toString());
    expect(hello).toMatchObject({ jsonrpc: "2.0", id: 1, method: "hello" });
    expect(hello.params).toMatchObject({ protocol: 2, client });
  });

  it("服务端不回 hello → connect 在 connectTimeoutMs 后超时失败", async () => {
    const fake = await startFakeWsServer(); // 接受升级、永不回话
    fakeServers.push(fake);

    await expect(
      SocketServerClient.connect({ address: fake.address, client, connectTimeoutMs: 100 }),
    ).rejects.toThrow(/handshake timeout/);
  });

  it("连不上（没人监听）→ connect 抛错", async () => {
    const address = { host: "127.0.0.1", port: await unusedPort() };

    await expect(SocketServerClient.connect({ address, client })).rejects.toThrow(
      /ECONNREFUSED|connect/i,
    );
  });

  it("带字节的调用发的是**两条** WS 消息：文本请求 + 二进制（前 4 字节是请求 id，0x0A 不被吃掉）", async () => {
    const fake = await startFakeWsServer((message, reply) => {
      const request = JSON.parse(message.data.toString()) as { id: number; method: string };
      if (request.method === "hello") {
        reply(
          encodeFrame({
            jsonrpc: "2.0",
            id: request.id,
            result: { name: "fake", version: "0", protocol: 2, pid: 1, startedAt: "now" },
          }),
        );
        return;
      }
      reply(encodeFrame({ jsonrpc: "2.0", id: request.id, result: { section: { type: "text" } } }));
    });
    fakeServers.push(fake);

    const connection = await SocketServerClient.connect({ address: fake.address, client });
    const bytes = Buffer.from([0x00, 0x0a, 0xff, 0x0a]);
    try {
      const result = await connection.call(
        "content.upload",
        { sessionId: "s1", mime: "image/png", filename: "a.png" },
        { bytes },
      );
      expect(result).toEqual({ section: { type: "text" } });

      // 握手（1） + 请求（1） + 载荷（1）= 三条；载荷没有被并进文本消息
      await waitForMessages(fake, 3);
      expect(fake.messages).toHaveLength(3);

      const request = JSON.parse(fake.messages[1].data.toString());
      expect(fake.messages[1].opcode).toBe(0x1); // 文本
      expect(request).toEqual({
        jsonrpc: "2.0",
        id: request.id,
        method: "content.upload",
        // A24：`params` 里没有「字节数」—— 载荷长度就是二进制消息剩下的长度
        params: { sessionId: "s1", mime: "image/png", filename: "a.png" },
      });

      const payload = fake.messages[2];
      expect(payload.opcode).toBe(0x2); // 二进制
      // 前 4 字节是这条请求 id 的**大端无符号**写法
      expect(payload.data.readUInt32BE(0)).toBe(request.id);
      // 其余是载荷原样：0x0a 一个都不少（按行切的实现会在这里断掉）
      expect(payload.data.subarray(4)).toEqual(bytes);
    } finally {
      connection.close();
    }
  });

  it("带字节的调用打到真 Daemon：载荷原样收到，连接还能继续用", async () => {
    // 服务端这一侧用真 Daemon（真解析 + 真二进制配对）+ 一个只记字节的 handler
    const seen: Buffer[] = [];
    const instance = new Daemon({
      aiZenDir: dir,
      port: 0,
      version: "0.0.0-test",
      handlers: {
        "content.upload": (_params, _connection, payload) => {
          seen.push(payload!);
          return { got: payload?.byteLength ?? -1 };
        },
      },
    });
    await instance.start();
    const bytes = Buffer.from([0x00, 0x0a, 0xff, 0x0a]);
    const connection = await SocketServerClient.connect({
      address: { host: "127.0.0.1", port: instance.port },
      client,
    });

    try {
      const result = await connection.call<{ got: number }>(
        "content.upload",
        { sessionId: "s1", mime: "image/png", filename: "a.png" },
        { bytes },
      );
      expect(result).toEqual({ got: 4 });
      expect(seen[0]).toEqual(bytes);
      // 这条连接还能继续用（载荷没有把后面的消息吃掉）
      expect(await connection.call("ping")).toEqual({ pong: true });
    } finally {
      connection.close();
      await instance.stop("test");
    }
  });
});

// ==================================================================
// 手写的最小假服务端（本包没有 `ws` 依赖，见文件头）
// ==================================================================

/** WebSocket 升级握手的固定 GUID（RFC 6455） */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 假服务端收到的一条消息：`0x1` 文本 / `0x2` 二进制 / `0x8` 关闭 */
interface FakeMessage {
  opcode: number;
  data: Buffer;
}

interface FakeWsServer {
  address: ServerAddress;
  /** 按到达顺序记下的**全部**入站消息（含 `hello`） */
  messages: FakeMessage[];
  close(): Promise<void>;
}

/** 起一个只会说 WebSocket 的假服务端；`onText` 在收到每条文本消息时被调（可用 `reply` 回一条） */
async function startFakeWsServer(
  onText: (message: FakeMessage, reply: (text: string) => void) => void = () => {},
): Promise<FakeWsServer> {
  const messages: FakeMessage[] = [];
  const sockets = new Set<Socket>();

  const server: HttpServer = createHttpServer((_request, response) => {
    // 普通 HTTP 请求在这条端口上没有意义（与真 Daemon 同一个答复）
    response.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
    response.end("this endpoint speaks WebSocket only\n");
  });

  server.on("upgrade", (request, socket: Socket) => {
    const key = request.headers["sec-websocket-key"];
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(String(key))}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));

    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = takeFrame(buffer);
        if (!frame) return;
        buffer = buffer.subarray(frame.consumed);
        // 关闭帧：这一条连接到此为止（假服务端不陪它演完整的关闭握手）
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        const message: FakeMessage = { opcode: frame.opcode, data: frame.payload };
        messages.push(message);
        if (frame.opcode === 0x1) onText(message, (text) => writeTextFrame(socket, text));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;

  return {
    address: { host: "127.0.0.1", port },
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `Sec-WebSocket-Accept = base64(sha1(key + GUID))` */
function acceptKey(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** 拆出一条帧（**客户端发来的帧必有掩码**，掩码要去掉）；不足一帧返回 `null` */
function takeFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    // 逐字节解掩码：载荷是任意字节，不能当字符串处理
    for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
  }
  return { opcode, payload, consumed: offset + length };
}

/** 写一条文本帧（服务端 → 客户端的方向**不加掩码**） */
function writeTextFrame(socket: Socket, text: string): void {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

/** 等假服务端把消息都收下来（帧与回执是两条链，`call()` 先落定不代表对端已读完全部字节） */
async function waitForMessages(fake: FakeWsServer, count: number): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (fake.messages.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
