/**
 * 真端口这一组：起一个真的宿主、用真的 ws 客户端连上去、发一句话、收到流；另有一条说的是连接
 * 这一层的鉴权 —— 令牌验不过就连不上，任何 procedure 都调不到。
 *
 * 还有一条跨两次启动的（`describe("关掉再打开")`）：同一个数据根先后起两个宿主，验的是「停掉之后
 * 历史与排队区都还在，而没有一段会话自己跑起来」。它必须跨两次启动 —— 装配、恢复、以及「不自动
 * 生」这三件事只在重启那一刻同时发生，单进程里造不出这个处境。
 *
 * 模型不出网：用例里起一个本地的 OpenAI 兼容端点回一段 SSE，地址写进 `config.json` 的端点。
 * 这样验的是「一句话真的走到了执行体、模型说的话真的流回来了」，而不是把请求层整个打掉。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { AgentNS } from "@ai-zen/agents-core";
import { Message } from "@ai-zen/agents-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { HostApp, UPGRADE_EXIT_CODE } from "./app.js";
import { openDatabase } from "./infra/db.js";
import { readVersionPin, writeVersionPin } from "./infra/versionPin.js";
import { inboxTable } from "./modules/agent/inbox.js";
import { Discovery } from "./modules/config/discovery.js";
import type { HostEvent } from "./modules/events.js";
import type { Notice } from "./modules/notice/types.js";
import { messageTable } from "./modules/session/messages.js";
import type { Session } from "./modules/session/types.js";
import { workspaceTable } from "./modules/workspace/table.js";

/** 本地端点要说的话。分成几片，于是流式那一侧真的有多次 `message.changed` */
const REPLY = ["本地端点", "收到了这句话。"];
const SAID = "你好，本地端点";

/** 本地端点给起名那一支回的名字（不流式的那一条路） */
const TITLE = "本地端点起的名字";

/** 递出去的这句话里带这几个字，起名那一支就回 500：起名失败那个处境要用例自己造 */
const NAMING_FAILS_ON = "让起名失败";

/** tRPC over WebSocket 的一帧。协议只有这么几格，`@trpc/client` 不在依赖里 */
interface Envelope {
  readonly id: number | null;
  readonly result?: { readonly type?: string; readonly data?: unknown };
  readonly error?: { readonly message?: string; readonly data?: { readonly code?: string } };
}

/** 错误帧里能读出结论的那两格：码说的是哪一种拒，话是渲染好的那一句 */
function rejectionOf(error: NonNullable<Envelope["error"]>): Error {
  return new Error(`${error.data?.code ?? ""} ${error.message ?? ""}`.trim());
}

class HostClient {
  private id = 0;
  private readonly waiting = new Map<number, (message: Envelope) => void>();
  /**
   * 没有 `id` 的帧。服务端在连接这一层拒绝时只发这一种，它不属于任何一次调用；记下来是为了让
   * 断言说得出「先回了一帧 `UNAUTHORIZED` 才关掉连接」，而不是只有「断了」。
   */
  readonly refusals: Envelope[] = [];
  /** 服务端关掉这条连接时兑现。被拒的连接没有本调用的回包可等，能等的只有它 */
  private readonly closed: Promise<void>;

  private constructor(private readonly socket: WebSocket) {
    this.closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    this.socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Envelope;
      if (message.id === null) {
        this.refusals.push(message);
        return;
      }
      this.waiting.get(message.id)?.(message);
    });
  }

  static connect(port: number, token?: string): Promise<HostClient> {
    // 查询串不是装饰：带 `connectionParams=1` 时服务端才等握手帧再建上下文；不带时它一建成就用
    // 空参数建一次，于是「没送令牌」在连接那一刻就已经被判完了，握手帧根本来不及送
    const url =
      token === undefined ? `ws://127.0.0.1:${port}` : `ws://127.0.0.1:${port}?connectionParams=1`;
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => {
        // 握手帧只能在 `open` 之后发（早了 socket 还没连上，`send` 会抛），但必须紧接着发：
        // 服务端拿这一帧建上下文，它是这条连接上第一帧才算数，之后的 `query` 才有上下文可判
        if (token !== undefined) {
          socket.send(
            JSON.stringify({
              id: null,
              jsonrpc: "2.0",
              method: "connectionParams",
              data: { token },
            }),
          );
        }
        resolve(new HostClient(socket));
      });
    });
  }

  async query<T>(path: string, input: unknown): Promise<T> {
    return this.once<T>("query", path, input);
  }

  async mutation<T>(path: string, input: unknown): Promise<T> {
    return this.once<T>("mutation", path, input);
  }

  /** 等到 `started` 再回来：之后到达的每一片交给 `onEvent` */
  subscribe(path: string, onEvent: (payload: unknown) => void): Promise<void> {
    const id = this.send("subscription", path, undefined);
    return new Promise<void>((resolve, reject) => {
      this.waiting.set(id, (message) => {
        if (message.error !== undefined) {
          this.waiting.delete(id);
          reject(new Error(message.error.message ?? "subscription rejected"));
          return;
        }
        if (message.result?.type === "started") resolve();
        if (message.result?.type === "data") onEvent(message.result.data);
      });
    });
  }

  close(): void {
    this.socket.close();
  }

  /** 等服务端关掉这条连接：被拒的连接留在这儿的只有那一帧无 id 的错误 */
  whenClosed(): Promise<void> {
    return this.closed;
  }

  private async once<T>(method: "query" | "mutation", path: string, input: unknown): Promise<T> {
    const id = this.send(method, path, input);
    const answered = new Promise<Envelope>((resolve) => this.waiting.set(id, resolve));
    // 被拒的连接不会为这次调用回一帧带 `id` 的包，它先回一帧无 id 的错误再把连接关掉：所以
    // 「关掉」也要能结束这次等待，否则用例等到的是超时，而不是「被拒」
    const closed = this.closed.then((): never => {
      throw this.refusal();
    });
    const message = await Promise.race([answered, closed]);
    this.waiting.delete(id);
    if (message.error !== undefined) throw rejectionOf(message.error);
    return message.result?.data as T;
  }

  /** 这次调用等不到回包时的说法：服务端在连接这一层留的那一帧，或者「什么都没说就断了」 */
  private refusal(): Error {
    const last = this.refusals.at(-1)?.error;
    return last === undefined ? new Error("服务端关掉了连接，没有回任何帧") : rejectionOf(last);
  }

  private send(method: string, path: string, input: unknown): number {
    // 连接已经被关掉时不再往 socket 上写：ws 此时抛的是「readyState 3」这种现场，与「被拒」
    // 不是一件事，用例里也就无从断言
    if (this.socket.readyState !== WebSocket.OPEN) throw this.refusal();
    this.id += 1;
    this.socket.send(
      JSON.stringify({ id: this.id, jsonrpc: "2.0", method, params: { path, input } }),
    );
    return this.id;
  }
}

