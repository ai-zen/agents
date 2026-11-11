/**
 * 传输抽象的可替换性验收 —— 用一个**真的双工**（两条对象模式的 `PassThrough` 对接成通道）
 * 驱动同一个 `Daemon`：握手、方法调用、服务端主动推事件、二进制配对、断开清理，全程没有
 * `ws.WebSocket`。
 *
 * ## 为什么不用 `vi.mock` / 录音存根
 *
 * 这里要证明的是「换掉传输之后守护进程照常工作」。存根只能记下「`write` 被调了几次」，
 * 它不会因为你把「销毁之后还在写」弄错而失败 —— 而那恰恰是真实传输会遇到的事。所以假件
 * 照真件的形状做：一个 `implements Wire` 的对象，内部是真的 Node 流（`write` 真的进流、
 * `onText` / `onBinary` 真的从流里来、关闭真的让流不可写）。
 *
 * 用**对象模式**的流而不是字节流，是因为这一版的分帧归传输层：一条消息就是一个对象，
 * 「两条消息被粘成一条」这件事在新形状里不存在。
 *
 * ## 两段对照
 *
 * 同一个 `handleConnection()` 入口喂两种传输：内存双工（上半）与真 WebSocket（下半，走的就是
 * `start()` 里那个 `webSocketWire()` 适配器 + 升级回调）。断言是同一套：同一件事换个传输再
 * 跑一遍。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { Daemon, type AnyHandler, type DaemonOptions } from "./Daemon.js";
import { webSocketWire, type Wire } from "./wire.js";
import { EventHub } from "../lib/events.js";
import { PROTOCOL_VERSION } from "../wire/messages.js";
import { WsTestClient } from "./WsTestClientTestSupport.js";

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
 * 不启动监听是刻意的 —— 这半边的题目是「不用 WebSocket 也能驱动这个守护进程」，一旦
 * `start()` 就跟 `http.Server` 扯上了关系，证明力就没了。
 */
function makeDaemon(options: Partial<DaemonOptions> = {}): Daemon {
  const instance = new Daemon({ aiZenDir: dir, version: "0.1.0-test", ...options });
  daemon = instance;
  return instance;
}

/**
 * 轮询到条件成立。
 *
 * 不用固定 sleep：内存流和真 WebSocket 都是事件驱动的，「等 50ms 应该好了」在小机器上
 * 不够、在大机器上白等。条件成立就往下走，超时才报错（报错信息带等的是什么）。
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

/** 带字节的方法：只记下收到的载荷 */
const uploadHandlers = (seen: Buffer[]): Record<string, AnyHandler> => ({
  "content.upload": (_params, _connection, payload) => {
    seen.push(payload!);
    return { got: payload?.byteLength ?? -1 };
  },
});

// ==================================================================
// 假 Wire：内存里的真双工
// ==================================================================

/** 通道里流动的一项：一条文本消息或一条二进制消息（边界由**这一层**保证，与 WS 同形） */
type ChannelMessage = { kind: "text"; text: string } | { kind: "binary"; bytes: Buffer };

/**
 * 对端（客户端）一侧：只做「发消息 / 收消息 / 等」，与底下是 WebSocket 还是内存流无关
 * —— 所以两种传输共用这一个类。
 */
class Peer {
  private readonly inbox: unknown[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  private nextId = 1;

  constructor(
    private readonly write: (message: ChannelMessage) => void,
    private readonly hangUp: () => void,
  ) {}

  /** 传输把收到的一条消息递进来（各自在 `data` 里调） */
  feed(message: unknown): void {
    this.inbox.push(message);
    this.wake();
  }

  /** 传输报断开 */
  markClosed(): void {
    this.closed = true;
    this.wake();
  }

  /** 发一条请求（文本消息） */
  send(frame: unknown): void {
    this.write({ kind: "text", text: JSON.stringify(frame) });
  }

  /** 发一段原始文本（测非法 JSON） */
  sendRaw(text: string): void {
    this.write({ kind: "text", text });
  }

  /** 发一条二进制消息：`[4 字节大端 id][载荷]` */
  sendBinary(requestId: number, payload: Buffer): void {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(requestId, 0);
    this.write({ kind: "binary", bytes: Buffer.concat([head, payload]) });
  }

  /** 本端掉线 */
  close(): void {
    this.hangUp();
  }

  async handshake(): Promise<any> {
    return await this.request("hello", {
      protocol: PROTOCOL_VERSION,
      client: { name: "wire-test", version: "0" },
    });
  }

  /** 发一条请求，拿回整条响应 */
  async request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return await this.nextMatching((frame) => frame?.id === id);
  }

