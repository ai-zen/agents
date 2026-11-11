/**
 * 传输抽象的可替换性验收 —— 用一个**真的双工**（两个 `PassThrough` 对接成一条内存通道）
 * 驱动同一个 `Daemon`：握手、方法调用、服务端主动推事件、断开清理，全程没有 `net.Socket`。
 *
 * ## 为什么不用 `vi.mock` / 录音存根
 *
 * 这里要证明的是「换掉传输之后守护进程照常工作」。存根只能记下「`write` 被调了几次」，
 * 它不会因为你把「UTF-8 多字节被 chunk 切开」或「关闭之后还在写」弄错而失败 —— 而那两件
 * 恰恰是真实传输会遇到的事。所以假件照真件的形状做：一个 `implements Wire` 的对象，
 * 内部是两个真的 Node 流（`write` 真的进流、`onData` 真的从流里来、关闭真的让流不可写）。
 *
 * ## 两段对照
 *
 * 同一个 `handleConnection()` 入口喂两种传输：内存双工（本文件上半）与真 `net.Socket`
 * （下半，走的就是 `start()` 内部那一行 `createServer((s) => handleConnection(socketWire(s)))`）。
 * 真 socket 那一路的其余用例留在 `Daemon.test.ts`（握手 / 失败码 / 端口）与
 * `sessionHandlers.test.ts`（`events.watch` 推事件），本次改造没有动它们一个字。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, createConnection, type AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, type AnyHandler, type DaemonOptions } from "./Daemon.js";
import { socketWire, type Wire } from "./wire.js";
import { EventHub } from "../lib/events.js";
import { encodeFrame, FrameDecoder } from "../wire/frames.js";
import { PROTOCOL_VERSION } from "../wire/messages.js";

let dir: string;
let daemon: Daemon | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-server-wire-"));
});

afterEach(async () => {
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 建一个**不 `start()`** 的 daemon：用例直接从 `handleConnection()` 喂一条 `Wire`。
 *
 * 不启动监听是刻意的 —— 这半边的题目是「不用 TCP 也能驱动这个守护进程」，一旦 `start()`
 * 就跟 `net.Server` 扯上了关系，证明力就没了。
 */
function makeDaemon(options: Partial<DaemonOptions> = {}): Daemon {
  const instance = new Daemon({ aiZenDir: dir, version: "0.1.0-test", ...options });
  daemon = instance;
  return instance;
}

/**
 * 轮询到条件成立。
 *
 * 不用固定 sleep：内存流和真 socket 都是事件驱动的，「等 50ms 应该好了」在小机器上不够、
 * 在大机器上白等。条件成立就往下走，超时才报错（报错信息带等的是什么）。
 */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * 与 `sessionHandlers.ts` 里 `events.watch` 同形的两个方法：订阅 → 每条事件写给这条连接 →
 * 断开时退订。这里不拉真的 `sessionHandlers`（那要连同 `SessionManager` 一起起），
 * 本文件要验的是**传输这一层**：`Connection.send` 是否真的落到 `Wire.write` 上、
 * `Wire` 断开是否真的跑完清理。
 */
function eventHandlers(hub: EventHub, onUnsubscribe: () => void): Record<string, AnyHandler> {
  return {
    "events.watch": (_params, connection) => {
      const unsubscribe = hub.subscribe((event) => connection.send(event));
      connection.onClose(() => {
        onUnsubscribe();
        unsubscribe();
      });
      return { watching: true };
    },
    "test.publish": () => {
      hub.publish({ event: "session-turn-end", sessionId: "s1", turnId: 1, ok: true });
      return { published: true };
    },
  };
}

// ==================================================================
// 对端（客户端）一侧：与传输无关
// ==================================================================

/**
 * 对端要做的只有「发帧 / 收帧 / 等」，与底下是 socket 还是内存流无关 —— 所以两种传输共用
 * 这一个类，断言才能真正做到「同一件事换个传输再跑一遍」。
 */