/**
 * 端点收到的一次请求。
 *
 * 记下来是为了「模型在这段时间里被叫过没有」这一格：重启之后没有任何执行体自己跑起来，唯一的
 * 外部证据就是端点这边一个请求都没收到 —— 只看 `session.open` 的 `live` 不够，那只是宿主自己
 * 的说法，而且它可能是「醒了又立刻闲下来」的中途一拍。
 */
interface ModelCall {
  readonly method: string;
  readonly path: string;
}

/**
 * 本地的 OpenAI 兼容端点，两条路：
 * - 流式：执行体那一次请求（`stream: true`），按 SSE 一片一片吐同一个回答 —— 这几组用例验的是
 *   「一句话真的走到了执行体、模型说的话真的流回来了」，不是把请求层整个打掉；
 * - 不流式：起名那一次请求（`completeOnce` 不带 `stream`），回一份 JSON。正文里带
 *   {@link NAMING_FAILS_ON} 时回 500，于是「起名失败」也是一个能造出来的处境。
 */
function startModelServer(): Promise<{
  origin: string;
  server: Server;
  requests: ModelCall[];
}> {
  const requests: ModelCall[] = [];
  const server = createServer((request, response) => {
    // 记在所有判断之前：这条用例问的是「有没有人来过」，不是「来的人是不是走对了路」
    requests.push({ method: request.method ?? "", path: request.url ?? "" });
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      request.resume();
      response.writeHead(404).end();
      return;
    }

    // 先收完整份请求体：起名那一条要看正文里有没有那个标记，也靠 `stream` 分辨这是哪一条路
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const base = {
        id: "chatcmpl-local",
        created: Math.floor(Date.now() / 1000),
        model: "local-model",
      };

      if (!/"stream"\s*:\s*true/.test(raw)) {
        if (raw.includes(NAMING_FAILS_ON)) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "the endpoint is down" } }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ...base,
            object: "chat.completion",
            choices: [
              { index: 0, message: { role: "assistant", content: TITLE }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
          }),
        );
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const chunk = { ...base, object: "chat.completion.chunk" };
      const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);

      send({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
      for (const piece of REPLY) {
        send({ ...chunk, choices: [{ index: 0, delta: { content: piece } }] });
      }
      send({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      send({
        ...chunk,
        choices: [],
        usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
      });
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, server, requests });
    });
  });
}

/** 消息正文可能是多模态段数组，这条用例只说一句纯文本 */
function textOf(message: AgentNS.Message): string {
  return String(message.content ?? "");
}

/** 排队区条目的正文：与消息同一种形状，这条用例投的都是纯文本 */
function entryText(entry: AgentNS.InboxEntry): string {
  return typeof entry.content === "string" ? entry.content : String(entry.content ?? "");
}

/**
 * 在一段窗口里反复看一眼，窗口内**每一次**都必须成立。
 *
 * 「等一会儿，然后断言什么都没发生」不能写成 `sleep` 接着一句断言：那样只看见窗口末尾那一瞬。
 * 这里隔 `step` 毫秒问一次，`probe` 里那几条断言有一刻不成立就当场失败 —— 于是它既是一段
 * 有超时的等待，也是一整段窗口的观察。
 */
async function quietFor(probe: () => Promise<void>, windowMs = 2_000, step = 100): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    await probe();
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  await probe();
}

/** `session.open` 回来的那几格；用例只断言用得上的，其余照旧过网 */
interface Opened {
  readonly live: { readonly state: string } | null;
  readonly messages: AgentNS.Message[];
  readonly inbox: readonly AgentNS.InboxEntry[];
}

