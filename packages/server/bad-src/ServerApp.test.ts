/**
 * `ServerApp` 的用例：**进程作用域的状态与方法**，以及那套全局通知槽位。
 *
 * 三组：
 *
 * 1. **槽位本身**（不启传输）：登记 / 列表 / 确认即消，以及「存与播是同一个入口」；
 * 2. **两个作用域不串台**：全局通知进 `notice.list`，会话内通知只挂在自己的会话上；
 * 3. **生命周期**：`start()` 写发现文件、`stop()` 按顺序收摊（停会话 → flush → 删发现文件
 *    → 退出），并且可重复调用。
 *
 * 第 2、3 组走真 WebSocket（`WsTestClient`）：`notice.*` 是线上方法，只测对象内部等于没测
 * 「客户端到底能不能确认掉那条通知」。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerApp } from "./ServerApp.js";
import { WsTestClient } from "./daemon/WsTestClientTestSupport.js";
import { SessionManager } from "./domain/session/SessionManager.js";
import { FakeAgent } from "./domain/session/SessionTestSupport.js";
import { EventHub } from "./lib/events.js";
import type { ServerEvent } from "./protocol/index.js";
import { readDescriptor } from "./wire/discovery.js";
import { readToken, tokenPath } from "./wire/token.js";

let dir: string;
let agent: FakeAgent;
let hub: EventHub;
let sessions: SessionManager;
let app: ServerApp | null;
let client: WsTestClient | null;
let exits: number[];
let logs: string[];
/** 会话 id 序号（确定性：用例断言的是「哪个是哪个」，不是时间戳） */
let sessionSeq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-server-app-"));
  agent = new FakeAgent();
  hub = new EventHub();
  sessionSeq = 0;
  sessions = new SessionManager({
    hub,
    createAgent: async () => agent,
    nextSessionId: () => `chat_app_${++sessionSeq}`,
    handoff: { aiZenDir: dir, homeDir: dir },
  });
  app = null;
  client = null;
  exits = [];
  logs = [];
});

