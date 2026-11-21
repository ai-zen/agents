/**
 * 唯一必须有的那条用例：起一个真的宿主、用真的 ws 客户端连上去、发一句话、收到流。
 *
 * 模型不出网：用例里起一个本地的 OpenAI 兼容端点回一段 SSE，地址写进 `config.json` 的端点。
 * 这样验的是「一句话真的走到了执行体、模型说的话真的流回来了」，而不是把请求层整个打掉。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

import { HostApp } from "./app.js";
import { openDatabase } from "./infra/db.js";
import { Discovery } from "./modules/config/discovery.js";
import type { HostEvent } from "./modules/events.js";
import type { Session } from "./modules/session/types.js";
import { workspaceTable } from "./modules/workspace/table.js";

/** 本地端点要说的话。分成几片，于是流式那一侧真的有多次 `message.changed` */
const REPLY = ["本地端点", "收到了这句话。"];
const SAID = "你好，本地端点";

/** tRPC over WebSocket 的一帧。协议只有这么几格，`@trpc/client` 不在依赖里 */
interface Envelope {
  readonly id: number | null;
  readonly result?: { readonly type?: string; readonly data?: unknown };
  readonly error?: { readonly message?: string };
}

class HostClient {
  private id = 0;
  private readonly waiting = new Map<number, (message: Envelope) => void>();

  private constructor(private readonly socket: WebSocket) {
    this.socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Envelope;
      if (message.id === null) return;
      this.waiting.get(message.id)?.(message);
    });
  }

  static connect(port: number): Promise<HostClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve(new HostClient(socket)));
      socket.once("error", reject);
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

  private async once<T>(method: "query" | "mutation", path: string, input: unknown): Promise<T> {
    const id = this.send(method, path, input);
    const message = await new Promise<Envelope>((resolve) => this.waiting.set(id, resolve));
    this.waiting.delete(id);
    if (message.error !== undefined) throw new Error(message.error.message ?? `${path} rejected`);
    return message.result?.data as T;
  }

  private send(method: string, path: string, input: unknown): number {
    this.id += 1;
    this.socket.send(
      JSON.stringify({ id: this.id, jsonrpc: "2.0", method, params: { path, input } }),
    );
    return this.id;
  }
}

/** 本地的 OpenAI 兼容端点：只认流式补全那一条路 */
function startModelServer(): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    request.resume();
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const base = {
      id: "chatcmpl-local",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "local-model",
    };
    const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);

    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
    for (const piece of REPLY) {
      send({ ...base, choices: [{ index: 0, delta: { content: piece } }] });
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    send({
      ...base,
      choices: [],
      usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
    });
    response.write("data: [DONE]\n\n");
    response.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, server });
    });
  });
}

/** 消息正文可能是多模态段数组，这条用例只说一句纯文本 */
function textOf(message: AgentNS.Message): string {
  return String(message.content ?? "");
}

describe("宿主跑起来", () => {
  const workspaceId = randomUUID();
  let dataRoot: string;
  let previousHome: string | undefined;
  let model: { origin: string; server: Server };
  let app: HostApp;
  let client: HostClient;

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

    // 这一波还没有建项目的 procedure，项目行只能先写进去；会话挂在外键上，没有它插不进去
    const cwd = join(dataRoot, "project");
    mkdirSync(cwd, { recursive: true });
    const db = openDatabase(join(dataRoot, "ai-zen.db"));
    workspaceTable(db).put({ id: workspaceId, name: "用例项目", cwd, createdAt: Date.now() });
    db.close();

    process.env.AI_ZEN_DIR = dataRoot;
    // 用户主目录那几层也要指到临时目录：否则这条用例会去读开发机的 `~/.agents/skills`，
    // 于是結果跟着机器变 —— 那是「单跑绿、合跑红」的典型来源。
    previousHome = process.env.HOME;
    process.env.HOME = join(dataRoot, "home");
    app = await HostApp.open({ port: 0 });
    await app.start();
    client = await HostClient.connect(app.port);
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