  /** 发一条请求并要结果（失败响应抛错） */
  async call(method: string, params?: unknown): Promise<any> {
    const response = await this.request(method, params);
    if (response.error) {
      throw new Error(`${response.error.data?.code}: ${response.error.message}`);
    }
    return response.result;
  }

  async next(): Promise<any> {
    return await this.nextMatching(() => true);
  }

  /** 事件推送与响应可能交错，所以按条件挑，不假设顺序 */
  async nextMatching(predicate: (frame: any) => boolean): Promise<any> {
    for (;;) {
      const index = this.inbox.findIndex((frame) => predicate(frame));
      if (index >= 0) return this.inbox.splice(index, 1)[0];
      if (this.closed) throw new Error("连接在等到消息之前就断了");
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

/**
 * 假 `Wire` —— 两条**对象模式**的 `PassThrough` 对接成一条内存通道，`peer` 那一端就是"客户端"。
 *
 * 它真的是双工，不是存根：`write()` 真的写进流、`onText` / `onBinary` 真的从流里冒出来、
 * 关闭真的让流不可写（守护进程若在关闭之后还写，会拿到 `ERR_STREAM_WRITE_AFTER_END`，
 * 测试当场红）。
 */
class FakeWire implements Wire {
  /** 客户端 → 服务端 */
  private readonly toServer = new PassThrough({ objectMode: true });
  /** 服务端 → 客户端 */
  private readonly toClient = new PassThrough({ objectMode: true });
  readonly peer: Peer;

  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private closed = false;
  private finished = false;

  constructor() {
    this.peer = new Peer(
      (message) => this.toServer.write(message),
      () => this.teardown(),
    );

    // 出站一律是文本（服务端不发二进制，见 `Wire.write`）
    this.toClient.on("data", (message: ChannelMessage) => {
      if (message.kind === "text") this.peer.feed(JSON.parse(message.text));
    });
    for (const stream of [this.toServer, this.toClient]) {
      stream.on("error", (error: Error) => {
        for (const listener of this.errorListeners) listener(error);
      });
    }
    // 出站被读空之后才算断开：真 WebSocket 上也是消息事件在先、close 在后
    this.toClient.on("end", () => this.finish());
    this.toClient.on("close", () => this.finish());
  }

  get destroyed(): boolean {
    return this.closed;
  }

  onText(listener: (text: string) => void): void {
    this.toServer.on("data", (message: ChannelMessage) => {
      if (message.kind === "text") listener(message.text);
    });
  }

  onBinary(listener: (bytes: Buffer) => void): void {
    this.toServer.on("data", (message: ChannelMessage) => {
      if (message.kind === "binary") listener(message.bytes);
    });
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  write(text: string): void {
    this.toClient.write({ kind: "text", text });
  }

  destroy(): void {
    this.teardown();
  }

  private teardown(): void {
    if (this.closed) return;
    // 先让 `destroyed` 为 true（守护进程从此不再写），再让已排队的消息送达：真 WebSocket 上
    // `close()` 之前发出去的消息通常已在发送队列里，客户端先看到它、再看到断开 ——
    // 版本不匹配那条错误响应正靠这个顺序。
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
// 用例：内存双工驱动 Daemon
// ==================================================================

describe("假 Wire（内存双工）驱动 Daemon", () => {
  it("hello 握手 → 方法调用 → 拿到成功响应（全程没有 WebSocket）", async () => {
    const instance = makeDaemon();
    const wire = new FakeWire();
    instance.handleConnection(wire);

    const hello = await wire.peer.handshake();
    expect(hello).toMatchObject({
      jsonrpc: "2.0",
      result: {
        name: "@ai-zen/agents-server",
        version: "0.1.0-test",
        protocol: PROTOCOL_VERSION,
      },
    });

    expect(await wire.peer.call("ping")).toEqual({ pong: true });
    expect(instance.connectionCount).toBe(1);
    expect(wire.destroyed).toBe(false);
  });

  it("订阅后能收到服务端主动推的事件（包成 `session.event` 通知）；断开时连接被清掉、订阅跟着退", async () => {
    const hub = new EventHub();
    let unsubscribed = 0;
    const instance = makeDaemon({ handlers: eventHandlers(hub, () => unsubscribed++) });
    const wire = new FakeWire();
    instance.handleConnection(wire);

    await wire.peer.handshake();
    expect(await wire.peer.call("events.watch")).toEqual({ watching: true });
    expect(hub.watcherCount()).toBe(1);

    await wire.peer.call("test.publish");
    expect(
      await wire.peer.nextMatching((frame) => frame?.params?.event === "session-turn-end"),
    ).toEqual({
      jsonrpc: "2.0",
      method: "session.event",
      params: { event: "session-turn-end", sessionId: "s1", turnId: 1, ok: true },
    });

    // 客户端掉线：连接表要被清空，`Connection.onClose` 里的退订要真的跑 ——
    // 不跑的话服务端会给一条已经关掉的连接一直写消息，而写一条关掉的连接不报错，泄漏是安静的
    wire.peer.close();
    await waitFor(() => instance.connectionCount === 0, "断开后连接从 connections 里被删掉");
    expect(unsubscribed).toBe(1);
    expect(hub.watcherCount()).toBe(0);
  });

  it("请求级错误不回退成断连：非法 JSON 之后这条线照样能用", async () => {
    const instance = makeDaemon();
    const wire = new FakeWire();
    instance.handleConnection(wire);
    await wire.peer.handshake();

    wire.peer.sendRaw("this is not json");
    expect(await wire.peer.next()).toMatchObject({
      id: null,
      error: { code: -32700, data: { code: "bad-frame" } },
    });
    expect(wire.destroyed).toBe(false);
    expect(await wire.peer.call("ping")).toEqual({ pong: true });
  });

  it("连接级错误也完全走 Wire：二进制 id 找不到在飞请求 → wire 被 destroy()", async () => {
    const instance = makeDaemon();
    const wire = new FakeWire();
    instance.handleConnection(wire);
    await wire.peer.handshake();

    wire.peer.sendBinary(1234, Buffer.from("AB"));
    await waitFor(() => wire.destroyed, "wire 被 destroy()");
    await waitFor(() => instance.connectionCount === 0, "断开后连接从 connections 里被删掉");
  });

  it("二进制载荷按 4 字节 id 配对：文本先到、字节后到，一起派发", async () => {
    const seen: Buffer[] = [];
    const instance = makeDaemon({ handlers: uploadHandlers(seen) });
    const wire = new FakeWire();
    instance.handleConnection(wire);
    await wire.peer.handshake();

    // 载荷里就有 0x0A：这一版不再有"按换行切帧"，它只是一个普通字节
    const bytes = Buffer.from([0x41, 0x0a, 0x42]);
    wire.peer.send({
      jsonrpc: "2.0",
      id: 7,
      method: "content.upload",
      params: { mime: "image/png" },
    });
    // 字节还没到：一条都不该派发
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(0);

    wire.peer.sendBinary(7, bytes);
    expect(await wire.peer.nextMatching((frame) => frame?.id === 7)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { got: 3 },
    });
    expect(seen[0]).toEqual(bytes);
  });
});

// ==================================================================
// 用例：真 WebSocket（生产那一路的适配器）
// ==================================================================

describe("真 WebSocket（webSocketWire 适配器）", () => {
  it("同一段场景：webSocketWire() → handleConnection() → 握手 / 调用 / 事件 / 断开清理", async () => {
    const hub = new EventHub();
    const instance = makeDaemon({ handlers: eventHandlers(hub, () => {}) });

    // 与 `start()` 里那两行同形：升级时把每个连接包一层适配器再交给同一个入口
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (ws) => instance.handleConnection(webSocketWire(ws)));
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const port = (wss.address() as { port: number }).port;

    const client = await WsTestClient.connect(port);
    try {
      expect((await client.handshake()).result).toMatchObject({ protocol: PROTOCOL_VERSION });
      expect(await client.call("ping")).toEqual({ pong: true });

      await client.call("events.watch");
      await client.call("test.publish");
      expect(
        await client.nextMatching((frame) => frame?.params?.event === "session-turn-end"),
      ).toMatchObject({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "s1" } });

      client.close();
      await waitFor(() => instance.connectionCount === 0, "断开后连接从 connections 里被删掉");
      expect(hub.watcherCount()).toBe(0);
    } finally {
      client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