afterEach(async () => {
  client?.close();
  client = null;
  if (app) {
    await app.stop("test teardown");
    app = null;
  }
  sessions.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** 造一个 `ServerApp`：协作者全部注入（本组用例不碰真配置与真 Agent） */
function makeApp(): ServerApp {
  return new ServerApp({
    aiZenDir: dir,
    homeDir: dir,
    defaultWorkspacePath: dir,
    hub,
    sessions,
    log: (level, message) => logs.push(`${level}: ${message}`),
    // 用例里不该真把测试进程杀掉
    exit: (code) => exits.push(code),
    // 固定的登记时刻：`createdAt` 是可断言的事实，不该是「跑用例的那一刻」
    now: () => "2026-01-01T00:00:00.000Z",
  });
}

/**
 * 连一个客户端。
 *
 * 凭证从 `ServerApp` **自己写出来的那个文件**读：`ServerApp` 不接注入的 token（凭证的
 * 所有权在 `Daemon` 那一层，本类只是把路径写进日志），所以这里走它默认的那条真实路径。
 */
async function connectTo(port: number): Promise<WsTestClient> {
  return await WsTestClient.connect(port, (await readToken(dir)) ?? undefined);
}

/** 起服务并连上一个客户端（`notice.*` 是线上方法，得走真协议） */
async function startApp(): Promise<WsTestClient> {
  app = makeApp();
  await app.start();
  client = await connectTo(app.port);
  await client.handshake();
  return client;
}

describe("全局通知槽位：登记 / 查询 / 确认即消（不启传输）", () => {
  it("登记之后在表里；id 是 UUID、带上 level / code / params 与登记时刻", () => {
    app = makeApp();
    const slot = app.publishNotice({
      level: "warn",
      code: "mcpUnavailable",
      params: { server: "filesystem" },
    });

    expect(slot.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(slot.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(app.listNotices()).toEqual({
      notices: [
        {
          id: slot.id,
          level: "warn",
          code: "mcpUnavailable",
          params: { server: "filesystem" },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("**存与播是同一个入口**：登记时顺手广播一条 `server-notice`（此刻没人在听也不影响槽位）", () => {
    app = makeApp();
    const seen: ServerEvent[] = [];
    // 一个订阅者都没有：槽位照样登记（广播只是「顺手通知一声」）
    expect(hub.watcherCount()).toBe(0);
    const slot = app.publishNotice({ level: "error", code: "storeUnavailable" });
    expect(app.listNotices().notices).toHaveLength(1);

    hub.subscribe((event) => seen.push(event));
    const second = app.publishNotice({ level: "info", code: "mcpUnavailable" });
    // 播出去的那条带**槽位的同一个 id**（A35）：客户端收到通知就能直接 `notice.ack`
    expect(seen).toEqual([
      { event: "server-notice", id: second.id, level: "info", code: "mcpUnavailable" },
    ]);
    // 两条都在表里（第一条登记时没人听，但它没丢）
    expect(app.listNotices().notices.map((notice) => notice.id)).toEqual([slot.id, second.id]);
  });

  it("确认即消：一份状态，任意客户端确认就没了；重复确认 / 不认识的 id 不出现在 acked 里", () => {
    app = makeApp();
    const kept = app.publishNotice({ level: "info", code: "mcpUnavailable" });
    const acked = app.publishNotice({ level: "info", code: "storeUnavailable" });

    // 混着「已存在」与「根本不存在」的 id：只有真正消掉的那些回来
    expect(app.ackNotices([acked.id, "nope"])).toEqual({ acked: [acked.id] });
    expect(app.listNotices().notices.map((notice) => notice.id)).toEqual([kept.id]);
    // 第二个来确认的客户端：结果一样是「不在了」，但不算他消的
    expect(app.ackNotices([acked.id])).toEqual({ acked: [] });
    expect(app.ackNotices([])).toEqual({ acked: [] });
  });

  it("list 返回副本：调用方拿到的东西改不到槽位表", () => {
    app = makeApp();
    app.publishNotice({ level: "info", code: "mcpUnavailable" });
    const listed = app.listNotices();
    listed.notices[0]!.level = "error";
    listed.notices.pop();
    expect(app.listNotices().notices).toHaveLength(1);
    expect(app.listNotices().notices[0]!.level).toBe("info");
  });
});

describe("notice.list / notice.ack（真 WebSocket）", () => {
  it("没人看时登记的通知，后来的客户端在 notice.list 里看得见；确认一次之后谁都看不到了", async () => {
    app = makeApp();
    const slot = app.publishNotice({
      level: "warn",
      code: "mcpUnavailable",
      params: { server: "filesystem" },
    });
    // 登记时一个客户端都没有（服务刚起来 / 人不在同一条连接上）
    expect(hub.watcherCount()).toBe(0);

    await app.start();
    const first = await connectTo(app.port);
    client = first;
    await first.handshake();
    expect(await first.call("notice.list")).toEqual({
      notices: [
        {
          id: slot.id,
          level: "warn",
          code: "mcpUnavailable",
          params: { server: "filesystem" },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    // 另一个客户端同时看着：它也能看到同一条（一份状态，不是每个客户端各一份）
    const second = await connectTo(app.port);
    await second.handshake();
    expect((await second.call("notice.list")).notices).toHaveLength(1);

    // 第一个客户端确认掉：任意客户端确认即消
    expect(await first.call("notice.ack", { ids: [slot.id] })).toEqual({ acked: [slot.id] });
    expect(await first.call("notice.list")).toEqual({ notices: [] });
    // 第二个客户端也看不到了，再确认一次也不会「复活」或算成它消的
    expect(await second.call("notice.list")).toEqual({ notices: [] });
    expect(await second.call("notice.ack", { ids: [slot.id] })).toEqual({ acked: [] });
    second.close();
  });

  it("`ids` 不是字符串数组 → bad-params（连接不断）", async () => {
    const conn = await startApp();
    for (const params of [{}, { ids: "x" }, { ids: [1] }, { ids: [""] }]) {
      await expect(conn.call("notice.ack", params)).rejects.toThrow(/bad-params/);
    }
    expect(await conn.call("ping")).toEqual({ pong: true });
  });
});

describe("notice.ack 两类通知都认（A30）", () => {
  it("全局与会话内的 id 一次里都能确认，acked 只列真正被删掉的", async () => {
    const conn = await startApp();
    const global = app!.publishNotice({ level: "warn", code: "mcpUnavailable" });
    const created = await sessions.create({ workspaceId: "ws-1", path: dir });
    const slot = sessions.notice(created.sessionId, { level: "info", code: "migrationSkipped" });

    // 快照里看得见这条会话通知（A29：`pendingNotices` 是真值，不是永远为空的占位）
    expect((await sessions.snapshot(created.sessionId)).pendingNotices).toEqual([
      {
        event: "session-notice",
        // 槽位 id（A35）：同一个 id 就是事件里那个
        id: slot.id,
        sessionId: created.sessionId,
        level: "info",
        code: "migrationSkipped",
      },
    ]);

    // 一个请求里混着两类 id、外加一个不存在的：只有真被删掉的回来
    expect(await conn.call("notice.ack", { ids: [global.id, slot.id, "nope"] })).toEqual({
      acked: [global.id, slot.id],
    });
    // 两边都真没了
    expect(await conn.call("notice.list")).toEqual({ notices: [] });
    expect((await sessions.snapshot(created.sessionId)).pendingNotices).toEqual([]);
    // 再来一次：已经不在的东西不能算成这次消的
    expect(await conn.call("notice.ack", { ids: [global.id, slot.id] })).toEqual({ acked: [] });
  });

  it("会话已收的通知确认不了：不出现在 acked 里，也不报错", async () => {
    const conn = await startApp();
    const created = await sessions.create({ workspaceId: "ws-1", path: dir });
    const slot = sessions.notice(created.sessionId, { level: "info", code: "turnAborted" });

    // 会话没了，它那张表跟着没（C3）—— 确认它是「来晚了」，不是错误
    sessions.close(created.sessionId);
    expect(await conn.call("notice.ack", { ids: [slot.id] })).toEqual({ acked: [] });
    expect(await conn.call("ping")).toEqual({ pong: true });
  });
});

/** 等下一条指定名字的事件载荷（别的推送留在队列里，之后还能取到） */
async function nextEventNamed(conn: WsTestClient, name: string): Promise<Record<string, any>> {
  const frame = await conn.nextMatching(
    (candidate) => candidate.method === "session.event" && candidate.params?.event === name,
  );
  return frame.params as Record<string, any>;
}

/**
 * **A35**：两类通知事件都带 `id: string`，且**就是槽位的 id**。
 *
 * 这条是下游（cli / desktop）报上来的同一个洞：通知是有状态的槽位，确认靠
 * `notice.ack { ids }`；而实时推送的事件里没有 id 时，客户端收得到通知却**拿不到能确认
 * 它的凭据** —— 只能按「code + params」本地去重，确认时还得回头再拉一次列表把 id 找回来。
 * 所以两组断言都是「事件里的 id 直接拿去确认」：不为确认多跑一个往返。
 */
describe("A35：通知事件的 id 就是槽位的 id", () => {
  it("会话内通知：`session-notice` 里的 id 就是槽位 id，直接 notice.ack 确认得掉", async () => {
    const conn = await startApp();
    await conn.call("events.watch");
    const created = await sessions.create({ workspaceId: "ws-1", path: dir });
    const slot = sessions.notice(created.sessionId, {
      level: "info",
      code: "handoffPath",
      params: { path: "/tmp/handoff.md" },
    });

    const pushed = await nextEventNamed(conn, "session-notice");
    // 推出去的那条带着**存进表里的那个 id**，不是另发的编号
    expect(pushed.id).toBe(slot.id);
    expect(pushed).toMatchObject({
      event: "session-notice",
      sessionId: created.sessionId,
      level: "info",
      code: "handoffPath",
      params: { path: "/tmp/handoff.md" },
    });

    // 手上只有事件里的那个 id，直接确认（不必先拉快照）
    expect(await conn.call("notice.ack", { ids: [pushed.id] })).toEqual({ acked: [slot.id] });
    expect((await sessions.snapshot(created.sessionId)).pendingNotices).toEqual([]);
  });

  it("全局通知：`server-notice` 里的 id 就是槽位 id，直接 notice.ack 确认得掉", async () => {
    const conn = await startApp();
    await conn.call("events.watch");
    const slot = app!.publishNotice({
      level: "warn",
      code: "mcpUnavailable",
      params: { server: "filesystem" },
    });

    const pushed = await nextEventNamed(conn, "server-notice");
    expect(pushed.id).toBe(slot.id);
    expect(pushed).toMatchObject({ event: "server-notice", level: "warn", code: "mcpUnavailable" });

    expect(await conn.call("notice.ack", { ids: [pushed.id] })).toEqual({ acked: [slot.id] });
    expect(await conn.call("notice.list")).toEqual({ notices: [] });
  });

  it("`snapshot().pendingNotices` 里的 id 直接喂 notice.ack 就能确认掉（不必再查一次列表）", async () => {
    const conn = await startApp();
    const created = await sessions.create({ workspaceId: "ws-1", path: dir });
    // 两条都是**没人在看的时候**登记的：客户端手上只有快照这一个来源
    const first = sessions.notice(created.sessionId, {
      level: "info",
      code: "handoffPath",
      params: { path: "/tmp/a.md" },
    });
    const second = sessions.notice(created.sessionId, { level: "warn", code: "migrationDegraded" });

    const snapshot = await conn.call("session.snapshot", { sessionId: created.sessionId });
    const ids = (snapshot.pendingNotices as Array<{ id: string }>).map((notice) => notice.id);
    // 快照里的 id 与槽位一一对应（登记顺序即 Map 的插入顺序）
    expect(ids).toEqual([first.id, second.id]);

    // 直接确认：全消，快照里不再有它们
    expect(await conn.call("notice.ack", { ids })).toEqual({ acked: ids });
    const after = await conn.call("session.snapshot", { sessionId: created.sessionId });
    expect(after.pendingNotices).toEqual([]);
  });
});

describe("两个作用域不串台", () => {
  it("会话内通知只挂在它自己的会话上：不进全局槽位表，事件也是 `session-notice`", async () => {
    app = makeApp();
    const published: ServerEvent[] = [];
    hub.subscribe((event) => published.push(event));

    const first = await sessions.create({ workspaceId: "ws-1", path: dir });
    const second = await sessions.create({ workspaceId: "ws-1", path: dir });
    const slot = sessions.notice(first.sessionId, { level: "info", code: "migrationSkipped" });

    // 播的是会话事件（带 sessionId），不是全局通知
    expect(published).toEqual([
      {
        event: "session-notice",
        // 存下的槽位与播出去的事件共用同一个 id（A35）
        id: slot.id,
        sessionId: first.sessionId,
        level: "info",
        code: "migrationSkipped",
      },
    ]);
    // 全局槽位表里一条都没有：会话通知与全局通知是两张表、两个作用域
    expect(app.listNotices()).toEqual({ notices: [] });

    // 反过来：全局通知也不会跑到会话的快照里（快照报的只是会话内通知）
    app.publishNotice({ level: "warn", code: "mcpUnavailable" });
    expect((await sessions.snapshot(second.sessionId)).pendingNotices).toEqual([]);
    expect((await sessions.snapshot(first.sessionId)).pendingNotices).toEqual([
      {
        event: "session-notice",
        // 快照里那条与实时推出去的是同一个 id（A35）
        id: slot.id,
        sessionId: first.sessionId,
        level: "info",
        code: "migrationSkipped",
      },
    ]);

    // 会话没了，它那张表跟着没：再往它上面发通知是 unknown-session
    sessions.close(first.sessionId);
    expect(() =>
      sessions.notice(first.sessionId, { level: "info", code: "migrationSkipped" }),
    ).toThrow(/unknown session/);
    // 另一段会话不受影响
    expect((await sessions.snapshot(second.sessionId)).sessionId).toBe(second.sessionId);
  });
});

describe("生命周期：start / stop", () => {
  it("start 写发现文件；stop 收摊五步（停会话 → flush 日志 → 删发现文件 → 退出），可重复调用", async () => {
    const flushed: string[] = [];
    app = new ServerApp({
      aiZenDir: dir,
      homeDir: dir,
      defaultWorkspacePath: dir,
      port: 0, // 系统分配
      hub,
      sessions,
      log: (level, message) => logs.push(`${level}: ${message}`),
      flushLog: async () => {
        flushed.push("flush");
      },
      exit: (code) => exits.push(code),
    });

    const descriptor = await app.start();
    expect(descriptor.port).toBe(app.port);
    expect((await readDescriptor(dir))?.port).toBe(app.port);
    // 配置根被释放（默认 Agent 落盘）：新机器上第一次 `agent.list` 不该是空的
    expect(descriptor.protocol).toBeGreaterThan(0);

    // 启动日志里有凭证文件的**路径**（要拿它去设 `AI_ZEN_SERVER_TOKEN` 连远程的人得知道
    // 它住在哪），但**没有**凭证本身 —— 日志会被翻、会被贴出去
    expect(logs.some((line) => line.includes(tokenPath(dir)))).toBe(true);
    const token = await readToken(dir);
    expect(token).not.toBeNull();
    expect(logs.some((line) => line.includes(token!))).toBe(false);

    // 停会话是收摊中间那一步：起一段会话，收摊之后它不在了
    const created = await sessions.create({ workspaceId: "ws-1", path: dir });

    await app.stop("test");
    expect(await readDescriptor(dir)).toBeNull();
    // 会话确实被停了（`dispose` 清表）：再要快照就是 unknown-session
    await expect(sessions.snapshot(created.sessionId)).rejects.toThrow(/unknown session/);
    // 日志刷出去之后才退出
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exits).toHaveLength(1);
    expect(flushed.length).toBeGreaterThan(0);
    expect(logs.some((line) => line.startsWith("info: exit (test)"))).toBe(true);

    // 幂等：再停一次不会把发现文件「删两次」也不会重复退出
    await app.stop("again");
    expect(exits).toHaveLength(1);
  });

  it("已经有一个活着的服务时 refuse to start（同一套配置目录不双开）", async () => {
    app = makeApp();
    await app.start();

    const second = makeApp();
    await expect(second.start()).rejects.toThrow(/already running/);
    // 第一个照旧在跑
    expect(app.listening).toBe(true);
  });

  it("没起过传输也能收摊（用例里直接 new 出来的那种）：会话照收，不报错", async () => {
    app = makeApp();
    const created = await sessions.create({ workspaceId: "ws-1", path: dir });
    await app.stop("never started");
    await expect(sessions.snapshot(created.sessionId)).rejects.toThrow(/unknown session/);
    expect(app.port).toBe(0);
  });
});
