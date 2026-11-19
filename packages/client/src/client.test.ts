/**
 * `Client` 的验收：握手、调用、事件、镜像（打开 / 重连补回）、关闭。
 *
 * 全部跑在真 WebSocket 上（`testSupport/fakeHost.ts` 起的假宿主），所以被断言的是**线上**
 * 的形状：第一帧是不是 `host.hello`、凭证有没有混进 URL、`after` 有没有真的带出去。
 */

import { afterEach, describe, expect, it, expectTypeOf } from "vitest";

import type { ClientInfo, EventPayload, MethodResult } from "@ai-zen/agents-host";

import { Client, type SyncOutcome } from "./client.js";
import { ClientError } from "./errors.js";
import {
  assistantMessage,
  sessionState,
  FakeMethodError,
  helloResult,
  listed,
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
        "session.state": (params) => ({
          state: sessionState((params as { sessionId: string }).sessionId),
        }),
      },
    });
    const client = await connect(host);

    const version = await client.call("host.version");
    expect(version.pid).toBe(4242);

    const { state } = await client.call("session.state", { sessionId: "c1" });
    expect(state.sessionId).toBe("c1");

    const stateFrame = host.frames.find((frame) => frame.method === "session.state");
    expect(stateFrame?.params).toEqual({ sessionId: "c1" });
    // 无入参的方法发出去的帧里没有 params 这个键
    const versionFrame = host.frames.find((frame) => frame.method === "host.version");
    expect(versionFrame?.params).toBeUndefined();
  });

  it("业务错误原样传到 ClientError（不重写文案、不猜原因）", async () => {
    const host = await startFake({
      methods: {
        "session.get": () => {
          throw new FakeMethodError({
            code: "not_found",
            message: "这段会话不存在了",
            detail: { sessionId: "c1" },
          });
        },
      },
    });
    const client = await connect(host);

    const error = await client
      .call("session.get", { sessionId: "c1" })
      .catch((caught: unknown) => caught);
    expect((error as ClientError).code).toBe("not_found");
    expect((error as ClientError).message).toBe("这段会话不存在了");
    expect((error as ClientError).detail).toEqual({ sessionId: "c1" });
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

    const states: EventPayload<"state">[] = [];
    const deltas: EventPayload<"message.delta">[] = [];
    client.subscribe("state", (payload) => states.push(payload));
    client.subscribe("message.delta", (payload) => deltas.push(payload));

    host.push("state", { sessionId: "c1", status: "busy", at: "2026-01-01T00:00:01.000Z" });
    host.push("message.delta", {
      sessionId: "c1",
      messageId: "m1",
      delta: { content: "你" },
      at: "2026-01-01T00:00:02.000Z",
    });
    // 客户端不认识的事件名不该把连接弄坏
    host.push("some.future.event", { whatever: true });

    await waitFor(() => states.length === 1 && deltas.length === 1);
    expect(states[0]?.status).toBe("busy");
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
        sessionId: null,
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

describe("镜像：打开一段会话", () => {
  it("打开那一刻还没读到四件事：每一格都是 null", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const host = await startFake({
      methods: {
        "session.state": async (params) => {
          // 卡住这一跳：镜像已经进表、四件事还没读到
          await gate;
          return {
            state: sessionState((params as { sessionId: string }).sessionId),
          };
        },
        "message.list": () => listed("c1", []),
      },
    });
    const client = await connect(host);

    const opening = client.open("c1");
    await waitFor(() => host.frames.some((frame) => frame.method === "session.state"));

    // 还没读到：四件都没有值（不借「死」占位，也不借「闲」占位）
    const pending = client.mirror("c1");
    expect(pending?.snapshot()).toMatchObject({
      status: null,
      inputPaused: null,
      outputPaused: null,
      alive: null,
    });

    release();
    const mirror = await opening;
    // 拿到读数之后四件一次补齐（`fakeHost` 的缺省是「刚建出来、还没有 agent」那一份）
    expect(mirror.snapshot()).toMatchObject({
      status: "idle",
      inputPaused: false,
      outputPaused: false,
      alive: false,
    });
  });

  it("先读四件事、再拉全量，拉取期间到达的事件按顺序补上", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const host = await startFake({
      methods: {
        "session.state": (params) => ({
          state: sessionState((params as { sessionId: string }).sessionId),
        }),
        "message.list": async () => {
          // 卡住这一跳，好在「订阅之后、快照落地之前」这一段里推事件
          await gate;
          return listed("c1", [userMessage("m1", "问")]);
        },
      },
    });
    const client = await connect(host);

    const opening = client.open("c1");
    // 等到 message.list 已经发出去了，说明订阅那一步已经完成
    await waitFor(() => host.frames.some((frame) => frame.method === "message.list"));

    host.push("message.added", {
      sessionId: "c1",
      message: assistantMessage("m2", "答"),
      at: "2026-01-01T00:00:01.000Z",
    });
    host.push("message.delta", {
      sessionId: "c1",
      messageId: "m2",
      delta: { content: "到一半" },
      at: "2026-01-01T00:00:02.000Z",
    });
    host.push("state", { sessionId: "c1", status: "working", at: "2026-01-01T00:00:03.000Z" });
    host.push("output:paused", { sessionId: "c1", at: "2026-01-01T00:00:04.000Z" });
    release();

    const mirror = await opening;

    // 读数的现读值先到（idle），之后到达的事件比它新：忙闲留在 working、输出闸关着
    expect(mirror.snapshot()).toMatchObject({ status: "working", outputPaused: true });
    // 快照那一条 + 拉取期间新到的那一条，增量也折进去了
    expect(mirror.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(mirror.messages[1]?.content).toBe("答到一半");
    // 消息是整段拉的（没有 after）
    const frames = host.frames.filter((frame) => frame.method === "message.list");
    expect(frames[0]?.params).toEqual({ sessionId: "c1" });
    expect(client.mirror("c1")).toBe(mirror);
  });

  it("同一段会话开两次：只拉一次快照，第二次拿的是同一个镜像", async () => {
    const host = await startFake({
      methods: {
        "session.state": (params) => ({
          state: sessionState((params as { sessionId: string }).sessionId),
        }),
        "message.list": () => listed("c1", []),
      },
    });
    const client = await connect(host);

    const first = await client.open("c1");
    const second = await client.open("c1");
    expect(second).toBe(first);
    expect(host.frames.filter((frame) => frame.method === "message.list")).toHaveLength(1);
  });

  it("关掉镜像之后，那段的事件不再折进来", async () => {
    const host = await startFake({
      methods: {
        "session.state": (params) => ({
          state: sessionState((params as { sessionId: string }).sessionId),
        }),
        "message.list": () => listed("c1", []),
      },
    });
    const client = await connect(host);

    const mirror = await client.open("c1");
    client.closeMirror("c1");
    host.push("message.added", {
      sessionId: "c1",
      message: userMessage("m1", "问"),
      at: "2026-01-01T00:00:01.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mirror.messages).toEqual([]);
    expect(client.mirror("c1")).toBeUndefined();
  });
  it("`session.state` 的其余几格进镜像：名册铺栏、交接态非空即「正在交接」", async () => {
    const host = await startFake({
      methods: {
        "session.state": () => ({
          state: sessionState("c1", {
            // 活着、手上没活、输出闸关着：四件事必须各报各的
            status: "idle",
            outputPaused: true,
            alive: true,
            subAgents: [{ toolCallId: "call-1", name: "explore", state: "working" }],
            handoff: { since: "2026-01-01T00:00:05.000Z" },
          }),
        }),
        "message.list": () => listed("c1", []),
      },
    });
    const client = await connect(host);

    const mirror = await client.open("c1");
    expect(mirror.snapshot()).toMatchObject({
      status: "idle",
      outputPaused: true,
      alive: true,
    });
    // 名册那一条先把栏摆出来（内容之后靠事件长）
    expect(mirror.roster).toEqual([{ toolCallId: "call-1", name: "explore", state: "working" }]);
    expect(mirror.subAgent("call-1")).toEqual([]);
    // 非空就是「正在交接」（与那四件事分开：这段照旧有自己的忙闲与两道闸）
    expect(mirror.handoff).toEqual({ since: "2026-01-01T00:00:05.000Z" });

    // 之后到达的消息事件按 toolCallId 归进那一栏，**不调 message.list { toolCallId }**
    host.push("message.added", {
      sessionId: "c1",
      message: assistantMessage("s1", "subagent 说的话"),
      toolCallId: "call-1",
      at: "2026-01-01T00:00:06.000Z",
    });
    await waitFor(() => mirror.subAgent("call-1").length === 1);
    expect(mirror.messages).toEqual([]);
    expect(host.frames.some((frame) => frame.method === "message.list")).toBe(true);
    expect(
      host.frames.filter(
        (frame) =>
          frame.method === "message.list" &&
          (frame.params as { toolCallId?: string }).toolCallId !== undefined,
      ),
    ).toEqual([]);
  });

  it("`handoff_started` 直接进镜像那一格：不必重拉 `session.state`", async () => {
    const host = await startFake({
      methods: {
        "session.state": (params) => ({
          state: sessionState((params as { sessionId: string }).sessionId),
        }),
        "message.list": () => listed("c1", [userMessage("m1", "问")]),
      },
    });
    const client = await connect(host);
    const mirror = await client.open("c1");
    // 打开这一拍不在交接
    expect(mirror.handoff).toBeNull();

    host.push("session.changed", {
      sessionId: "c1",
      workspaceId: "w1",
      change: "handoff_started",
      at: "2026-01-01T00:00:07.000Z",
    });

    // 镜像那一格当场变（界面据此把输入框拦住、只留中断），不必等重拉读数
    await waitFor(() => mirror.handoff !== null);
    expect(mirror.handoff).toEqual({ since: "2026-01-01T00:00:07.000Z" });

    // 别的 kind（`renamed`）不动那一格：收口只认 `memory_replaced`
    host.push("session.changed", {
      sessionId: "c1",
      workspaceId: "w1",
      change: "renamed",
      at: "2026-01-01T00:00:08.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mirror.handoff).toEqual({ since: "2026-01-01T00:00:07.000Z" });

    // 这条事件只改镜像那一格：没有因此多拉一次读数，也没多拉一次消息
    expect(host.frames.filter((frame) => frame.method === "session.state")).toHaveLength(1);
    expect(host.frames.filter((frame) => frame.method === "message.list")).toHaveLength(1);
    expect(mirror.messages.map((message) => message.id)).toEqual(["m1"]);
  });

  it("`memory_replaced` 把交接态清回 null（不必等重拉的读数回来）", async () => {
    let stateCalls = 0;
    const host = await startFake({
      methods: {
        "session.state": (params) => {
          stateCalls += 1;
          // 首载那一读照常回；`memory_replaced` 之后的重拉卡住不回来（读数一直迟到）
          if (stateCalls > 1) return new Promise(() => undefined);
          return { state: sessionState((params as { sessionId: string }).sessionId) };
        },
        "message.list": () => listed("c1", []),
      },
    });
    const client = await connect(host);
    const mirror = await client.open("c1");

    host.push("session.changed", {
      sessionId: "c1",
      workspaceId: "w1",
      change: "handoff_started",
      at: "2026-01-01T00:00:07.000Z",
    });
    await waitFor(() => mirror.handoff !== null);

    host.push("session.changed", {
      sessionId: "c1",
      workspaceId: "w1",
      change: "memory_replaced",
      at: "2026-01-01T00:00:09.000Z",
    });

    // 收口这件事由事件本身说清：要么重拉的读数卡住，要么它的答案还是旧的，交接态都已经是 null
    await waitFor(() => mirror.handoff === null);
    // 重拉确实发起了（它只是还没把读数送回来）
    await waitFor(() => stateCalls === 2);
    expect(mirror.handoff).toBeNull();
  });

  it("`memory_replaced` → 全量整段替换镜像，顺带把「正在交接」收掉", async () => {
    // 这段记忆「换过之后」的样子，由假宿主在下面换掉
    let current = [userMessage("m1", "旧记忆里的那句")];
    let state = sessionState("c1", {
      subAgents: [],
      handoff: { since: "2026-01-01T00:00:05.000Z" },
    });
    const host = await startFake({
      methods: {
        "session.state": () => ({ state }),
        "message.list": () => listed("c1", current),
      },
    });
    const client = await connect(host);
    const mirror = await client.open("c1");
    expect(mirror.messages.map((message) => message.id)).toEqual(["m1"]);
    expect(mirror.handoff).not.toBeNull();

    // 交接收尾：记忆换过了 —— 旧的没了，交接期间那几条也不在库里
    current = [userMessage("m2", "换过之后的第一句")];
    state = sessionState("c1");
    host.push("session.changed", {
      sessionId: "c1",
      workspaceId: "w1",
      change: "memory_replaced",
      at: "2026-01-01T00:00:09.000Z",
    });

    await waitFor(() => mirror.messages.length === 1 && mirror.messages[0]?.id === "m2");
    expect(mirror.handoff).toBeNull();
    // 全量重拉（不带 after）：这是一次整段替换，不是续传
    const pulls = host.frames.filter((frame) => frame.method === "message.list");
    expect(pulls.at(-1)?.params).toEqual({ sessionId: "c1" });
  });

  it("`memory_replaced` 的重拉是「全量替换」而不是又一次首载：镜像还是同一个，栏也还在", async () => {
    // 这段记忆「换过之后」的样子
    let current = [userMessage("m1", "旧记忆里的那句")];
    const host = await startFake({
      methods: {
        "session.state": (params) => ({
          state: sessionState((params as { sessionId: string }).sessionId, {
            subAgents: [{ toolCallId: "call-1", name: "explore", state: "working" }],
          }),
        }),
        "message.list": () => listed("c1", current),
      },
    });
    const client = await connect(host);
    const mirror = await client.open("c1");

    // subagent 那一栏的内容只来自事件（不入库，重拉也拉不回来）
    host.push("message.added", {
      sessionId: "c1",
      message: assistantMessage("s1", "subagent 说的那句"),
      toolCallId: "call-1",
      at: "2026-01-01T00:00:06.000Z",
    });
    await waitFor(() => mirror.subAgent("call-1").length === 1);

    current = [userMessage("m2", "换过之后的第一句")];
    host.push("session.changed", {
      sessionId: "c1",
      workspaceId: "w1",
      change: "memory_replaced",
      at: "2026-01-01T00:00:09.000Z",
    });

    await waitFor(() => mirror.messages[0]?.id === "m2");
    // 全量替换沿用手上这一份（首载才建表）：换掉镜像对象的话，界面手里那份就停在旧样子上
    expect(client.mirror("c1")).toBe(mirror);
    // 主线整段换掉，subagent 那栏留在原处
    expect(mirror.messages.map((message) => message.id)).toEqual(["m2"]);
    expect(mirror.subAgent("call-1").map((message) => message.id)).toEqual(["s1"]);
  });

  it("首载拉不下来时不留半份镜像：表里没有它，再开一次是完整的首载", async () => {
    let fail = true;
    const host = await startFake({
      methods: {
        "session.state": (params) => ({
          state: sessionState((params as { sessionId: string }).sessionId),
        }),
        "message.list": () => {
          if (fail) throw new FakeMethodError({ code: "internal", message: "这一下拉不动" });
          return listed("c1", [userMessage("m1", "问")]);
        },
      },
    });
    const client = await connect(host);

    const error = await client.open("c1").catch((caught: unknown) => caught);
    expect((error as ClientError).code).toBe("internal");
    // 一个只有事件、没有历史的镜像比没有更糟：失败之后镜像表里不留它
    expect(client.mirror("c1")).toBeUndefined();

    fail = false;
    const mirror = await client.open("c1");
    expect(mirror.messages.map((message) => message.id)).toEqual(["m1"]);
  });

  it("别的 kind（`settings_changed`）不触发重拉", async () => {
    const host = await startFake({
      methods: {
        "session.state": (params) => ({
          state: sessionState((params as { sessionId: string }).sessionId),
        }),
        "message.list": () => listed("c1", [userMessage("m1", "问")]),
      },
    });
    const client = await connect(host);
    const mirror = await client.open("c1");

    host.push("session.changed", {
      sessionId: "c1",
      workspaceId: "w1",
      change: "renamed",
      at: "2026-01-01T00:00:09.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mirror.messages.map((message) => message.id)).toEqual(["m1"]);
    expect(host.frames.filter((frame) => frame.method === "message.list")).toHaveLength(1);
  });
});

describe("重连：把镜像补回来", () => {
  it("按本地最后一条 id 补：锚点还在 → 替换 + 追加", async () => {
    const host = await startFake({
      methods: {
        "session.state": (params) => ({
          state: sessionState((params as { sessionId: string }).sessionId),
        }),
        "message.list": (params) => {
          const query = params as { sessionId: string; after?: string };
          // 第一次是全量（打开），之后按 `after` 续传
          if (query.after === undefined) {
            return listed("c1", [userMessage("m1", "问"), assistantMessage("m2", "答到一半")]);
          }
          return listed(
            "c1",
            [assistantMessage("m2", "答完了"), userMessage("m3", "接着问")],
            query.after,
          );
        },
      },
    });
    const client = await connect(host);
    const outcomes: SyncOutcome[] = [];
    client.onSync((outcome) => outcomes.push(outcome));

    const mirror = await client.open("c1");
    expect(mirror.messages.map((message) => message.content)).toEqual(["问", "答到一半"]);

    let lost = 0;
    client.onClose(() => {
      lost += 1;
    });
    host.drop();
    await waitFor(() => lost === 1);

    await client.reconnect();

    const requests = host.frames.filter((frame) => frame.method === "message.list");
    expect(requests).toHaveLength(2);
    // 该 id 还在：交出去的就是它（含它自身的最新内容 + 之后全部）
    expect(requests[1]?.params).toEqual({ sessionId: "c1", after: "m2" });

    // 锚点那条是**替换**，不是又追加一条
    expect(mirror.messages.map((message) => message.content)).toEqual(["问", "答完了", "接着问"]);

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) expect(outcome.mirror).toBe(mirror);
  });

  it("锚点不在（宿主回 anchor: null）→ 服务端给的是全量，整段替换", async () => {
    const host = await startFake({
      methods: {
        "session.state": (params) => ({
          state: sessionState((params as { sessionId: string }).sessionId),
        }),
        "message.list": (params) => {
          const query = params as { sessionId: string; after?: string };
          if (query.after === undefined) return listed("c1", [userMessage("m1", "会被撤回的那条")]);
          return listed("c1", [userMessage("x1", "现在只剩这条")]);
        },
      },
    });
    const client = await connect(host);
    const mirror = await client.open("c1");
    expect(mirror.messages).toHaveLength(1);

    await client.resync("c1");
    expect(mirror.messages.map((message) => message.id)).toEqual(["x1"]);
  });

  it("本地一条都没有时 resync 不带 after：问的就是全量", async () => {
    const host = await startFake({
      methods: {
        "session.state": (params) => ({
          state: sessionState((params as { sessionId: string }).sessionId),
        }),
        "message.list": (params) => {
          const query = params as { sessionId: string; after?: string };
          // 本地没有可续的那一条，`after` 不该被交代出去
          return query.after === undefined
            ? listed("c1", [])
            : listed("c1", [userMessage("m9", "不该走这条")], query.after);
        },
      },
    });
    const client = await connect(host);
    const mirror = await client.open("c1");
    expect(mirror.messages).toEqual([]);

    await client.resync("c1");

    const pulls = host.frames.filter((frame) => frame.method === "message.list");
    expect(pulls).toHaveLength(2);
    expect(pulls[1]?.params).toEqual({ sessionId: "c1" });
    expect(mirror.messages).toEqual([]);
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

  it("补不回来（那段会话没了）报在 onSync 上，连接照旧可用", async () => {
    // 「gone」这段：打开时还在，重连时已经没了
    const seen = new Map<string, number>();
    const host = await startFake({
      methods: {
        "session.state": (params) => {
          const sessionId = (params as { sessionId: string }).sessionId;
          const times = (seen.get(sessionId) ?? 0) + 1;
          seen.set(sessionId, times);
          if (sessionId === "gone" && times > 1) {
            throw new FakeMethodError({ code: "not_found", message: "这段会话不存在了" });
          }
          return { state: sessionState(sessionId) };
        },
        "message.list": (params) =>
          listed((params as { sessionId: string }).sessionId, [userMessage("m1", "问")]),
      },
    });
    const client = await connect(host);
    const outcomes: SyncOutcome[] = [];
    client.onSync((outcome) => outcomes.push(outcome));

    // 两段都打开：一段重连时补得回来，另一段补不上
    await client.open("c1");
    await client.open("gone");

    await client.reconnect();

    expect(outcomes.map((outcome) => outcome.sessionId).sort()).toEqual(["c1", "gone"]);
    const failed = outcomes.find((outcome) => outcome.sessionId === "gone");
    expect(failed?.ok).toBe(false);
    if (failed && !failed.ok) expect(failed.error.code).toBe("not_found");
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
    // 事件名与载荷按 `EventMap` 收窄：`state` 的载荷里只有那一格
    client.subscribe("state", (payload) => {
      expectTypeOf(payload.status).toEqualTypeOf<import("@ai-zen/agents-host").SessionActivity>();
    });
    await client.close();
  });
});
