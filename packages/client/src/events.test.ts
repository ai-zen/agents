/**
 * 客户端 ↔ 服务端的**事件线**端到端：真 socket、真帧、假 Agent。
 *
 * 这里不测业务（服务端包里有 16 例管着），只证明一件事：`SocketServerClient.on()` 收得到
 * 服务端推过来的事件，且 `ServerClient` 端口的事件名是编译期可查的。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Daemon,
  createSessionHandlers,
  EventHub,
  SessionManager,
  AGENT_EVENTS,
  SESSION_EVENTS,
  SERVER_EVENTS,
  EVENT_METHODS,
  SESSION_METHODS,
  type AgentLike,
  type ModelLevel,
  type ServerEvent,
} from "@ai-zen/agents-server";
import { SocketServerClient } from "./socket-server-client.js";
import type { ClientInfo } from "./types.js";

class FakeAgent implements AgentLike {
  messages: any[] = [];
  /** 三级解析的档位（真件由 SDK 的 `createAgent` 给；假件照抄这一位） */
  modelLevel: ModelLevel = "agent";
  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  readonly events = {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      this.handlers.get(event)?.delete(handler);
    },
  };
  send(): Promise<void> {
    return Promise.resolve();
  }
  abort(): void {}
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

const clientInfo: ClientInfo = { name: "@ai-zen/cli", version: "0.0.0-test" };

let dir: string;
let daemon: Daemon | null = null;
let manager: SessionManager | null = null;
/** 与会话管理器共用的出口：全局通知也要从同一条线出去 */
let hub: EventHub;
let agent: FakeAgent;
let connection: SocketServerClient | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-cli-events-"));
  agent = new FakeAgent();
  hub = new EventHub();
  manager = new SessionManager({ createAgent: async () => agent, hub });
});

afterEach(async () => {
  connection?.close();
  connection = null;
  manager?.dispose();
  manager = null;
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<SocketServerClient> {
  daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: createSessionHandlers({
      manager: manager!,
      workspacesRoot: join(dir, "workspaces"),
      // 这几个用例总带 path，默认工作区用不上；给一个合法值即可
      defaultWorkspacePath: dir,
    }),
  });
  await daemon.start();
  connection = await SocketServerClient.connect({
    address: { host: "127.0.0.1", port: daemon.port },
    client: clientInfo,
  });
  return connection;
}

/** 等到某个事件出现（事件是推的，没有"等这一帧"的 API） */
async function waitFor(received: ServerEvent[], name: string, count = 1): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (received.filter((event) => event.event === name).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${count}× ${name}, got ${JSON.stringify(received)}`);
}

describe("SocketServerClient.on（服务端推的事件）", () => {
  it("watch 之后收得到阶段 / 原始片 / 轮次收尾", async () => {
    const client = await start();
    const received: ServerEvent[] = [];
    client.on(SESSION_EVENTS.phase, (event) => received.push(event));
    client.on(AGENT_EVENTS.chunk, (event) => received.push(event));
    client.on(SESSION_EVENTS.turnEnd, (event) => received.push(event));

    await client.call(EVENT_METHODS.watch);
    const created = await client.call<{ sessionId: string }>(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    });
    await client.call(SESSION_METHODS.send, { sessionId: created.sessionId, content: "你好" });

    const piece = { choices: [{ delta: { content: "答" } }] };
    agent.fire("open");
    // 原始片原样上线；core 的解析那一步（`chunk-parsed`）不推增量 —— 客户端自己折这一份
    agent.fire("chunk", piece);
    agent.fire("chunk-parsed", {}, piece);
    agent.fire("finally");
    await waitFor(received, SESSION_EVENTS.turnEnd);

    const kinds = received
      .filter((event) => event.event === SESSION_EVENTS.phase)
      .map((event) => (event as { phase: { kind?: string } | null }).phase?.kind ?? null);
    expect(kinds).toEqual(["connecting", "queued", "streaming", null]);

    const pieces = received.filter((event) => event.event === AGENT_EVENTS.chunk);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ chunk: piece, turnId: 1 });
    // 摘一份增量出来的那条事件已经不在协议里：线上一条都不该出现
    expect(received.map((event) => event.event as string)).not.toContain("chunk-parsed");

    const ends = received.filter((event) => event.event === SESSION_EVENTS.turnEnd);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ ok: true, sessionId: created.sessionId, turnId: 1 });
  });

  it("取消订阅之后不再收到事件", async () => {
    const client = await start();
    const received: ServerEvent[] = [];
    const off = client.on(SESSION_EVENTS.phase, (event) => received.push(event));

    await client.call(EVENT_METHODS.watch);
    const created = await client.call<{ sessionId: string }>(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    });
    await client.call(SESSION_METHODS.send, { sessionId: created.sessionId, content: "x" });
    await waitFor(received, SESSION_EVENTS.phase);

    off();
    const before = received.length;
    agent.fire("open");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received.length).toBe(before);
  });

  it("没订阅时事件不会把连接搞坏（后续调用照常）", async () => {
    const client = await start();
    const created = await client.call<{ sessionId: string }>(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    });
    await client.call(SESSION_METHODS.send, { sessionId: created.sessionId, content: "x" });
    agent.fire("open");
    agent.fire("finally");

    expect(await client.call("ping")).toEqual({ pong: true });
  });
});

describe("两个通知通道", () => {
  it("对话内通知与全局通知都能收到，形状可区分（一个有 sessionId，一个没有）", async () => {
    const client = await start();
    const notices: ServerEvent[] = [];
    client.on(SESSION_EVENTS.notice, (event) => notices.push(event));
    client.on(SERVER_EVENTS.notice, (event) => notices.push(event));

    await client.call(EVENT_METHODS.watch);
    const created = await client.call<{ sessionId: string }>(SESSION_METHODS.create, {
      workspaceId: "ws-1",
      path: dir,
    });

    manager!.notice(created.sessionId, { level: "error", code: "persistFailed" });
    hub.publish({ event: SERVER_EVENTS.notice, level: "warn", code: "mcpUnavailable" });

    for (let i = 0; i < 100 && notices.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(notices[0]).toMatchObject({
      event: "session-notice",
      sessionId: created.sessionId,
      level: "error",
      code: "persistFailed",
    });
    expect(notices[1]).toMatchObject({
      event: "server-notice",
      level: "warn",
      code: "mcpUnavailable",
    });
    expect(notices[1]).not.toHaveProperty("sessionId");
  });
});
