/**
 * `Client` 的验收：握手、调用、事件、重连补拉、关闭。
 *
 * 全部跑在真 WebSocket 上（`testSupport/fakeHost.ts` 起的假宿主），所以被断言的是**线上**
 * 的形状：第一帧是不是 `host.hello`、凭证有没有混进 URL、`after` 有没有真的带出去。
 */

import { afterEach, describe, expect, it, expectTypeOf } from "vitest";

import type { ClientInfo, EventPayload, MethodResult } from "@ai-zen/agents-host";

import { Client, type ResumeOutcome } from "./client.js";
import { ClientError } from "./errors.js";
import { mergeResumed } from "./resume.js";
import {
  assistantMessage,
  conversationState,
  FakeMethodError,
  helloResult,
  startFakeHost,
  userMessage,
  type FakeHost,
} from "./testSupport/fakeHost.js";

const CLIENT_INFO: ClientInfo = { name: "test-client", version: "0.0.0-test" };
const TOKEN = "test-token-6f1c8e2a7b394d60a0c4e7f1b8d23a69";

const hosts: FakeHost[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const host of hosts.splice(0)) await host.close();
});

async function startFake(methods: Parameters<typeof startFakeHost>[0] = {}): Promise<FakeHost> {
  const host = await startFakeHost(methods);
  hosts.push(host);
  return host;
}

async function connect(
  host: FakeHost,
  overrides: { token?: string; language?: string } = {},
): Promise<Client> {
  const client = await Client.connect({
    target: host.address,
    token: overrides.token ?? TOKEN,
    clientInfo: CLIENT_INFO,
    ...(overrides.language ? { language: overrides.language } : {}),
  });
  clients.push(client);
  return client;
}

/** 等某个条件成立（真 socket 的时序靠它对齐，不靠固定 sleep） */
async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等的事情没有在时限内发生");
}

