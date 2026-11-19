/**
 * 用例用的**假宿主**：真 WebSocket、真 JSON-RPC，方法按脚本答。
 *
 * ## 为什么手写一段帧编解码，而不是装 `ws`
 *
 * 本包运行期不依赖 `ws`（客户端用 Node 内建的全局 `WebSocket`），而为了一条用例把它拖进依赖表
 * 不值。这里只实现用到的那部分：升级握手（`Sec-WebSocket-Accept`）+ 文本帧的收发。不处理分片、
 * 不协商扩展、收到关闭帧就 `end()`。
 *
 * ## 它能做真宿主做不到的几件事
 *
 *   · 握手被拒（真宿主只认它自己的凭证，但拒的理由和时机由它决定）；
 *   · 一个字都不回（握手超时、调用超时这两条路）；
 *   · 中途把连接掐掉（断线 → 重连 → 补镜像那条链）；
 *   · 按需推事件（`message.delta` 这类只有真跑起来才会有的推送）。
 *
 * 夹具（`helloResult` / `sessionState` / `assistantMessage`）用的都是**契约里的类型**：
 * 宿主改了形状而这里没跟上时，`tsc` 会先报错。
 */

import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { Socket } from "node:net";

import { AgentNS } from "@ai-zen/agents-core";
import type {
  AgentNS as AgentNSTypes,
  SessionState,
  HostHelloResult,
  MessageListResult,
} from "@ai-zen/agents-host";

/** 一条入站消息（`opcode` 1 = 文本） */
export interface FakeMessage {
  opcode: number;
  data: Buffer;
}

/** 客户端发来的一帧（JSON-RPC） */
export interface FakeFrame {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
}

/** 让假宿主回一条业务错误帧 */
export class FakeMethodError extends Error {
  constructor(readonly payload: { code: string; message: string; detail?: unknown }) {
    super(payload.message);
  }
}

/** 假宿主的答复脚本：按方法名给结果，抛 `FakeMethodError` 就回错误帧 */
export interface FakeHostOptions {
  /** 方法名 → 结果；不给 `host.hello` 时用 {@link helloResult} 的缺省值 */
  methods?: Record<string, (params: unknown) => unknown>;
  /** 每收到一帧都看一眼（断言顺序、记录参数） */
  onFrame?: (frame: FakeFrame) => void;
}

export interface FakeHost {
  address: { host: string; port: number };
  /** 按到达顺序记下的全部入站消息（含 `hello`） */
  messages: FakeMessage[];
  /** 入站帧（解析过的，按到达顺序） */
  frames: FakeFrame[];
  /** 每次升级握手请求的 URL（用来断言凭证没有混进查询串） */
  urls: string[];
  /** 推一条通知给所有活着的连接（事件就这么来） */
  push(event: string, params: unknown): void;
  /** 掐断所有连接（模拟宿主没了 / 网络断了） */
  drop(): void;
  /** 现在还有几条连接 */
  connections(): number;
  close(): Promise<void>;
}