describe("宿主跑起来", () => {
  const workspaceId = randomUUID();
  /** 一个没有任何会话的项目：前面那条用例会往 `workspaceId` 里落一段会话，这里要的是真的空 */
  const vacantWorkspaceId = randomUUID();
  let dataRoot: string;
  let previousHome: string | undefined;
  let model: { origin: string; server: Server };
  let app: HostApp;
  let client: HostClient;
  let token: string;
  /** 第一条用例递出去的那句话落在哪段会话上：后面那条「重新打开」要用它 */
  let sessionId: string;

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ai-zen-host-"));
    model = await startModelServer();

    const appConfig = {
      endpoints: [
        {
          id: "local",
          name: "Local",
          baseUrl: `${model.origin}/v1`,
          apiKey: "local-test-key",
        },
      ],
      models: [
        {
          id: "local-model",
          name: "Local",
          endpointId: "local",
          modelName: "local-model",
          tokenThresholds: { handoff: 250_000, guard: 375_000 },
          // 出厂模型清单是托管清单，不标 custom 的条目会在启动时被替换掉
          custom: true,
        },
      ],
      defaultModel: "local-model",
      language: "zh",
    };
    writeFileSync(join(dataRoot, "config.json"), JSON.stringify(appConfig, null, 2));

    mkdirSync(join(dataRoot, "agents"), { recursive: true });
    writeFileSync(
      join(dataRoot, "agents", "default.json"),
      JSON.stringify(
        {
          id: "default",
          name: "Default Assistant",
          modelId: "local-model",
          messages: [Message.System("You are a test assistant.")],
          permissions: {
            tools: { allow: ["*"] },
            skills: { allow: ["*"] },
            mcps: { allow: ["*"] },
            subagents: { allow: ["*"] },
          },
          custom: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    // 项目行直接写进表，不走 `workspace.create`：这条用例验的是投递与流式那一串事件，
    // 从 procedure 建项目会让这一串里多绕一层与它无关的东西。
    const cwd = join(dataRoot, "project");
    mkdirSync(cwd, { recursive: true });
    const vacant = join(dataRoot, "vacant");
    mkdirSync(vacant, { recursive: true });
    const db = openDatabase(join(dataRoot, "ai-zen.db"));
    workspaceTable(db).put({ id: workspaceId, name: "用例项目", cwd, createdAt: Date.now() });
    workspaceTable(db).put({
      id: vacantWorkspaceId,
      name: "空项目",
      cwd: vacant,
      createdAt: Date.now(),
    });
    db.close();

    process.env.AI_ZEN_DIR = dataRoot;
    // 用户主目录那几层也要指到临时目录：否则这条用例会去读开发机的 `~/.agents/skills`，
    // 于是結果跟着机器变 —— 那是「单跑绿、合跑红」的典型来源。
    previousHome = process.env.HOME;
    process.env.HOME = join(dataRoot, "home");
    app = await HostApp.open({ port: 0 });
    await app.start();
    // 令牌只从本机交付文件读，不自己造：文件里那一串带一个末尾换行，不 `trim` 就永远验不过
    token = readFileSync(join(dataRoot, "run", "token"), "utf8").trim();
    client = await HostClient.connect(app.address.port, token);
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await app?.stop();
    await new Promise<void>((resolve) => model?.server.close(() => resolve()));
    delete process.env.AI_ZEN_DIR;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dataRoot, { recursive: true, force: true });
  }, 60_000);

  it("调 session.list 拿到空列表，调 agent.send 递一句话，再从 events 收到流", async () => {
    const events: HostEvent[] = [];
    await client.subscribe("events", (payload) => events.push(payload as HostEvent));

    const sessions = await client.query<Session[]>("session.list", { workspaceId });
    expect(sessions).toEqual([]);

    const sent = await client.mutation<{ sessionId: string; messageId: string }>("agent.send", {
      workspaceId,
      agentId: "default",
      content: SAID,
      messageId: randomUUID(),
    });
    sessionId = sent.sessionId;

    const idled = () =>
      events.some((event) => event.type === "agent.status" && event.status === "idle");
    await vi.waitFor(() => expect(idled()).toBe(true), { timeout: 30_000, interval: 20 });

    console.log(events.map((event) => JSON.stringify(event)).join("\n"));

    const added = events.flatMap((event) =>
      event.type === "message.added" ? [event.message] : [],
    );
    const changed = events.flatMap((event) =>
      event.type === "message.changed" ? [event.message] : [],
    );

    // 1. 用户那句话落进了这段会话，用的就是客户端给的 id
    expect(added.map((message) => message.id)).toContain(sent.messageId);
    expect(added.map(textOf)).toContain(SAID);

    // 2. 模型说的话是流回来的：至少一条带正文的 message.changed，最后一条是完整的一句
    expect(changed.some((message) => textOf(message).length > 0)).toBe(true);
    expect(changed.map(textOf)).toContain(REPLY.join(""));

    // 3. 三条事件的先后：先说加了消息，再说消息在变，最后转闲
    const addedAt = events.findIndex((event) => event.type === "message.added");
    const changedAt = events.findIndex(
      (event) => event.type === "message.changed" && textOf(event.message).length > 0,
    );
    const idledAt = events.findIndex(
      (event) => event.type === "agent.status" && event.status === "idle",
    );
    expect(addedAt).toBeGreaterThanOrEqual(0);
    expect(changedAt).toBeGreaterThan(addedAt);
    expect(idledAt).toBeGreaterThan(changedAt);
  }, 60_000);

  it("另开一条连接打开那段会话，状态与全部历史一次拿到；杀掉执行体之后历史照样在", async () => {
    // 手里没有任何历史的一条新连接：它看到的一切都来自这一次调用
    const fresh = await HostClient.connect(app.address.port, token);
    try {
      const opened = await fresh.query<Opened>("session.open", { sessionId });
      expect(opened.live?.state).toBe("idle");
      expect(opened.messages.map(textOf)).toContain(SAID);
      expect(opened.messages.map(textOf)).toContain(REPLY.join(""));
      // 那一句话已经被取走并且落了地，排队区里不应当还留着它
      expect(opened.inbox).toEqual([]);
    } finally {
      fresh.close();
    }

    // 杀掉执行体：内存没了，这时库就是它的全部
    await client.mutation("agent.kill", { sessionId });
    const reopened = await client.query<Opened>("session.open", { sessionId });
    expect(reopened.live).toBeNull();
    expect(reopened.messages.map(textOf)).toContain(SAID);
    expect(reopened.messages.map(textOf)).toContain(REPLY.join(""));
  }, 60_000);

  it("验不过的连接调不到任何 procedure，宿主照旧服务", async () => {
    // 不送令牌：连的是没有查询串的那条地址，服务端在建上下文那一刻就把它拒了，握手帧无从送起
    const anonymous = await HostClient.connect(app.address.port);
    await expect(anonymous.query("session.list", { workspaceId })).rejects.toThrow(
      /UNAUTHORIZED|令牌/,
    );
    // 拒这件事在客户端只剩两样能看的：一帧无 id 的错误，和随后关掉的连接
    await anonymous.whenClosed();
    expect(anonymous.refusals.at(-1)?.error?.data?.code).toBe("UNAUTHORIZED");

    // 令牌送出去了但验不过：走的是握手那一支，结论相同
    const forged = await HostClient.connect(app.address.port, "forged-token");
    await expect(forged.query("session.list", { workspaceId })).rejects.toThrow(
      /UNAUTHORIZED|令牌/,
    );
    await forged.whenClosed();
    expect(forged.refusals.at(-1)?.error?.data?.code).toBe("UNAUTHORIZED");

    // 这两次拒绝不能把宿主带走：换那串真的令牌上去，调用照旧成立。查的是那个还没有会话的项目，
    // 上一个用例已经往 `workspaceId` 里落了一段会话，拿它兑不出「空数组」这个结论
    const admitted = await HostClient.connect(app.address.port, token);
    try {
      await expect(
        admitted.query<Session[]>("session.list", { workspaceId: vacantWorkspaceId }),
      ).resolves.toEqual([]);
    } finally {
      admitted.close();
    }
  }, 60_000);

  /**
   * 每投一句话都会走两次写库：`deliver()` 先落库（落库先于入队），入队之后那条 `inboxAdded`
   * 又让观察者写一次同一个 id。第二次撞的是主键，它必须是一次安静的空动作 —— 否则每说一句，
   * 宿主日志里就多一条 `inbox-write` 的 ERROR，而库里那一条其实好好地在那儿。
   */
  it("发一句话之后日志里没有 inbox-write，排队区那一条照样在库", async () => {
    // 日志文件先立起来写一行标记：这份日志是追加写的，读回来看得见标记才说明读的确实是它写的
    // 那一份文件 —— 否则「文件还不存在」会让下面那句「不含 inbox-write」变成一句空话
    const logFile = join(dataRoot, "logs", "host.log");
    const marker = `用例标记 ${randomUUID()}`;
    mkdirSync(join(dataRoot, "logs"), { recursive: true });
    appendFileSync(logFile, `${marker}\n`);

    const events: HostEvent[] = [];
    await client.subscribe("events", (payload) => events.push(payload as HostEvent));

    // 不给 `sessionId`：这一段会话就是这一次发送产生的，建行、唤醒、投递都在这一句里
    const sent = await client.mutation<{ sessionId: string; messageId: string }>("agent.send", {
      workspaceId,
      agentId: "default",
      content: SAID,
      messageId: randomUUID(),
    });
    const sessionId = sent.sessionId;

    // 等这一段会话跑完一拍：投递那一路的两次写库都发生在这一拍之前
    const idled = () =>
      events.some(
        (event) =>
          event.type === "agent.status" &&
          event.sessionId === sessionId &&
          event.status === "idle",
      );
    await vi.waitFor(() => expect(idled()).toBe(true), { timeout: 30_000, interval: 20 });

    // 留一条没被取走的：abort 之后取件那道闸关着，这一条此后只可能躺在排队区
    await client.mutation("agent.abort", { sessionId });
    const pendingText = "这句还排在队列里";
    const pendingId = randomUUID();
    await client.mutation("agent.send", {
      workspaceId,
      agentId: "default",
      sessionId,
      content: pendingText,
      messageId: pendingId,
    });

    const db = openDatabase(join(dataRoot, "ai-zen.db"));
    try {
      const waiting = () => inboxTable(db).listBySession(sessionId);
      // 整个窗口里每一次都要成立：日志是排队异步写的，只看一眼不足以说明这一刻之后不会再冒出
      // 那条 ERROR
      await quietFor(async () => {
        const log = readFileSync(logFile, "utf8");
        expect(log).toContain(marker);
        expect(log).not.toContain("inbox-write");

        const rows = waiting();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.messageId).toBe(pendingId);
        expect(rows.map(entryText)).toEqual([pendingText]);
      });
    } finally {
      db.close();
    }

    // 公开面那一条照旧：用户看得见的排队区里就它一条（它读的正是这张表）
    const opened = await client.query<Opened>("session.open", { sessionId });
    expect(opened.inbox.map(entryText)).toEqual([pendingText]);
  }, 60_000);
});

