/**
 * 一条对着**真宿主**的用例：真端口、真连，中间没有任何替身。
 *
 * 起一台 `HostApp`（`port: 0`、本机实例、临时数据根），用这个包交出去的 `connect` 连上去，
 * 然后把客户端要做的五件事按顺序走一遍：握手（对令牌 / 错令牌）、建项目与列会话、订阅事件、
 * 传一份素材再取回来、关掉之后调用当场失败。
 *
 * 模型不出网：`@ai-zen/agents-testing` 的假端点回一段流式答复，地址写进 `config.json` 的端点。
 * 这样验的是「一句话真的走到了执行体、它说的话真的从事件流里回来了」，而不是把请求层整个打掉。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Message } from "@ai-zen/agents-core";
import { HostApp } from "@ai-zen/agents-host";
import { startFakeLlm, type FakeLlm } from "@ai-zen/agents-testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { webSocketUrl, type HostTarget } from "./address.js";
import { getAsset, uploadAsset } from "./asset.js";
import { connect, type HostClient } from "./client.js";
import { fromTRPCError, type ClientError } from "./errors.js";

/** 假端点要说的话；切成几片发，且片间留 80ms —— 于是流式那几侧真的有一段中间态 */
const REPLY = "The local endpoint received this line.";

/** 发出去的那句话 */
const SAID = "hello, local endpoint";

/** 一张 1×1 的 PNG（几十字节，够走完整条上传与取回的路） */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+g7oAAAAASUVORK5CYII=",
  "base64",
);

/**
 * 直接用 `api` 时拿到的是 tRPC 自己的错误：宿主写进去的两格在 `data` 上。
 *
 * `data.hostCode` 是宿主自己的码（语义层，`fromTRPCError` 认它），`data.code` 是 tRPC 的码
 * （传输层）。两格都验一次，是为了「两个码并存」这件事在真宿主上也看得见。
 */
function hostCodeOf(error: unknown): unknown {
  return (error as { data?: { hostCode?: unknown } }).data?.hostCode;
}

function codeOf(error: unknown): unknown {
  return (error as { data?: { code?: unknown } }).data?.code;
}

/** 收到的这些事件里有没有这一条状态（`working` = 开跑了，`idle` = 这一轮跑完了） */
function stated(events: readonly unknown[], status: "working" | "idle"): boolean {
  return events.some(
    (event) =>
      (event as { type?: unknown }).type === "agent.status" &&
      (event as { status?: unknown }).status === status,
  );
}

let dataRoot: string;
let previousDataRoot: string | undefined;
let previousHome: string | undefined;
let llm: FakeLlm;
let app: HostApp;
let target: HostTarget;
let token: string;

