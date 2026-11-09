/**
 * 会话处理器 —— 走真 socket 的接线测试。
 *
 * 业务逻辑在 `SessionManager.test.ts` 里用假 Agent 测透了；这里只证明一件事：
 * **事件真的能从服务端推过连接**，以及参数错会原样回给客户端。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "./Daemon.js";
import { createSessionHandlers } from "./sessionHandlers.js";
import { SessionManager, type SessionAgent } from "../service/session/SessionManager.js";
import { encodeFrame, FrameDecoder } from "../protocol/frames.js";
import { PROTOCOL_VERSION } from "../protocol/messages.js";
import { SESSION_METHODS } from "../protocol/sessions.js";

class FakeAgent implements SessionAgent {
  messages: unknown[] = [];
  sent: string[] = [];
  aborted = 0;
  private readonly handlers = new Map<string, Set<(payload: any) => void>>();
  readonly events = {
    on: (event: string, handler: (payload: any) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (payload: any) => void) => {
      this.handlers.get(event)?.delete(handler);
    },
  };
  send(input: string): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }
  abort(): void {
    this.aborted++;
  }
  fire(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

let dir: string;
let daemon: Daemon | null = null;
let agent: FakeAgent;
let manager: SessionManager;
let client: TestClient | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-session-handlers-"));
  agent = new FakeAgent();
  manager = new SessionManager({ createAgent: async () => agent });
});

afterEach(async () => {
  client?.close();
  client = null;
  manager.dispose();
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function startDaemon(): Promise<void> {
  const instance = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.1.0-test",
    handlers: createSessionHandlers({ manager, workspacesRoot: join(dir, "workspaces") }),
  });
  await instance.start();
  daemon = instance;
  client = await TestClient.connect(instance.port);
  await client.handshake();
}

describe("会话处理器（真 socket）", () => {
  it("workspace.resolve 建目录并回 workspaceId", async () => {
    await startDaemon();
    const result = await client!.call(SESSION_METHODS.workspaceResolve, { path: "/work/proj-a" });
    expect(result).toMatchObject({ path: "/work/proj-a" });
    expect((result as { workspaceId: string }).workspaceId).toMatch(/^proj-a-[0-9a-f]{8}$/);
  });

  it("参数缺失 → bad-params 错误帧（不是崩掉连接）", async () => {
    await startDaemon();
    await expect(client!.call(SESSION_METHODS.workspaceResolve, {})).rejects.toThrow(/bad-params/);
    // 连接还能继续用
    expect(await client!.call("ping")).toEqual({ pong: true });
  });

  it("watch 之后：create / send 的进展以事件帧推到这条连接上", async () => {
    await startDaemon();
    await client!.call(SESSION_METHODS.watch);

    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: "/work/proj-a",
    })) as { sessionId: string; agentId: string };
    expect(created.agentId).toBe("default");

    const sent = (await client!.call(SESSION_METHODS.send, {
      sessionId: created.sessionId,
      content: "你好",
    })) as { turnId: number };
    expect(sent.turnId).toBe(1);
    expect(agent.sent).toEqual(["你好"]);

    // send 当下就会有一条 phase（connecting）
    expect(await client!.next()).toMatchObject({
      event: "session.phase",
      sessionId: created.sessionId,
      turnId: 1,
      phase: { kind: "connecting" },
    });

    // 正文增量与轮次收尾
    agent.fire("chunk-parsed", { choices: [{ delta: { content: "答" } }] });
    const phaseAfterDelta = (await client!.next()) as any;
    expect(phaseAfterDelta).toMatchObject({ event: "session.phase", phase: { kind: "streaming" } });
    expect(await client!.next()).toMatchObject({ event: "message.delta", text: "答" });

    agent.fire("finally");
    const phaseReset = (await client!.next()) as any;
    expect(phaseReset.phase).toBeNull();
    expect(await client!.next()).toMatchObject({ event: "turn.end", ok: true, turnId: 1 });
  });

  it("session.list 报出活着的会话与当前阶段", async () => {
    await startDaemon();
    const created = (await client!.call(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: "/p",
    })) as { sessionId: string };
    await client!.call(SESSION_METHODS.send, { sessionId: created.sessionId, content: "hi" });

    const listed = (await client!.call(SESSION_METHODS.list)) as { sessions: any[] };
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({
      sessionId: created.sessionId,
      workspaceId: "ws-1",
      turnId: 1,
      phase: { kind: "connecting" },
    });
  });

  it("未知会话 → unknown-session 错误帧；cancel 未知会话回 false（不是错）", async () => {
    await startDaemon();
    await expect(
      client!.call(SESSION_METHODS.send, { sessionId: "sess_404", content: "x" }),
    ).rejects.toThrow(/unknown-session/);

    expect(await client!.call(SESSION_METHODS.cancel, { sessionId: "sess_404" })).toEqual({
      cancelled: false,
    });
  });
});

/** 最小握手客户端：只做这一层要用的「发一帧、等一帧」 */
class TestClient {
  private inbox: unknown[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  private nextRequestId = 1;

  private constructor(private readonly socket: Socket, private readonly decoder: FrameDecoder) {}

  static async connect(port: number): Promise<TestClient> {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setEncoding("utf-8");
    const instance = new TestClient(socket, new FrameDecoder());
    socket.on("data", (chunk: string) => {
      for (const frame of instance.decoder.push(chunk)) instance.inbox.push(frame);
      instance.wake();
    });
    socket.on("close", () => {
      instance.closed = true;
      instance.wake();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    return instance;
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async next(): Promise<unknown> {
    while (this.inbox.length === 0) {
      if (this.closed) throw new Error("connection closed while waiting for a frame");
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.inbox.shift();
  }

  async handshake(): Promise<void> {
    this.socket.write(
      encodeFrame({ kind: "hello", protocol: PROTOCOL_VERSION, client: { name: "test", version: "0" } }),
    );
    expect(await this.next()).toMatchObject({ kind: "hello", ok: true });
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    this.socket.write(encodeFrame({ id, method, params }));
    // 事件帧没有 id：它们可能比响应**先**到（如 send 里先推 phase 再回执），
    // 所以不是丢掉，而是原样塞回队列，等调用方用 next() 按序取
    const skipped: unknown[] = [];
    try {
      for (;;) {
        const frame = await this.next();
        if ((frame as any)?.id !== id) {
          skipped.push(frame);
          continue;
        }
        if ((frame as any).ok) return (frame as any).result;
        throw new Error(`${(frame as any).error.code}: ${(frame as any).error.message}`);
      }
    } finally {
      this.inbox.unshift(...skipped);
    }
  }

  close(): void {
    this.socket.destroy();
  }
}