describe("握手", () => {
  it("首帧是 host.hello：凭证在帧里，不在 URL 里", async () => {
    const host = await startFake();
    const client = await connect(host, { language: "zh" });

    const first = host.frames[0];
    expect(first?.method).toBe("host.hello");
    expect(first?.params).toMatchObject({
      token: TOKEN,
      language: "zh",
      clientInfo: { name: "test-client", version: "0.0.0-test" },
    });
    // 凭证不进查询串：那串会进日志、进程表与反向代理的访问记录
    expect(host.urls.some((url) => url.includes(TOKEN))).toBe(false);

    expect(client.connected).toBe(true);
    expect(client.hello).toEqual(helloResult());
    expect(client.language).toBe("en");
  });

  it("握手被拒时带上宿主渲染好的那句话与业务码", async () => {
    const host = await startFake({
      methods: {
        "host.hello": () => {
          throw new FakeMethodError({
            code: "unauthorized",
            message: "凭证没被接受",
            detail: { reason: "token_rejected" },
          });
        },
      },
    });

    const error = await Client.connect({
      target: host.address,
      token: "wrong",
      clientInfo: CLIENT_INFO,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClientError);
    const failure = error as ClientError;
    expect(failure.code).toBe("unauthorized");
    // 文案是宿主那一句，客户端不改写
    expect(failure.message).toBe("凭证没被接受");
    expect(failure.detail).toEqual({ reason: "token_rejected" });
    expect(failure.rpcCode).toBe(-32000);
    expect(failure.fromHost).toBe(true);
  });

  it("宿主一个字都不回时以握手超时收场", async () => {
    const host = await startFake({
      methods: {
        "host.hello": () => new Promise(() => undefined),
      },
    });

    const error = await Client.connect({
      target: host.address,
      token: TOKEN,
      clientInfo: CLIENT_INFO,
      connectTimeoutMs: 50,
    }).catch((caught: unknown) => caught);

    expect((error as ClientError).code).toBe("handshake_timeout");
    expect((error as ClientError).fromHost).toBe(false);
  });
});

describe("调用", () => {
  it("入参原样发出去，出参原样回来（无入参的方法可以省掉 params）", async () => {
    const host = await startFake({
      methods: {
        "host.version": () => ({
          version: "0.0.0-test",
          protocolVersion: "1",
          startedAt: "2026-01-01T00:00:00.000Z",
          pid: 4242,
        }),
        "conversation.state": (params) => ({
          state: conversationState((params as { conversationId: string }).conversationId),
        }),
      },
    });
    const client = await connect(host);

    const version = await client.call("host.version");
    expect(version.pid).toBe(4242);

    const { state } = await client.call("conversation.state", { conversationId: "c1" });
    expect(state.conversationId).toBe("c1");

    const stateFrame = host.frames.find((frame) => frame.method === "conversation.state");
    expect(stateFrame?.params).toEqual({ conversationId: "c1" });
    // 无入参的方法发出去的帧里没有 params 这个键
    const versionFrame = host.frames.find((frame) => frame.method === "host.version");
    expect(versionFrame?.params).toBeUndefined();
  });

  it("业务错误原样传到 ClientError（不重写文案、不猜原因）", async () => {
    const host = await startFake({
      methods: {
        "conversation.get": () => {
          throw new FakeMethodError({
            code: "not_found",
            message: "这段对话不存在了",
            detail: { conversationId: "c1" },
          });
        },
      },
    });
    const client = await connect(host);

    const error = await client
      .call("conversation.get", { conversationId: "c1" })
      .catch((caught: unknown) => caught);
    expect((error as ClientError).code).toBe("not_found");
    expect((error as ClientError).message).toBe("这段对话不存在了");
    expect((error as ClientError).detail).toEqual({ conversationId: "c1" });
  });

  it("等不到回执的调用以 call_timeout 收场", async () => {
    const host = await startFake({
      methods: { "config.get": () => new Promise(() => undefined) },
    });
    const client = await connect(host);

    const error = await client
      .call("config.get", {}, { timeoutMs: 50 })
      .catch((caught: unknown) => caught);
    expect((error as ClientError).code).toBe("call_timeout");
  });

  it("连接断了之后不再往旧连接上发方法", async () => {
    const host = await startFake();
    const client = await connect(host);
    host.drop();
    await waitFor(() => !client.connected);

    const error = await client.call("host.version").catch((caught: unknown) => caught);
    expect((error as ClientError).code).toBe("not_connected");
    expect((error as ClientError).message).toContain("host.version");
  });
});

describe("事件", () => {
  it("按事件名分派，载荷原样（形状由 EventMap 收窄）", async () => {
    const host = await startFake();
    const client = await connect(host);

    const states: EventPayload<"run.state">[] = [];
    const deltas: EventPayload<"message.delta">[] = [];
    client.subscribe("run.state", (payload) => states.push(payload));
    client.subscribe("message.delta", (payload) => deltas.push(payload));

    const run = conversationState("c1").run;
    host.push("run.state", { conversationId: "c1", run, at: "2026-01-01T00:00:01.000Z" });
    host.push("message.delta", {
      conversationId: "c1",
      messageId: "m1",
      seq: 0,
      delta: { content: "你" },
      at: "2026-01-01T00:00:02.000Z",
    });
    // 客户端不认识的事件名不该把连接弄坏
    host.push("some.future.event", { whatever: true });

    await waitFor(() => states.length === 1 && deltas.length === 1);
    expect(states[0]?.run.conversationId).toBe("c1");
    expect(deltas[0]?.delta.content).toBe("你");
    expect(client.connected).toBe(true);
  });

  it("一个监听器抛错不影响同事件的其它监听器", async () => {
    const host = await startFake();
    const client = await connect(host);

    const seen: string[] = [];
    client.subscribe("notice", () => {
      throw new Error("监听器自己炸了");
    });
    client.subscribe("notice", (payload) => seen.push(payload.notice.id));

    host.push("notice", {
      notice: {
        id: "n1",
        level: "info",
        text: "好",
        duration: null,
        conversationId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      at: "2026-01-01T00:00:03.000Z",
    });
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(["n1"]);
  });

  it("setLanguage 改的是这条连接，并记住给下一次重连用", async () => {
    const host = await startFake({
      methods: { "host.setLanguage": () => ({ language: "zh" }) },
    });
    const client = await connect(host, { language: "en" });

    expect(await client.setLanguage("zh")).toBe("zh");
    expect(client.language).toBe("zh");

    await client.reconnect();
    const hellos = host.frames.filter((frame) => frame.method === "host.hello");
    expect(hellos).toHaveLength(2);
    expect(hellos[1]?.params).toMatchObject({ language: "zh" });
  });
});

describe("重连补拉", () => {
  it("断线 → 重连 → 按 anchor 续传（宿主回了 anchor 就是续传）", async () => {
    const host = await startFake({
      methods: {
        "conversation.state": (params) => ({
          state: conversationState((params as { conversationId: string }).conversationId),
        }),
        "message.list": (params) => {
          const query = params as { conversationId: string; after?: string };
          return {
            conversationId: query.conversationId,
            anchor: query.after ?? null,
            messages: [assistantMessage("m2", "答完了"), userMessage("m3", "接着问")],
          };
        },
      },
    });
    const client = await connect(host);
    const outcomes: ResumeOutcome[] = [];
    client.onResume((outcome) => outcomes.push(outcome));
    client.track("c1", "m2");

    let lost = 0;
    client.onClose(() => {
      lost += 1;
    });
    host.drop();
    await waitFor(() => lost === 1);

    await client.reconnect();

    const listed = host.frames.filter((frame) => frame.method === "message.list");
    expect(listed).toHaveLength(1);
    // A12：`after` 带的是本地最后一条的 id（含自身最新内容）
    expect(listed[0]?.params).toEqual({ conversationId: "c1", after: "m2" });

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(outcome.resumed.mode).toBe("anchor");
      expect(outcome.resumed.anchor).toBe("m2");
      expect(outcome.resumed.state.conversationId).toBe("c1");
    }

    // 续传的拼法：anchor 那条**整体替换**（不是再追加一条）
    const local = [userMessage("m1", "问"), assistantMessage("m2", "答到一半")];
    const merged = mergeResumed(local, outcome?.ok ? outcome.resumed : ({} as never));
    expect(merged.map((message) => message.content)).toEqual(["问", "答完了", "接着问"]);
  });

  it("anchor 没命中（宿主回 null）→ 全量补，本地整份换掉", async () => {
    const host = await startFake({
      methods: {
        "conversation.state": (params) => ({
          state: conversationState((params as { conversationId: string }).conversationId),
        }),
        "message.list": () => ({
          conversationId: "c1",
          anchor: null,
          messages: [userMessage("x1", "新的一段")],
        }),
      },
    });
    const client = await connect(host);
    const outcomes: ResumeOutcome[] = [];
    client.onResume((outcome) => outcomes.push(outcome));
    client.track("c1", "已删除的那条");

    await client.reconnect();

    const outcome = outcomes[0];
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(outcome.resumed.mode).toBe("full");
      expect(outcome.resumed.anchor).toBeNull();
      expect(mergeResumed([userMessage("old", "旧的")], outcome.resumed)).toHaveLength(1);
    }
  });

  it("两个调用方同时重连：只连一次（第二次拿的是同一条结果）", async () => {
    const host = await startFake();
    const client = await connect(host);
    host.drop();
    await waitFor(() => !client.connected);

    await Promise.all([client.reconnect(), client.reconnect()]);

    const hellos = host.frames.filter((frame) => frame.method === "host.hello");
    expect(hellos).toHaveLength(2); // 首次一条 + 重连一条
    expect(client.connected).toBe(true);
  });

  it("补拉失败（那段对话没了）报在 onResume 上，连接照旧可用", async () => {
    const host = await startFake({
      methods: {
        "conversation.state": () => {
          throw new FakeMethodError({ code: "not_found", message: "这段对话不存在了" });
        },
      },
    });
    const client = await connect(host);
    const outcomes: ResumeOutcome[] = [];
    client.onResume((outcome) => outcomes.push(outcome));
    client.track("gone");

    await client.reconnect();

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) {
      expect(outcome.conversationId).toBe("gone");
      expect(outcome.error.code).toBe("not_found");
    }
    expect(client.connected).toBe(true);
  });
});

describe("关闭", () => {
  it("close 之后 call 报 closed，且不再重连", async () => {
    const host = await startFake();
    const client = await connect(host);
    await client.close();

    expect(client.connected).toBe(false);
    const error = await client.call("host.version").catch((caught: unknown) => caught);
    expect((error as ClientError).code).toBe("closed");

    const reconnectError = await client.reconnect().catch((caught: unknown) => caught);
    expect((reconnectError as ClientError).code).toBe("closed");
  });
});

describe("类型（编译期）", () => {
  it("call 的出入参、subscribe 的载荷都由契约推出来", async () => {
    const host = await startFake();
    const client = await connect(host);

    expectTypeOf(client.call).parameter(0).toEqualTypeOf<Parameters<Client["call"]>[0]>();
    // 方法名的字面量联合来自 `MethodMap`：写错名字编译不过
    expectTypeOf<Awaited<ReturnType<typeof client.call<"host.version">>>>().toEqualTypeOf<
      MethodResult<"host.version">
    >();
    // 事件名与载荷按 `EventMap` 收窄：`run.state` 的载荷里没有 `delta`
    client.subscribe("run.state", (payload) => {
      expectTypeOf(payload.run.conversationId).toEqualTypeOf<string>();
    });
    await client.close();
  });
});