/** 用例之间共用的那一条连接（握手那一条用例连它自己的） */
let client: HostClient;
/** 第一段会话：事件那一条用例发话时建出来，后面的用例接着用 */
let workspaceId: string;

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "ai-zen-client-host-"));
  llm = await startFakeLlm({ reply: REPLY, chunks: 3, chunkDelayMs: 80 });

  writeFileSync(
    join(dataRoot, "config.json"),
    JSON.stringify(
      {
        endpoints: [
          {
            id: "local",
            name: "Local",
            baseUrl: `${llm.baseUrl}/v1`,
            apiKey: "local-test-key",
          },
        ],
        models: [
          {
            id: "local-model",
            name: "Local",
            endpointId: "local",
            modelName: "fake-model",
            tokenThresholds: { handoff: 250_000, guard: 375_000 },
            // 出厂模型清单是托管清单，不标 custom 的条目会在启动时被替换掉
            custom: true,
          },
        ],
        defaultModel: "local-model",
        language: "en",
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

  // 数据根与用户主目录都指到临时目录：否则这条用例会去读开发机的 `~/.agents`，结果跟着机器变
  previousDataRoot = process.env.AI_ZEN_DIR;
  previousHome = process.env.HOME;
  process.env.AI_ZEN_DIR = dataRoot;
  process.env.HOME = join(dataRoot, "home");

  app = await HostApp.open({ port: 0 });
  await app.start();
  target = { host: app.address.host, port: app.address.port };
  // 令牌只从本机交付文件读：文件里那一串带一个末尾换行，不 trim 就永远验不过
  token = readFileSync(join(dataRoot, "run", "token"), "utf8").trim();

  workspaceId = randomUUID();
  client = await connect({ url: webSocketUrl(target), token });
}, 60_000);

afterAll(async () => {
  await client?.close();
  await app?.stop();
  await llm?.close();
  if (previousDataRoot === undefined) delete process.env.AI_ZEN_DIR;
  else process.env.AI_ZEN_DIR = previousDataRoot;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(dataRoot, { recursive: true, force: true });
}, 60_000);

describe("握手：令牌只从握手帧上来", () => {
  it("run/token 里那一串连得上", async () => {
    // 这条连接在 beforeAll 里就建成了；能调通一次就是「握手成了」的判据
    const { version } = await client.api.host.version.query();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  }, 30_000);

  it("同一台宿主、错令牌 → 失败，而且是宿主说的 unauthorized", async () => {
    const error = (await connect({ url: webSocketUrl(target), token: "forged-token" }).catch(
      (caught: unknown) => caught,
    )) as ClientError;

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("unauthorized");
    // 那句话是宿主按语言渲染好的那一句，客户端不改写
    expect(error.message.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("调用：类型直达宿主", () => {
  it("建项目、列会话（新项目里一段会话都没有）", async () => {
    const cwd = join(dataRoot, "project");
    mkdirSync(cwd, { recursive: true });

    const { workspace } = await client.api.workspace.create.mutate({ cwd, name: "用例项目" });
    expect(workspace.id).toEqual(expect.any(String));
    expect(workspace.cwd).toBe(cwd);

    const sessions = await client.api.session.list.query({ workspaceId: workspace.id });
    expect(sessions).toEqual([]);

    // 后面几条用例往这个项目里发话
    workspaceId = workspace.id;
  }, 30_000);

  it("调用失败时拿到的是宿主的码与它渲染好的那句（找不到会话）", async () => {
    const error = await client.api.session.open
      .query({ sessionId: randomUUID() })
      .catch((caught: unknown) => caught);

    expect(hostCodeOf(error)).toBe("not_found");
    // tRPC 那一格照旧写着（传输层与没升级的客户端用它）
    expect(codeOf(error)).toBe("NOT_FOUND");
    expect(fromTRPCError(error).code).toBe("not_found");
  }, 30_000);
});

describe("事件流", () => {
  it("发一句话：收得到 message.added 与 agent.status", async () => {
    const events: unknown[] = [];
    const unsubscribe = client.subscribe((event) => events.push(event));

    try {
      const sent = await client.api.agent.send.mutate({
        workspaceId,
        agentId: "default",
        content: SAID,
        messageId: randomUUID(),
      });

      await vi.waitFor(() => expect(stated(events, "idle")).toBe(true), {
        timeout: 30_000,
        interval: 20,
      });

      const added = events.filter(
        (event) => (event as { type: string }).type === "message.added",
      ) as { message: { id: string; content: unknown } }[];
      expect(added.map((event) => event.message.id)).toContain(sent.messageId);

      // 模型说的话是流回来的：至少一条 message.changed
      const changed = events.filter(
        (event) => (event as { type: string }).type === "message.changed",
      );
      expect(changed.length).toBeGreaterThan(0);

      // 历史在宿主那一边一次取全（客户端不维护镜像）
      const opened = await client.api.session.open.query({ sessionId: sent.sessionId });
      expect(opened.messages.length).toBeGreaterThanOrEqual(2);
    } finally {
      unsubscribe();
    }
  }, 60_000);

  it("退订之后不再收到事件（退订幂等）", async () => {
    const dropped: unknown[] = [];
    const unsubscribe = client.subscribe((event) => dropped.push(event));
    unsubscribe();
    unsubscribe();

    // 另一条订阅当作「这件事真的发生过」的证据：它收到转闲之后再断言被退掉的那条一片都没有
    const witness: unknown[] = [];
    const stop = client.subscribe((event) => witness.push(event));
    try {
      await client.api.agent.send.mutate({
        workspaceId,
        agentId: "default",
        content: "another line",
        messageId: randomUUID(),
      });
      await vi.waitFor(() => expect(stated(witness, "idle")).toBe(true), {
        timeout: 30_000,
        interval: 20,
      });
      expect(dropped).toEqual([]);
    } finally {
      stop();
    }
  }, 60_000);
});

describe("素材：传上去再取回来", () => {
  it("几字节的 PNG 上去、按 id 下来，逐字节相同", async () => {
    const path = join(dataRoot, "dot.png");
    writeFileSync(path, PNG);

    const asset = await uploadAsset(client, { path, name: "dot.png" });
    expect(asset.mime).toBe("image/png");
    expect(asset.name).toBe("dot.png");

    const fetched = await getAsset(client, { assetId: asset.id });
    expect(fetched.mime).toBe("image/png");
    expect(Buffer.from(fetched.bytes).equals(PNG)).toBe(true);
  }, 30_000);

  it("同一份字节再传一次：宿主按内容摘要去重，回来的还是那一行", async () => {
    const first = await uploadAsset(client, { data: PNG, mime: "image/png" });
    const second = await uploadAsset(client, { data: PNG, mime: "image/png" });

    expect(second.id).toBe(first.id);
  }, 30_000);

  it("取一份不存在的素材：宿主的 not_found 原样出来", async () => {
    const error = (await getAsset(client, { assetId: randomUUID() }).catch(
      (caught: unknown) => caught,
    )) as ClientError;

    expect(error.code).toBe("not_found");
  }, 30_000);
});

describe("撤回：跑着的时候不许撤", () => {
  it("正在跑的那一段：客户端拿到 busy，而不是被折成一个说不清的 CONFLICT", async () => {
    const events: unknown[] = [];
    const stop = client.subscribe((event) => events.push(event));

    try {
      const sent = await client.api.agent.send.mutate({
        workspaceId,
        agentId: "default",
        content: "rewind me while it runs",
        messageId: randomUUID(),
      });

      // 让那一轮真的在吐：假端点把答复切成三片、片间等 80ms，所以「在干」这一段有几百毫秒的窗口
      await vi.waitFor(() => expect(stated(events, "working")).toBe(true), {
        timeout: 30_000,
        interval: 5,
      });

      const error = await client.api.session.rewind
        .mutate({ sessionId: sent.sessionId, messageId: sent.messageId })
        .catch((caught: unknown) => caught);

      // 宿主那几个码里，`busy` 与 `conflict` 在 tRPC 那一格上是同一个 CONFLICT —— 分得开靠的是 hostCode
      expect(hostCodeOf(error)).toBe("busy");
      expect(codeOf(error)).toBe("CONFLICT");
      expect(fromTRPCError(error).code).toBe("busy");
      // 那句话是宿主按语言渲染好的那一句
      expect(fromTRPCError(error).message.length).toBeGreaterThan(0);

      // 收尾：那一轮照常跑完，不把它挂在半路
      await vi.waitFor(() => expect(stated(events, "idle")).toBe(true), {
        timeout: 30_000,
        interval: 20,
      });

      // 撤回什么都没删掉：那段会话的历史还在（它被拒了，不是做了一半）
      const opened = await client.api.session.open.query({ sessionId: sent.sessionId });
      expect(opened.messages.map((message) => message.id)).toContain(sent.messageId);
    } finally {
      stop();
    }
  }, 60_000);
});

describe("重连的口子", () => {
  it("宿主重启之后 reconnect() 把它接回来，事件流也跟着回来", async () => {
    const events: unknown[] = [];
    const stop = client.subscribe((event) => events.push(event));
    try {
      // 真把宿主停掉再在同一端口上起一台：客户端的 socket 因此真的断了
      const port = target.port;
      await app.stop();
      app = await HostApp.open({ port });
      await app.start();
      target = { host: app.address.host, port: app.address.port };

      await client.reconnect();

      // 库还是那一份：前面建的项目还在
      const sessions = await client.api.session.list.query({ workspaceId });
      expect(sessions.length).toBeGreaterThan(0);

      // 新的执行体是新的会话：不给 sessionId 就是「建一段再递一句」
      await client.api.agent.send.mutate({
        workspaceId,
        agentId: "default",
        content: `after restart ${randomUUID()}`,
        messageId: randomUUID(),
      });
      await vi.waitFor(() => expect(stated(events, "idle")).toBe(true), {
        timeout: 30_000,
        interval: 50,
      });
    } finally {
      stop();
    }
  }, 120_000);
});

describe("关掉之后", () => {
  it("同一个 client 的调用当场失败；再 close 一次不抛", async () => {
    await client.close();

    const error = await client.api.host.version.query().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(fromTRPCError(error).code).toBe("closed");

    // 订阅也静默结束：拿到的是一个什么都不做的退订函数
    const unsubscribe = client.subscribe(() => {
      throw new Error("关掉之后不该再有事件");
    });
    unsubscribe();
    unsubscribe();

    await expect(client.close()).resolves.toBeUndefined();
  }, 30_000);
});