/** 起一个只会说 WebSocket 的假宿主 */
export async function startFakeHost(options: FakeHostOptions = {}): Promise<FakeHost> {
  const messages: FakeMessage[] = [];
  const frames: FakeFrame[] = [];
  const urls: string[] = [];
  const sockets = new Set<Socket>();

  const methods: Record<string, (params: unknown) => unknown> = {
    "host.hello": () => helloResult(),
    ...options.methods,
  };

  const host: HttpServer = createHttpServer((_request, response) => {
    response.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
    response.end("this endpoint speaks WebSocket only\n");
  });

  host.on("upgrade", (request, socket: Socket) => {
    urls.push(request.url ?? "");
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
        // 关闭帧：这一条连接到此为止（假宿主不陪它演完整的关闭握手）
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        messages.push({ opcode: frame.opcode, data: frame.payload });
        if (frame.opcode !== 0x1) continue;

        const parsed = parseFrame(frame.payload.toString("utf8"));
        if (!parsed) continue;
        frames.push(parsed);
        options.onFrame?.(parsed);
        // 不 await：假宿主也允许「挂住不回」（握手超时与调用超时那两条路要用它）
        void answer(parsed, methods, (value) => writeTextFrame(socket, JSON.stringify(value)));
      }
    });
  });

  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", () => resolve()));
  const port = (host.address() as { port: number }).port;

  return {
    address: { host: "127.0.0.1", port },
    messages,
    frames,
    urls,
    push: (event, params) => {
      const text = JSON.stringify({ jsonrpc: "2.0", method: event, params });
      for (const socket of sockets) writeTextFrame(socket, text);
    },
    drop: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    connections: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => host.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// 夹具（都用契约类型，形状漂了 tsc 会先叫）
// ---------------------------------------------------------------------------

/** 一份 `host.hello` 的出参 */
export function helloResult(overrides: Partial<HostHelloResult> = {}): HostHelloResult {
  return {
    language: "en",
    hostVersion: "0.0.0-test",
    protocolVersion: "1",
    startedAt: "2026-01-01T00:00:00.000Z",
    limits: { maxAssetBytes: 20 * 1024 * 1024, maxAssetsPerMessage: 4 },
    ...overrides,
  };
}

/**
 * 一份 `session.state` 的 `state`：一段会话此刻的读数 = **四件事各一格** + 队里还压着什么 +
 * subagent 名册 + 交接态 + 读数的时刻。
 *
 * 默认摆的是「刚建出来、还没有 agent」那一份：忙闲 `idle`（没有人，手上当然没活）、两道闸都
 * 没关着、`alive: false`。要摆别的处境就在 `overrides` 里给那几格。
 *
 * 这里**没有**用量、没有「请求中 / 思考中 / 输出中」这类阶段：用量在每条消息的 `usage` 上，
 * 阶段由客户端按到达的事件自己推。
 */
export function sessionState(
  sessionId: string,
  overrides: Partial<SessionState> = {},
): SessionState {
  return {
    sessionId,
    status: "idle",
    inputPaused: false,
    outputPaused: false,
    alive: false,
    // 空闲时队里没有东西（契约：空闲是空数组，不是「未知」）
    inbox: [],
    // 名册与交接态都是现读：默认没有 subagent、不在交接
    subAgents: [],
    handoff: null,
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** 一条 `message.list` 的回执：`anchor` 是命中的那条（没命中 / 没给 `after` 就是 `null`） */
export function listed(
  sessionId: string,
  messages: AgentNSTypes.Message[],
  anchor: string | null = null,
): MessageListResult {
  return { sessionId, anchor, messages };
}

/** 一条 assistant 消息（`AgentNS.Message` 原样，不包外壳） */
export function assistantMessage(id: string, content: string): AgentNSTypes.Message {
  // 角色与状态是 core 的运行期枚举，不另写一份字面量（两个定义迟早对不上）
  return { id, role: AgentNS.Role.Assistant, status: AgentNS.MessageStatus.Writing, content };
}

/** 一条 user 消息 */
export function userMessage(id: string, content: string): AgentNSTypes.Message {
  return { id, role: AgentNS.Role.User, status: AgentNS.MessageStatus.Completed, content };
}

/** 一条成功响应 */
export function okFrame(id: number | string, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

/** 一条业务错误响应（`data.code` 是稳定业务码，`data.message` 是渲染好的那句话） */
export function errorFrame(
  id: number | string | null,
  payload: { code: string; message: string; detail?: unknown },
): unknown {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: payload.message,
      data: {
        code: payload.code,
        message: payload.message,
        ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
        params: {},
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 内部：一条请求怎么答
// ---------------------------------------------------------------------------

async function answer(
  frame: FakeFrame,
  methods: Record<string, (params: unknown) => unknown>,
  reply: (value: unknown) => void,
): Promise<void> {
  const id = frame.id ?? null;
  const method = frame.method;
  if (method === undefined) return;

  const handler = methods[method];
  if (!handler) {
    reply(
      errorFrame(id, {
        code: "unsupported",
        message: `no such method: ${method}`,
        detail: { method },
      }),
    );
    return;
  }
  try {
    // 结果可以是一个 promise（模拟真实宿主的异步方法）；挂住不落定的那个就是「不回话」
    reply(okFrame(id ?? 0, await handler(frame.params)));
  } catch (error) {
    if (error instanceof FakeMethodError) {
      reply(errorFrame(id, error.payload));
      return;
    }
    reply(errorFrame(id, { code: "internal", message: String(error) }));
  }
}

function parseFrame(text: string): FakeFrame | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null) return null;
    return value as FakeFrame;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 内部：最小的 WebSocket 帧编解码
// ---------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** `Sec-WebSocket-Accept = base64(sha1(key + GUID))` */
function acceptKey(key: string): string {
  return createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
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
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { opcode, payload, consumed: offset + length };
}

/** 写一条文本帧（宿主 → 客户端的方向**不加掩码**） */
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