/**
 * 来源目录是 `allInOne` 唯一会读的那个参数：三个列表全空时它不报错，只是什么都不发现，界面上表现为
 * 「这三种能力一个都没有」。而列表顺序就是优先级（SDK 按这个顺序先到先得），排反了远处的定义会盖住
 * 项目里的那一份。
 */
describe("能力来源目录", () => {
  it("三种能力都从项目那一层起，近的在前", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-zen-ability-"));
    try {
      const project = join(root, "project");
      const discovery = new Discovery({
        dataRoot: join(root, "data"),
        homeDir: join(root, "home"),
        log: { info: () => {}, warn: () => {}, error: () => {} },
      });

      const paths = discovery.abilityPaths(project);

      expect(paths.skillsPaths.length).toBeGreaterThan(0);
      expect(paths.toolsPaths.length).toBeGreaterThan(0);
      expect(paths.subAgentsPaths.length).toBeGreaterThan(0);

      expect(paths.skillsPaths[0]).toBe(join(project, ".ai-zen", "skills"));
      expect(paths.toolsPaths[0]).toBe(join(project, ".agents", "tools"));
      expect(paths.subAgentsPaths[0]).toBe(join(project, ".agents", "sub-agents"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * 第 13 行的另一半：「关掉再打开，历史与没被处理的那几句话都在，没有一段会话自己跑起来」。
 *
 * 两个宿主**先后**起在同一个数据根上（第一个 `stop()` 完成之后才起第二个），端口都用 `0`。这条
 * 用例只走客户端的公开面：`agent.send` / `agent.abort` / `session.open` —— 宿主怎么把执行体装
 * 起来、库里那张表长什么样，都不是断言的对象。
 */
describe("关掉再打开", () => {
  let dataRoot: string;
  let projectDir: string;
  let previousHome: string | undefined;
  let model: { origin: string; server: Server; requests: ModelCall[] };

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ai-zen-restart-"));
    projectDir = join(dataRoot, "project");
    mkdirSync(projectDir, { recursive: true });

    model = await startModelServer();

    writeFileSync(
      join(dataRoot, "config.json"),
      JSON.stringify(
        {
          endpoints: [
            {
              id: "local",
              name: "Local",
              baseUrl: `${model.origin}/v1`,
              apiKey: "local-test-key",
            },
          ],
          models: [
            {
              id: "local-model",
              name: "Local",
              endpointId: "local",
              modelName: "local-model",
              tokenThresholds: { handoff: 250_000, guard: 375_000 },
              // 出厂模型清单是托管清单，不标 custom 的条目会在启动时被替换掉
              custom: true,
            },
          ],
          defaultModel: "local-model",
          language: "zh",
        },
        null,
        2,
      ),
    );

    mkdirSync(join(dataRoot, "agents"), { recursive: true });
    writeFileSync(
      join(dataRoot, "agents", "default.json"),
      JSON.stringify(
        {
          id: "default",
          name: "Default Assistant",
          modelId: "local-model",
          messages: [Message.System("You are a test assistant.")],
          permissions: {
            tools: { allow: ["*"] },
            skills: { allow: ["*"] },
            mcps: { allow: ["*"] },
            subagents: { allow: ["*"] },
          },
          custom: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    process.env.AI_ZEN_DIR = dataRoot;
    // 与上面那一组同口径：用户主目录也指到临时目录，别让用例去读开发机的 `~/.agents`
    previousHome = process.env.HOME;
    process.env.HOME = join(dataRoot, "home");
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => model?.server.close(() => resolve()));
    delete process.env.AI_ZEN_DIR;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dataRoot, { recursive: true, force: true });
  }, 60_000);

  it("关掉再打开：历史与没处理的那几句都在，没有一段会话自己跑起来", async () => {
    // ── 第一台：建项目、发一句话，把那次回答等到落库 ──
    const first = await HostApp.open({ port: 0, local: true });
    await first.start();
    const firstClient = await HostClient.connect(
      first.address.port,
      // 令牌只从本机交付文件读（同一个数据根下第二台会再写一次，这里每台各读一次）
      readFileSync(join(dataRoot, "run", "token"), "utf8").trim(),
    );

    const events: HostEvent[] = [];
    await firstClient.subscribe("events", (payload) => events.push(payload as HostEvent));

    const created = await firstClient.mutation<{ workspace: { id: string } }>("workspace.create", {
      cwd: projectDir,
      name: "关掉再打开",
    });
    const workspaceId = created.workspace.id;

    // 不给 `sessionId`：这一段会话就是这次发送产生的（建行、叫醒、投递都是它的一个动作）
    const sent = await firstClient.mutation<{ sessionId: string; messageId: string }>(
      "agent.send",
      {
        workspaceId,
        agentId: "default",
        content: SAID,
        messageId: randomUUID(),
      },
    );
    const sessionId = sent.sessionId;

    // 与上面几条用例同一个等待手法：等那条 assistant 消息定稿（正文齐了、`completed`）
    const answered = () =>
      events.some(
        (event) =>
          event.type === "message.changed" &&
          textOf(event.message) === REPLY.join("") &&
          event.message.status === "completed",
      );
    await vi.waitFor(() => expect(answered()).toBe(true), { timeout: 30_000, interval: 20 });

    // ── 停机之前留一条**没被处理**的话 ──
    //
    // 选「先 abort 关掉输出闸、再投一句」，不是「趁执行体忙的时候投」：忙的那段窗口只有几十毫秒
    // （假端点立刻回），早一步是「它还没开始跑」、晚一步是「它已经回完并把话取走了」，用例会随机
    // 落进不同的处境。abort 之后管理取件的那道闸是关着的 —— 此后投进去的条目只可能躺在排队区
    // （core 的取件挂在闸上），于是「停机那一刻 inbox 表里有行」是确定的，不靠时序碰运气。
    await firstClient.mutation("agent.abort", { sessionId });
    const pendingText = "这句还没被处理";
    await firstClient.mutation("agent.send", {
      workspaceId,
      agentId: "default",
      sessionId,
      content: pendingText,
      messageId: randomUUID(),
    });

    // 停机之前先从公开面确认一遍：它在排队区里，而且执行体没有在为它忙碌（闸关着 → 状态是闲）
    const beforeStop = await firstClient.query<Opened>("session.open", { sessionId });
    expect(beforeStop.live?.state).toBe("idle");
    expect(beforeStop.inbox.map(entryText)).toEqual([pendingText]);

    // ── 正常停掉（`stop()`，不是杀进程）──
    firstClient.close();
    await first.stop();

    // 停机之后库里那几行还在。直接读库：库是宿主写下的那份事实，不是它的私有字段，
    // 而「还在磁盘上」这件事只有关掉进程之后看才算数
    const db = openDatabase(join(dataRoot, "ai-zen.db"));
    const persistedMessages = messageTable(db).listBySession(sessionId).map(textOf);
    const persistedInbox = inboxTable(db).listBySession(sessionId).map(entryText);
    db.close();

    expect(persistedMessages).toContain(SAID);
    expect(persistedMessages).toContain(REPLY.join(""));
    expect(persistedInbox).toEqual([pendingText]);

    // 发现文件在第一台停机时被清掉。这一格不是装饰：两次启动在同一个进程里，pid 一定还活着 ——
    // 文件没清干净，第二台会读出「这台机器上已经有宿主在服务」，于是不绑端口、不写文件，
    // 之后连上去的客户端对着一个已经关掉的端口等超时。那是 `stop()` 没清干净，是真缺陷。
    expect(existsSync(join(dataRoot, "run", "host.json"))).toBe(false);

    // 第一段对话叫过一次模型。这一格除了记账，还证明这个计数器是活的 —— 否则下面那句
    // 「没有新请求」就是 0 与 0 比，什么都钉不住。拍在这里之后，第二台从启动起的所有请求
    // 都落在窗口内
    const callsBefore = model.requests.length;
    expect(callsBefore).toBeGreaterThan(0);

    // ── 第二台：同一个数据根，什么都不投 ──
    const second = await HostApp.open({ port: 0, local: true });
    await second.start();
    const secondClient = await HostClient.connect(
      second.address.port,
      readFileSync(join(dataRoot, "run", "token"), "utf8").trim(),
    );

    try {
      const opened = await secondClient.query<Opened>("session.open", { sessionId });

      // 1. 没有任何执行体自己跑起来
      expect(opened.live).toBeNull();
      // 2. 历史在：第一次那段对话一问一答都在
      expect(opened.messages.map(textOf)).toContain(SAID);
      expect(opened.messages.map(textOf)).toContain(REPLY.join(""));
      // 3. 排队区在：那条没被处理的话还在等
      expect(opened.inbox.map(entryText)).toEqual([pendingText]);

      // 4. 不投任何东西，看一会儿：这期间每一次 `session.open` 都必须是同一个答案，而且假端点
      //    一个请求都不该收到 —— 收到就说明有执行体自己醒了、自己发了请求，那正是这一格要钉的
      await quietFor(async () => {
        const again = await secondClient.query<Opened>("session.open", { sessionId });
        expect(again.live).toBeNull();
        expect(again.inbox.map(entryText)).toEqual([pendingText]);
      });
      expect(model.requests.length).toBe(callsBefore);
    } finally {
      // ── 收尾：停第二台、关假端点、清临时目录（临时目录在 `afterAll` 里清）──
      secondClient.close();
      await second.stop();
    }
  }, 120_000);
});

/**
 * 第 14 行的另一半：pin 与退出信号是两件事。
 *
 * 只写 pin 的话，一次**正常**关闭之后启动方式会照着老 pin 把服务又拉起来。所以：「正常关闭把 pin
 * 清掉」（下一条用例），而升级那一路留下 pin，并以另一个退出码退出 —— 启动方式据此分清「照 pin
 * 重拉」与「就是关了」。
 *
 * 后两条要说的是同一条规矩的两个窗口：pin 与退出信号对得上。升级请求落在收尾之后（第三条）时，
 * 「先到的那一句没理由」不能把它吞成一次正常关闭 —— 那会是「以 75 退出、却没有 pin」，启动方式
 * 读到 75 却读不到版本，这次升级静默失效。
 *
 * 三条都不碰网络：升级走判据 A（磁盘上那一份已经是目标版本），registry 那一路由
 * `modules/update/service.test.ts` 用替身钉住。也不真的退出：`exit` 是可注入的，注一个记账的
 * 替身 —— 真的 `process.exit` 会把整个用例进程带走，而「退出码是多少」正是要断言的那一格。
 */
describe("pin 与退出信号", () => {
  let dataRoot: string;
  let pinFile: string;
  let previousHome: string | undefined;

  beforeAll(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "ai-zen-upgrade-"));
    pinFile = join(dataRoot, "run", "next-version.json");

    process.env.AI_ZEN_DIR = dataRoot;
    previousHome = process.env.HOME;
    // 与另两组同口径：用户主目录也指到临时目录，别让用例去读开发机的 `~/.agents`
    process.env.HOME = join(dataRoot, "home");
  }, 60_000);

  afterAll(() => {
    delete process.env.AI_ZEN_DIR;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dataRoot, { recursive: true, force: true });
  }, 60_000);

  it("正常关闭会把 pin 清掉", async () => {
    // 上一次升级留下的那条 pin：这一条验的正是它会不会被清掉
    writeVersionPin(pinFile, { version: "9.9.9", requestedAt: new Date().toISOString() });

    const app = await HostApp.open({ port: 0, local: true });
    await app.start();

    // 启动只清「跑着的这一版」那条 pin；9.9.9 不是它，所以跑起来之后它还在
    expect(readVersionPin(pinFile)?.version).toBe("9.9.9");

    await app.stop();

    expect(existsSync(pinFile)).toBe(false);
  }, 60_000);

  it("升级那一路留下 pin，并以升级退出码退出", async () => {
    const exits: number[] = [];
    const app = await HostApp.open({
      port: 0,
      local: true,
      exit: (code) => exits.push(code),
    });
    await app.start();

    const client = await HostClient.connect(
      app.address.port,
      readFileSync(join(dataRoot, "run", "token"), "utf8").trim(),
    );

    try {
      // 客户端要显示的那一格
      await expect(client.query<{ version: string }>("host.version", undefined)).resolves.toEqual({
        version: app.version,
      });

      // 升到「磁盘上已经是的那一版」：判据 A 成立，这一条不碰网络
      await expect(
        client.mutation<{ version: string; restarting: true }>("host.upgrade", {
          version: app.version,
        }),
      ).resolves.toEqual({ version: app.version, restarting: true });
    } finally {
      client.close();
    }

    // 退出推后一拍（答复先出去，然后才收尾）：等到「退出意图」为止，不真的退
    await vi.waitFor(() => expect(exits).toEqual([UPGRADE_EXIT_CODE]), {
      timeout: 10_000,
      interval: 20,
    });

    // pin 留下，写的是目标版本 —— 启动方式读它、照它重拉
    expect(readVersionPin(pinFile)?.version).toBe(app.version);
    // 但发现文件照样清掉了：这个进程确实已经不在服务
    expect(existsSync(join(dataRoot, "run", "host.json"))).toBe(false);
  }, 60_000);

  it("升级请求落在「已经在关」之后：pin 照样留着", async () => {
    const exits: number[] = [];
    const app = await HostApp.open({
      port: 0,
      local: true,
      exit: (code) => exits.push(code),
    });
    await app.start();

    const hostFile = join(dataRoot, "run", "host.json");
    expect(existsSync(hostFile)).toBe(true);

    // 信号那一路先进来：它不带理由，收尾已经开始（不等它）
    const closing = app.stop();

    // 紧接着升级那一路赶到，次序与 `UpdateService.upgrade` 里那一套一致：pin 先写、再请退出
    writeVersionPin(pinFile, { version: app.version, requestedAt: new Date().toISOString() });
    app.requestRestart(app.version);

    await closing;
    // 退出意图照样是「照 pin 重拉」那一个码
    await vi.waitFor(() => expect(exits).toEqual([UPGRADE_EXIT_CODE]), {
      timeout: 10_000,
      interval: 20,
    });

    // 「以 75 退出、却没有 pin」正是要堵掉的那一格：先到的那一句没理由，但它不能把后来那句
    // 「这是升级」吞成一次正常关闭
    expect(readVersionPin(pinFile)?.version).toBe(app.version);
    // 发现文件照样清掉：这个进程确实已经不在服务
    expect(existsSync(hostFile)).toBe(false);
  }, 60_000);
});

/**
 * 收尾只做一次。这条钉的是一个真实的窗口：客户端点了升级，`stop("upgrade")` 正在收尾
 * （`db.close()` 走了一半），同一刻又来一条 SIGTERM —— `agents-host stop` 那一路的 `app.stop()`
 * 会再跑一遍，第二次在已经关掉的库上抛，而进程本该安安静静退出去。
 *
 * 所以第二次拿到的必须是**同一句** promise：等第一句，而不是从头再拆一遍。这里连关两次，两次都要
 * 正常返回，发现文件照样清掉（该做的事一件没少，只是没做第二遍）。
 *
 * 不碰网络也不碰模型：起一台宿主、绑端口、写发现文件，然后关两次。
 */
describe("连关两次", () => {
  let dataRoot: string;
  let previousHome: string | undefined;

  beforeAll(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "ai-zen-double-stop-"));
    process.env.AI_ZEN_DIR = dataRoot;
    // 与另几组同口径：用户主目录也指到临时目录，别让用例去读开发机的 `~/.agents`
    previousHome = process.env.HOME;
    process.env.HOME = join(dataRoot, "home");
  }, 60_000);

  afterAll(() => {
    delete process.env.AI_ZEN_DIR;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dataRoot, { recursive: true, force: true });
  }, 60_000);

  it("连关两次不会抛：第二次等的是同一次收尾", async () => {
    const app = await HostApp.open({ port: 0, local: true });
    await app.start();

    const hostFile = join(dataRoot, "run", "host.json");
    expect(existsSync(hostFile)).toBe(true);

    // 两句在同一刻发出：第二句进来时第一句正在收尾，`await` 下面那几段还没走完
    const first = app.stop();
    const second = app.stop();

    // 两次都正常返回 —— 收尾没有做第二遍，进程不炸
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    // 该做的事一件没少：发现文件清掉了，这台机器上不再有宿主在服务
    expect(existsSync(hostFile)).toBe(false);
  }, 60_000);
});

