/**
 * 会话/守护进程那几组用例共用的**测试客户端**：一条真 WebSocket，说 JSON-RPC 2.0。
 *
 * ## 为什么是一个模块而不是每个文件各带一份
 *
 * 「发一条请求、等那条 `id` 的回执、把事件通知让过去」这套东西在 `Daemon.test.ts` 与
 * `sessionHandlers.test.ts` 里是**同一份知识**（消息形状、握手是一条普通请求、二进制消息的
 * 4 字节 id 前缀）。抄两份的那天，改一处形状就可能漏掉另一处，而假对端与真协议不同形的
 * 代价是：一个「回执挂错 id」的真 bug 能躲过一整轮单测。
 *
 * 它必须与用例一起被排除在产物之外 —— 命名按仓库约定用 `*TestSupport.ts`（见 tsconfig 的
 * `exclude`）。
 *
 * ## 为什么用真 WebSocket 而不是内存双工
 *
 * 被测的是**线上协议本身**：换成假传输就等于没测（`daemon/wire.test.ts` 另有一半专门的
 * 「不是 `ws.WebSocket` 也能驱动 Daemon」的用例）。这里刻意什么都不 mock。
 */

import { WebSocket, type RawData } from "ws";
import { PROTOCOL_VERSION } from "../wire/messages.js";

/** 线上一条消息解出来的形状。用例里它可能是响应、也可能是 `session.event` 通知 */
export type WireFrame = Record<string, any>;

/** 连不上 / 等到一半断开时抛的那句话（不是断言失败，而是环境事实） */
export class PeerClosedError extends Error {
  constructor(what: string) {
    super(`connection closed while waiting for ${what}`);
    this.name = "PeerClosedError";
  }
}

export class WsTestClient {
  private readonly inbox: WireFrame[] = [];
  private readonly waiters: Array<() => void> = [];
  private isClosed = false;
  /** 请求 id 从 100 起：把 1–99 留给「用例自己指定 id」的场景，避免与自动分配撞号 */
  private nextId = 100;

  private constructor(private readonly socket: WebSocket) {}

  static async connect(port: number): Promise<WsTestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = new WsTestClient(socket);
    socket.on("message", (data: RawData, isBinary: boolean) => {
      // 服务端不发二进制（它的结果全部是 JSON）；真收到了就当一条解析不了的消息塞进队列
      if (isBinary) return;
      const text = toText(data);
      try {
        client.inbox.push(JSON.parse(text) as WireFrame);
      } catch {
        client.inbox.push({ unparsable: text });
      }
      client.wake();
    });
    socket.on("close", () => {
      client.isClosed = true;
      client.wake();
    });
    socket.on("error", () => {
      // 读一条已经掐掉的连接会报错；对用例来说「断了」就够，细节不重要
      client.isClosed = true;
      client.wake();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return client;
  }

  // ==================== 发 ====================

  /** 发一条文本消息（对象会被编码成 JSON；不带结尾换行） */
  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** 发一段**原始文本**（测非法 JSON 用） */
  sendRaw(text: string): void {
    this.socket.send(text);
  }

  /** 发一条二进制消息：`[4 字节大端 id][载荷]` */
  sendBinary(requestId: number, payload: Buffer): void {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(requestId, 0);
    this.socket.send(Buffer.concat([head, payload]));
  }

  /** 发一段任意二进制（测「连 id 都读不出来」用） */
  sendRawBinary(bytes: Buffer): void {
    this.socket.send(bytes);
  }

  /** 发一条请求，拿回整条响应（成功或失败都原样返回） */
  async request(
    method: string,
    params?: unknown,
    options: { id?: number } = {},
  ): Promise<WireFrame> {
    const id = options.id ?? this.nextId++;
    // `params` 为 undefined 时**整键**不出现：没参数的方法不该带一个 `null`
    this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return await this.nextMatching((frame) => frame.id === id);
  }

  /** 发一条请求并要结果：失败响应会抛出（`message` 里带 `data.code`） */
  async call(method: string, params?: unknown): Promise<any> {
    const response = await this.request(method, params);
    if (response.error) throw new Error(errorText(response));
    return response.result;
  }

  /** 握手（第一条请求）。可以覆盖 `hello` 的参数，用来测版本不匹配 */
  async handshake(params: Record<string, unknown> = {}): Promise<WireFrame> {
    return await this.request("hello", {
      protocol: PROTOCOL_VERSION,
      client: { name: "test", version: "0" },
      ...params,
    });
  }

  // ==================== 收 ====================

  /** 取下一条文本消息（事件通知与响应交错时，按到达顺序取） */
  async next(): Promise<WireFrame> {
    return await this.nextMatching(() => true);
  }

  /** 取下一条满足条件的消息；不满足的留在队列里（之后还能 `next()` 到） */
  async nextMatching(predicate: (frame: WireFrame) => boolean): Promise<WireFrame> {
    for (;;) {
      const index = this.inbox.findIndex((frame) => predicate(frame));
      if (index >= 0) return this.inbox.splice(index, 1)[0]!;
      if (this.isClosed) throw new PeerClosedError("a frame");
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /**
   * 取下一条**事件通知的载荷**（`params`）。
   *
   * 事件统一走一条 method `session.event`，真正的判别信息在 `params.event` 上 —— 所以
   * 「服务端推了什么」这件事的断言都对着载荷写，而不是每次都先剥一层外壳。
   */
  async nextEvent(): Promise<WireFrame> {
    return (await this.nextMatching((frame) => frame.method === "session.event")).params;
  }

  /** 等对端把连接关掉（事件循环几轮即可；不用固定长 sleep） */
  async closed(): Promise<boolean> {
    for (let i = 0; i < 40 && !this.isClosed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.isClosed;
  }

  /** 还没被取走的消息条数（断言「服务端**没**发东西」用） */
  pending(): number {
    return this.inbox.length;
  }

  /** 本端断开 */
  close(): void {
    this.socket.close();
  }

  /** 等一会儿（用来断言「某件事**不**该发生」，比如某条请求不该被派发） */
  async settle(ms = 20): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

/** 一条失败响应里给人看的那句话：`data.code: message`（与 `callOnce` 抛出来的形态一致） */
export function errorText(response: WireFrame): string {
  const code = response?.error?.data?.code ?? response?.error?.code;
  return `${code}: ${response?.error?.message ?? ""}`;
}

/** `ws` 的 `RawData` 三种形态 → 文本 */
function toText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
