/**
 * 接线层用例的脚手架：临时目录、真 WebSocket 客户端、帧队列。
 *
 * 用例里的服务器是真的（`port: 0` 让系统分配端口），客户端也是真的 `ws` —— 这一层要验证的正是
 * 「帧在网络上按什么顺序出现」，用假 socket 会把想验的东西验掉。
 *
 * 本文件只被 `*.test.ts` import（`tsconfig.json` 把它排除在产物之外）。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket, type RawData } from "ws";

import type { JsonRpcId } from "../wire/index.js";

// ---------------------------------------------------------------------------
// 临时目录
// ---------------------------------------------------------------------------

export interface TempDir {
  path: string;
  /** 删掉整个目录（用例收尾调） */
  remove(): Promise<void>;
}

export async function makeTempDir(prefix: string): Promise<TempDir> {
  const path = await fs.mkdtemp(join(tmpdir(), `ai-zen-${prefix}-`));
  return {
    path,
    remove: () => fs.rm(path, { recursive: true, force: true }),
  };
}

/** 目录下的文件名（含隐藏文件），断言「临时文件被清掉了」用 */
export async function listDir(path: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path);
    return entries.sort();
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 收到的帧
// ---------------------------------------------------------------------------

export interface ReceivedErrorData {
  code: string;
  message: string;
  detail?: unknown;
  params: Record<string, unknown>;
}

export type ReceivedFrame =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: string; data: ReceivedErrorData } }
  | { jsonrpc: "2.0"; method: string; params: unknown };

export function isSuccess(frame: ReceivedFrame): frame is { jsonrpc: "2.0"; id: JsonRpcId; result: unknown } {
  return "result" in frame;
}

export function isError(
  frame: ReceivedFrame,
): frame is {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data: ReceivedErrorData };
} {
  return "error" in frame;
}

export function isNotification(
  frame: ReceivedFrame,
): frame is { jsonrpc: "2.0"; method: string; params: unknown } {
  return "method" in frame;
}

// ---------------------------------------------------------------------------
// 帧队列：按到达顺序排队，谁先到谁先出
// ---------------------------------------------------------------------------

export class FrameQueue {
  private readonly frames: ReceivedFrame[] = [];
  private readonly waiters: ((frame: ReceivedFrame) => void)[] = [];

  push(frame: ReceivedFrame): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(frame);
    else this.frames.push(frame);
  }

  /** 取下一帧（按到达顺序）；超时算用例失败 */
  next(timeoutMs = 2000): Promise<ReceivedFrame> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<ReceivedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`等帧超时（${timeoutMs}ms）：队列里没有更多帧`));
      }, timeoutMs);
      const waiter = (frame: ReceivedFrame): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push(waiter);
    });
  }

  /** 队列里现在攒了几帧 */
  size(): number {
    return this.frames.length;
  }
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export class TestClient {
  readonly queue = new FrameQueue();
  private nextId = 1;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data: RawData) => {
      this.queue.push(JSON.parse(rawToString(data)) as ReceivedFrame);
    });
  }

  /** 连上（等 `open`） */
  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接超时")), 2000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    // 握手失败之类的用例不需要额外处理：错误帧照样从 message 出来
    socket.removeAllListeners("error");
    socket.on("error", () => undefined);
    return new TestClient(socket);
  }

  get ready(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  /** 发一个 JSON 帧（对象按 JSON 序列化） */
  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** 发一段原始文本（坏帧、批量数组这类用例用） */
  sendText(text: string): void {
    this.socket.send(text);
  }

  /** 发一个二进制帧 */
  sendBinary(bytes: Uint8Array): void {
    this.socket.send(bytes);
  }

  /** 发一个请求，返回它的 `id`（响应从队列里按顺序取） */
  request(method: string, params: unknown = {}): JsonRpcId {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return id;
  }

  /** 发一个请求并等它的响应（前提：这中间不会有推送插进来） */
  async call(
    method: string,
    params: unknown = {},
  ): Promise<{ id: JsonRpcId; result: unknown }> {
    const id = this.request(method, params);
    const frame = await this.queue.next();
    if (!isSuccess(frame)) {
      throw new Error(`期望成功响应，拿到：${JSON.stringify(frame)}`);
    }
    expectSameId(frame.id, id);
    return { id, result: frame.result };
  }

  /**
   * 握手。
   *
   * 凭证与语言按用例给；`clientInfo` 用固定值（宿主只做形状校验，不会拿它做判断）。
   */
  async hello(token: string, options: { language?: string } = {}): Promise<{ id: JsonRpcId; result: unknown }> {
    return await this.call("host.hello", {
      token,
      language: options.language,
      clientInfo: { name: "test", version: "0.0.0" },
    });
  }

  /** 等这条连接关闭 */
  async closed(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
    });
  }

  /** 主动断开并等它真的关掉 */
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = this.closed();
    this.socket.close();
    await closed;
  }
}

function expectSameId(actual: JsonRpcId, expected: JsonRpcId): void {
  if (actual !== expected) throw new Error(`响应 id 不对：期望 ${expected}，拿到 ${actual}`);
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/** 等一小会儿（断言「这段时间里没有帧」用） */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