class Peer {
  private readonly decoder = new FrameDecoder();
  private readonly inbox: unknown[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  private nextId = 1;

  constructor(
    private readonly write: (chunk: string | Buffer) => void,
    private readonly hangUp: () => void,
  ) {}

  /** 传输把收到的字节递进来（各自在 `data` 里调） */
  feed(chunk: Buffer): void {
    try {
      this.decoder.push(chunk);
      for (let item = this.decoder.next(); item; item = this.decoder.next()) {
        if (item.type === "frame") this.inbox.push(item.frame);
      }
    } catch (error) {
      this.inbox.push(error);
    }
    this.wake();
  }

  /** 传输报断开（各自在 close / end 里调） */
  markClosed(): void {
    this.closed = true;
    this.wake();
  }

  send(frame: unknown): void {
    this.write(encodeFrame(frame));
  }

  /** 发一帧 + 它后面紧跟的原始字节（带 payload 的请求） */
  sendWithBytes(frame: unknown, bytes: Buffer): void {
    this.write(encodeFrame(frame));
    this.write(bytes);
  }

  /** 发一段裸字节（测协议错误时用） */
  raw(text: string): void {
    this.write(text);
  }

  /** 本端掉线 */
  close(): void {
    this.hangUp();
  }

  async handshake(): Promise<any> {
    this.send({
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      client: { name: "wire-test", version: "0" },
    });
    return await this.next();
  }

  async call(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.send({ id, method, params });
    const response = await this.nextMatching((frame) => frame?.id === id);
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result;
  }

  async next(): Promise<any> {
    return await this.nextMatching(() => true);
  }

  /** 事件推送与响应帧可能交错，所以按条件挑，不假设顺序 */
  async nextMatching(predicate: (frame: any) => boolean): Promise<any> {
    for (;;) {
      const index = this.inbox.findIndex((frame) => predicate(frame));
      if (index >= 0) return this.inbox.splice(index, 1)[0];
      if (this.closed) throw new Error("连接在等到帧之前就断了");
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

// ==================================================================
// 假 Wire：内存里的真双工
// ==================================================================

/**
 * 假 `Wire` —— 两个 `PassThrough` 对接成一条内存通道，`peer` 那一端就是"客户端"。
 *
 * 它真的是双工，不是存根：`write()` 真的写进流、`onData` 真的从流里冒出来、关闭真的让流
 * 不可写（守护进程若在关闭之后还写，会拿到 `ERR_STREAM_WRITE_AFTER_END`，测试当场红）。
 */
class FakeWire implements Wire {
  /** 客户端 → 服务端 */
  private readonly toServer = new PassThrough();
  /** 服务端 → 客户端 */
  private readonly toClient = new PassThrough();
  readonly peer: Peer;

  private readonly dataListeners: Array<(chunk: Buffer) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private closed = false;
  private finished = false;

  constructor() {
    // 接口约定 `onData` 吐字节（payload 里的任何字节都得原样到达协议层），所以这里不解码：
    // 两个流都保持 Buffer 模式，守护进程拿到的 chunk 与真 socket 完全一致。
    this.peer = new Peer(
      (text) => this.toServer.write(text),
      () => this.teardown(),
    );

    this.toServer.on("data", (chunk: Buffer) => {
      for (const listener of this.dataListeners) listener(chunk);
    });
    this.toClient.on("data", (chunk: Buffer) => this.peer.feed(chunk));
    for (const stream of [this.toServer, this.toClient]) {
      stream.on("error", (error: Error) => {
        for (const listener of this.errorListeners) listener(error);
      });
    }
    // 出站被读空之后才算断开：真 socket 上也是 data 事件在先、close 在后。
    this.toClient.on("end", () => this.finish());
    this.toClient.on("close", () => this.finish());
  }

  get destroyed(): boolean {
    return this.closed;
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  write(text: string): void {
    this.toClient.write(text);
  }

  destroy(): void {
    this.teardown();
  }

  private teardown(): void {
    if (this.closed) return;
    // 先让 `destroyed` 为 true（守护进程从此不再写），再让已排队的帧送达：真 socket 上
    // `destroy()` 之前写出去的字节通常已在发送缓冲里，客户端先看到那一帧、再看到断开 ——
    // 握手失败的 error 帧正靠这个顺序。
    this.closed = true;
    this.toServer.destroy();
    this.toClient.end();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.peer.markClosed();
    for (const listener of this.closeListeners.splice(0)) listener();
  }
}

// ==================================================================
// 真 socket 的对端
// ==================================================================

/** 真 `net.Socket` 的对端：把「收 / 发 / 断」接到同一个 `Peer` 上，断言与假传输完全一样 */
async function connectSocketPeer(port: number): Promise<Peer> {
  const socket = createConnection({ host: "127.0.0.1", port });
  const peer = new Peer(
    (text) => socket.write(text),
    () => socket.destroy(),
  );
  socket.on("data", (chunk: Buffer) => peer.feed(chunk));
  socket.on("close", () => peer.markClosed());
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  return peer;
}

// ==================================================================
// 用例
// ==================================================================

describe("假 Wire（内存双工）驱动 Daemon", () => {
  it("hello 握手 → 方法调用 → 拿到 ok:true 的响应帧（全程没有 net.Socket）", async () => {
    const instance = makeDaemon();
    const wire = new FakeWire();
    instance.handleConnection(wire);

    const hello = await wire.peer.handshake();
    expect(hello).toMatchObject({
      kind: "hello",
      ok: true,
      server: { name: "@ai-zen/agents-server", version: "0.1.0-test", protocol: PROTOCOL_VERSION },
    });

    expect(await wire.peer.call("ping")).toEqual({ pong: true });
    expect(instance.connectionCount).toBe(1);
    expect(wire.destroyed).toBe(false);
  });

  it("订阅后能收到服务端主动推的事件；wire 断开时连接被清掉、订阅跟着退", async () => {
    const hub = new EventHub();
    let unsubscribed = 0;
    const instance = makeDaemon({ handlers: eventHandlers(hub, () => unsubscribed++) });
    const wire = new FakeWire();
    instance.handleConnection(wire);

    await wire.peer.handshake();
    expect(await wire.peer.call("events.watch")).toEqual({ watching: true });
    expect(hub.watcherCount()).toBe(1);

    await wire.peer.call("test.publish");
    expect(await wire.peer.nextMatching((frame) => frame?.event === "session-turn-end")).toEqual({
      event: "session-turn-end",
      sessionId: "s1",
      turnId: 1,
      ok: true,
    });

    // 客户端掉线：连接表要被清空，`Connection.onClose` 里的退订要真的跑 ——
    // 不跑的话服务端会给一条已经关掉的连接一直写帧，而 `write` 不报错，泄漏是安静的。
    wire.peer.close();
    await waitFor(() => instance.connectionCount === 0, "断开后连接从 connections 里被删掉");
    expect(unsubscribed).toBe(1);
    expect(hub.watcherCount()).toBe(0);
  });

  it("协议错误也完全走 Wire：错误帧先送达，然后 wire 被 destroy()", async () => {
    const instance = makeDaemon();
    const wire = new FakeWire();
    instance.handleConnection(wire);

    wire.peer.raw("this is not json\n");
    expect(await wire.peer.next()).toMatchObject({ ok: false, error: { code: "bad-frame" } });
    await waitFor(() => wire.destroyed, "wire 被 destroy()");
    await waitFor(() => instance.connectionCount === 0, "断开后连接从 connections 里被删掉");
  });

  /**
   * 带 payload 的方法：帧说多少字节、后面就紧跟多少字节。
   *
   * 用真方法名 `content.upload`（「哪条方法带字节」是 `Daemon` 里那张表定的，假名字进不去），
   * 但 handler 换成假件 —— 这一层要证的是**字节怎么到 handler 手里**，不是内容怎么转。
   */
  const bytesHandlers = (seen: Buffer[]): Record<string, AnyHandler> => ({
    "content.upload": (_params, _connection, payload) => {
      seen.push(payload!);
      return { got: payload?.byteLength ?? -1 };
    },
  });

  it("帧与 payload 在同一个 chunk 里到达：字节原样交给 handler（中间那个 0x0A 不被当帧边界）", async () => {
    const seen: Buffer[] = [];
    const instance = makeDaemon({ handlers: bytesHandlers(seen) });
    const wire = new FakeWire();
    instance.handleConnection(wire);
    await wire.peer.handshake();

    const bytes = Buffer.from([0x41, 0x0a, 0x42]);
    // 帧 + payload + 下一帧，一次写进同一条流（实际传输几乎总是这个形状）
    wire.peer.sendWithBytes(
      { id: 7, method: "content.upload", params: { bytes: bytes.byteLength } },
      bytes,
    );
    wire.peer.send({ id: 8, method: "ping" });

    expect(await wire.peer.nextMatching((frame) => frame?.id === 7)).toEqual({
      id: 7,
      ok: true,
      result: { got: 3 },
    });
    expect(seen[0]).toEqual(bytes);
    // 二进制阶段结束后回到按行切帧：紧接着的那一帧照常被认出
    expect(await wire.peer.nextMatching((frame) => frame?.id === 8)).toMatchObject({ ok: true });
  });

  it("payload 跨 chunk：收满之前不派发，收满之后派发（帧先存着，字节到了才走）", async () => {
    const seen: Buffer[] = [];
    const instance = makeDaemon({ handlers: bytesHandlers(seen) });
    const wire = new FakeWire();
    instance.handleConnection(wire);
    await wire.peer.handshake();

    wire.peer.sendWithBytes(
      { id: 1, method: "content.upload", params: { bytes: 4 } },
      Buffer.from("AB"),
    );
    // 字节没收满：一帧都不该派发。若解码器按 `\n` 找帧边界，这里会先撞出 bad-frame、把这条
    // 连接断掉，下面那句 await 就会以「连接在等到帧之前就断了」红掉
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(0);

    wire.peer.raw("CD");
    expect(await wire.peer.nextMatching((frame) => frame?.id === 1)).toEqual({
      id: 1,
      ok: true,
      result: { got: 4 },
    });
    expect(seen[0]).toEqual(Buffer.from("ABCD"));
  });

  it("字节声明不合法 → 协议错误并断开（长度非正 / 不带字节的方法冒出一个 bytes）", async () => {
    for (const params of [{ bytes: 0 }, { bytes: -5 }, { bytes: 1.5 }]) {
      const instance = makeDaemon({ handlers: bytesHandlers([]) });
      const wire = new FakeWire();
      instance.handleConnection(wire);
      await wire.peer.handshake();

      wire.peer.send({ id: 1, method: "content.upload", params });
      expect(await wire.peer.nextMatching((frame) => frame?.ok === false)).toMatchObject({
        error: { code: "bad-frame" },
      });
      await waitFor(() => wire.destroyed, "wire 被 destroy()");
    }

    // 不带字节的方法上出现 `bytes`：帧形状自相矛盾，同样断开
    const instance = makeDaemon();
    const wire = new FakeWire();
    instance.handleConnection(wire);
    await wire.peer.handshake();
    wire.peer.send({ id: 1, method: "ping", params: { bytes: 4 } });
    expect(await wire.peer.nextMatching((frame) => frame?.ok === false)).toMatchObject({
      error: { code: "bad-frame" },
    });
    await waitFor(() => wire.destroyed, "wire 被 destroy()");
  });
});

describe("真 net.Socket（TCP 那一路的适配器）", () => {
  it("同一段场景：socketWire() → handleConnection() → 握手 / 调用 / 事件 / 断开清理", async () => {
    const hub = new EventHub();
    const instance = makeDaemon({ handlers: eventHandlers(hub, () => {}) });
    // 与 `start()` 里那一行同形：每个 socket 包一层适配器再交给同一个入口。
    const server = createServer((socket) => instance.handleConnection(socketWire(socket)));
    await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const peer = await connectSocketPeer(port);

      expect(await peer.handshake()).toMatchObject({ kind: "hello", ok: true });
      expect(await peer.call("ping")).toEqual({ pong: true });

      await peer.call("events.watch");
      await peer.call("test.publish");
      expect(await peer.nextMatching((frame) => frame?.event === "session-turn-end")).toMatchObject(
        {
          sessionId: "s1",
        },
      );

      peer.close();
      await waitFor(() => instance.connectionCount === 0, "断开后连接从 connections 里被删掉");
      expect(hub.watcherCount()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