/**
 * 客户端关掉宿主（`host.shutdown`）。
 *
 * 四条：答复先写回、`stop` 真的被走到、退出码是正常关闭的那个 0、正常关闭把 pin 清掉。
 *
 * 第一条最要紧，也最只能在这一组验：收尾会把连接断掉，答复没出去的话客户端只看得到「连不上了」。
 * 所以这里起一台真的宿主、用真的 ws 客户端调这一条 —— 答复到底有没有过网，只有真的过一遍才算数。
 * 连着的客户端不去先踢掉：带着连接关正是要验的处境（一台机器一个宿主，关它就是把这一台关掉）。
 *
 * `exit` 是可注入的，注一个记账的替身：真的 `process.exit` 会把整个用例进程带走。也不碰网络与
 * 模型 —— 这条路上一个请求都不发。
 */
describe("关掉宿主", () => {
  let dataRoot: string;
  let pinFile: string;
  let previousHome: string | undefined;

  beforeAll(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "ai-zen-shutdown-"));
    pinFile = join(dataRoot, "run", "next-version.json");

    process.env.AI_ZEN_DIR = dataRoot;
    // 与另几组同口径：用户主目录也指到临时目录，别让用例去读开发机的 `~/.agents`
    previousHome = process.env.HOME;
    process.env.HOME = join(dataRoot, "home");
  }, 60_000);

  afterAll(() => {
    delete process.env.AI_ZEN_DIR;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dataRoot, { recursive: true, force: true });
  }, 60_000);

  it("答复先到，随后是收尾与退出码 0", async () => {
    // 上一次升级留下的那条 pin：正常关闭要把它清掉，否则启动方式会照着它把服务又拉起来
    writeVersionPin(pinFile, { version: "9.9.9", requestedAt: new Date().toISOString() });

    const exits: number[] = [];
    const app = await HostApp.open({
      port: 0,
      local: true,
      exit: (code) => exits.push(code),
    });
    await app.start();

    const hostFile = join(dataRoot, "run", "host.json");
    expect(existsSync(hostFile)).toBe(true);
    // 启动只清「跑着的这一版」那条 pin，9.9.9 不是它，所以跑起来之后它还在
    expect(readVersionPin(pinFile)?.version).toBe("9.9.9");

    const client = await HostClient.connect(
      app.address.port,
      readFileSync(join(dataRoot, "run", "token"), "utf8").trim(),
    );

    // 答复先写回：这一句兑现得到 `{ accepted: true }`，就说明它在连接被断掉之前出去了
    await expect(client.mutation("host.shutdown", undefined)).resolves.toEqual({ accepted: true });

    // 退出推后一拍，所以这里等它：正常关闭的那个码，不是升级专用的 75
    await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 10_000, interval: 20 });

    // `stop` 真的被走到的两条痕迹：发现文件清掉，这条连接被断掉
    expect(existsSync(hostFile)).toBe(false);
    await client.whenClosed();

    // 正常关闭清 pin。这一格与「答复先写回」是一体的：pin 的去留只听 stop 的判据，这里不自己判
    expect(existsSync(pinFile)).toBe(false);
  }, 60_000);
});

/**
 * 自动起名这一段只在装配根上验得了：判据与那一次请求都在 `AutoNamer` 里，而「谁在什么时候叫它」
 * 是 `app.ts` 的一件事 —— 单测验得了前者，验不了「装配根到底接上没有」。
 *
 * 两句都用同一个假端点：流式那一支是执行体的请求，不流式那一支是起名。起手那份配置里没有
 * `namingModel`，于是起名用的模型落回 `defaultModel` —— 与 SDK 那条一次性补全走的是同一套解析。
 */
describe("自动起名", () => {
  const workspaceId = randomUUID();
  let dataRoot: string;
  let previousHome: string | undefined;
  let model: { origin: string; server: Server };
  let app: HostApp;
  let client: HostClient;
  /** 宿主推出来的每一条事件，按到达顺序 */
  let events: HostEvent[];

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ai-zen-autoname-"));
    model = await startModelServer();

    const projectDir = join(dataRoot, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(dataRoot, "config.json"),
      JSON.stringify(
        {
          endpoints: [
            {
              id: "local",
              name: "Local",
              baseUrl: `${model.origin}/v1`,
              apiKey: "local-test-key",
            },
          ],
          models: [
            {
              id: "local-model",
              name: "Local",
              endpointId: "local",
              modelName: "local-model",
              tokenThresholds: { handoff: 250_000, guard: 375_000 },
              // 出厂模型清单是托管清单，不标 custom 的条目会在启动时被替换掉
              custom: true,
            },
          ],
          // 只写全局兜底那一格：起名用的模型从它落过来
          defaultModel: "local-model",
          language: "zh",
        },
        null,
        2,
      ),
    );

    mkdirSync(join(dataRoot, "agents"), { recursive: true });
    writeFileSync(
      join(dataRoot, "agents", "default.json"),
      JSON.stringify(
        {
          id: "default",
          name: "Default Assistant",
          modelId: "local-model",
          messages: [Message.System("You are a test assistant.")],
          permissions: {
            tools: { allow: ["*"] },
            skills: { allow: ["*"] },
            mcps: { allow: ["*"] },
            subagents: { allow: ["*"] },
          },
          custom: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    const db = openDatabase(join(dataRoot, "ai-zen.db"));
    workspaceTable(db).put({
      id: workspaceId,
      name: "起名",
      cwd: projectDir,
      createdAt: Date.now(),
    });
    db.close();

    process.env.AI_ZEN_DIR = dataRoot;
    // 与另几组同口径：用户主目录也指到临时目录，别让用例去读开发机的 `~/.agents`
    previousHome = process.env.HOME;
    process.env.HOME = join(dataRoot, "home");

    app = await HostApp.open({ port: 0 });
    await app.start();
    client = await HostClient.connect(
      app.address.port,
      readFileSync(join(dataRoot, "run", "token"), "utf8").trim(),
    );
    events = [];
    await client.subscribe("events", (payload) => events.push(payload as HostEvent));
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await app?.stop();
    await new Promise<void>((resolve) => model?.server.close(() => resolve()));
    delete process.env.AI_ZEN_DIR;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dataRoot, { recursive: true, force: true });
  }, 60_000);

  /** 建一段会话递一句话，等这一段转闲 —— 起名就挂在这一拍上 */
  async function say(content: string): Promise<string> {
    // 从递出去那一刻往后看：上一句话也会让这一段闲一次，那样等到的就是上一次的那一拍
    const before = events.length;
    const sent = await client.mutation<{ sessionId: string; messageId: string }>("agent.send", {
      workspaceId,
      agentId: "default",
      content,
      messageId: randomUUID(),
    });

    const idled = () =>
      events
        .slice(before)
        .some(
          (event) =>
            event.type === "agent.status" &&
            event.sessionId === sent.sessionId &&
            event.status === "idle",
        );
    await vi.waitFor(() => expect(idled()).toBe(true), { timeout: 30_000, interval: 20 });

    return sent.sessionId;
  }

  function rowOf(rows: readonly Session[], sessionId: string): Session | undefined {
    return rows.find((row) => row.id === sessionId);
  }

  it("第一次答完之后名字换成模型给的那一个，nameIsAuto 仍为真", async () => {
    const sessionId = await say("帮我把宿主的交接写出来");

    await vi.waitFor(
      async () => {
        const rows = await client.query<Session[]>("session.list", { workspaceId });
        // 名字换了，而那一格仍然归自动：下一个名字还能换掉它
        expect(rowOf(rows, sessionId)).toMatchObject({ name: TITLE, nameIsAuto: true });
      },
      { timeout: 30_000, interval: 50 },
    );
  }, 60_000);

  it("起名失败推一条会话内通知，而这一段照旧能说话", async () => {
    const sessionId = await say(`帮我把这一段的名字换掉，${NAMING_FAILS_ON}`);

    await vi.waitFor(
      async () => {
        const notices = await client.query<Notice[]>("notice.list", { sessionId });
        expect(notices).toContainEqual(
          expect.objectContaining({
            level: "warning",
            code: "auto_title_failed",
            sessionId,
            // 句子在产生处渲染好再落库：用户之后改了语言，这一条保留当时那一种
            message: "这一段会话自动起名失败，名字还是创建时的那一个",
          }),
        );
      },
      { timeout: 30_000, interval: 50 },
    );

    // 名字仍是创建时那一串时刻：失败不是「换了个名字」
    const rows = await client.query<Session[]>("session.list", { workspaceId });
    expect(rowOf(rows, sessionId)?.name).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 照旧能说话：再递一句，模型的话照样流回来
    const before = events.length;
    await say("再说一句");
    const said = events
      .slice(before)
      .flatMap((event) => (event.type === "message.changed" ? [event.message] : []));
    expect(said.map(textOf)).toContain(REPLY.join(""));
  }, 60_000);
});
