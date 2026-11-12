/**
 * 对**真服务端**的验收：一次性的 `createServer` + 真 socket + 本包的 `Client`。
 *
 * 假服务端能钉住客户端的行为，但钉不住「两边的形状对得上」：握手返回什么、业务错误的
 * `data` 长什么样、`message.list` 的 `anchor` 怎么给、`ensureServer` 读的发现文件与凭证与服务端
 * 写的到底是不是同一份。这几件事只有真实例能回答。
 *
 * 服务端起在端口 0（系统分配）、数据根是临时目录，退出动作换成记账（不把测试进程送走）。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer, ServerApp } from "@ai-zen/agents-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClientInfo } from "@ai-zen/agents-server";

import { Client } from "./client.js";
import { ensureServer, readServerFile, tokenFilePath } from "./connection.js";
import type { ClientError } from "./errors.js";
import type { ServerTarget } from "./address.js";
import { parseIncoming } from "./frames.js";
import { uploadAsset, uploadAssets, DEFAULT_MAX_ASSET_BYTES } from "./upload.js";

const CLIENT_INFO: ClientInfo = { name: "test-client", version: "0.0.0-test" };

/** 假端点 / 假模型：这几条用例不连模型，只要配置能装配起来 */
const CONFIG = JSON.stringify({
  endpoints: [
    { id: "fake", name: "Fake", baseUrl: "https://example.invalid/v1", apiKey: "sk-fake-key" },
  ],
  models: [
    {
      id: "test-model",
      name: "Test Model",
      endpointId: "fake",
      tokenThresholds: { handoff: 1000, guard: 2000 },
      custom: true,
    },
  ],
});

const AGENT = JSON.stringify({
  id: "default",
  name: "Test Assistant",
  modelId: "test-model",
  messages: [{ id: "sys-1", role: "system", status: "completed", content: "你是测试助手。" }],
  custom: true,
});

let dataRoot = "";
let workspaceDir = "";
let app: ServerApp | null = null;
let target: ServerTarget;
let token = "";
const clients: Client[] = [];

beforeAll(async () => {
  dataRoot = await fs.mkdtemp(join(tmpdir(), "ai-zen-client-it-"));
  workspaceDir = await fs.mkdtemp(join(tmpdir(), "ai-zen-client-it-cwd-"));
  await fs.mkdir(join(dataRoot, "agents"), { recursive: true });
  await fs.writeFile(join(dataRoot, "config.json"), CONFIG, "utf8");
  await fs.writeFile(join(dataRoot, "agents", "default.json"), AGENT, "utf8");

  app = await createServer({
    aiZenDir: dataRoot,
    port: 0,
    local: true,
    // 退出动作换成记账：这是用例进程，不能被服务端的退出判据送走
    exit: () => undefined,
    logger: { warn: () => undefined, error: () => undefined },
  });
  await app.start();

  const address = app.address;
  if (!address) throw new Error("服务端没在监听");
  target = { host: "127.0.0.1", port: address.port };
  token = (await fs.readFile(tokenFilePath(dataRoot), "utf8")).trim();
});

afterAll(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await app?.stop("requested").catch(() => undefined);
  await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

async function connect(language: string): Promise<Client> {
  const client = await Client.connect({ target, token, clientInfo: CLIENT_INFO, language });
  clients.push(client);
  return client;
}

describe("握手", () => {
  it("拿真服务端的握手结果，并协商出语言", async () => {
    const client = await connect("zh");

    expect(client.connected).toBe(true);
    expect(client.hello?.language).toBe("zh");
    expect(client.hello?.protocolVersion).toBe("1");
    expect(client.hello?.serverVersion).not.toBe("");
    // 握手只回能力 id 列表（R57），清单本身走 server.capabilities
    expect(client.hello?.capabilities.length).toBeGreaterThan(0);
    expect(client.hello?.limits.maxAssetsPerMessage).toBeGreaterThan(0);
  });

  it("还没握手就发方法：服务端回 unauthorized（hello_required）", async () => {
    // 用一条裸连接验证服务端那道门（`Client` 自己也会在本地挡住，两条都该成立）
    const socket = new WebSocket(`ws://${target.host}:${target.port}`);
    try {
      const reply = await new Promise<unknown>((resolve, reject) => {
        socket.addEventListener("open", () => {
          socket.send(
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "conversation.list", params: {} }),
          );
        });
        socket.addEventListener("message", (event) => resolve(event.data));
        socket.addEventListener("error", reject);
        setTimeout(() => reject(new Error("服务端没有回话")), 2_000);
      });

      const frame = parseIncoming(String(reply));
      expect(frame?.kind).toBe("error");
      if (frame?.kind === "error") {
        expect(frame.frame.error.data.code).toBe("unauthorized");
        expect(frame.frame.error.data.detail).toEqual({ reason: "hello_required" });
      }
    } finally {
      socket.close();
    }
  });
});

describe("调用与错误", () => {
  it("方法调用：server.version 报出 pid 与版本", async () => {
    const client = await connect("zh");
    const version = await client.call("server.version");
    expect(version.protocolVersion).toBe("1");
    expect(version.pid).toBeGreaterThan(0);
  });

  it("业务错误原样到 ClientError，且文案跟着连接语言走（服务端出文案）", async () => {
    const zh = await connect("zh");
    const en = await connect("en");
    const params = { conversationId: "not-a-real-conversation" };

    const zhError = (await zh
      .call("conversation.get", params)
      .catch((caught: unknown) => caught)) as ClientError;
    const enError = (await en
      .call("conversation.get", params)
      .catch((caught: unknown) => caught)) as ClientError;

    expect(zhError.code).toBe("not_found");
    expect(enError.code).toBe("not_found");
    expect(zhError.fromServer).toBe(true);
    // 同一个失败、两种语言：客户端没有自己的那份文案，句子是服务端按连接渲染的
    expect(zhError.message).not.toBe("");
    expect(enError.message).not.toBe("");
    expect(zhError.message).not.toBe(enError.message);
  });

  it("setLanguage 立刻改这条连接的话术", async () => {
    const client = await connect("en");
    const before = (await client
      .call("conversation.get", { conversationId: "nope" })
      .catch((caught: unknown) => caught)) as ClientError;

    expect(await client.setLanguage("zh")).toBe("zh");
    const after = (await client
      .call("conversation.get", { conversationId: "nope" })
      .catch((caught: unknown) => caught)) as ClientError;

    expect(after.message).not.toBe(before.message);
  });
});

describe("补拉（A12 的真语义）", () => {
  it("空对话：state 拉得回来，消息是空的、mode 是全量", async () => {
    const client = await connect("zh");
    const { workspace } = await client.call("workspace.create", { cwd: workspaceDir });
    const created = await client.call("conversation.create", {
      workspaceId: workspace.id,
      agentId: "default",
    });
    if (!created.conversation) throw new Error("对话没建出来");
    const conversationId = created.conversation.id;

    const resumed = await client.resume(conversationId);

    expect(resumed.state.conversationId).toBe(conversationId);
    expect(resumed.state.run.status).toBe("idle");
    expect(resumed.messages).toEqual([]);
    expect(resumed.mode).toBe("full");
  });
});

describe("上传（asset.begin / 二进制帧 / asset.end）对真实例", () => {
  /** 一小段字节：内容不重要，重要的是长度与摘要能原样到达服务端 */
  const PAYLOAD = new Uint8Array(2048).map((_, index) => (index * 7) % 251);

  /** 建一个项目 + 一段对话，并把这段对话**先落库**（R56：`conversation.create` 只是草稿） */
  async function persistedConversation(client: Client): Promise<string> {
    const cwd = await fs.mkdtemp(join(tmpdir(), "ai-zen-client-upload-"));
    const { workspace } = await client.call("workspace.create", { cwd });
    const created = await client.call("conversation.create", {
      workspaceId: workspace.id,
      agentId: "default",
    });
    if (!created.conversation) throw new Error("对话没建出来");
    const conversationId = created.conversation.id;

    // 草稿落库靠第一轮 `conversation.send`（它内部调 `ensurePersisted`）：先发一句话，
    // 再把这一轮停掉 —— 这一段的目的是「让对话在库里有一行」，不是为了跑模型
    await client.call("conversation.send", { conversationId, input: { content: "先落库" } });
    await client.call("conversation.abort", { conversationId }).catch(() => undefined);
    await idle(client, conversationId);
    return conversationId;
  }

  it("上传一张图：assets/ 下落了文件、asset.end 回了 AssetRef、send 的 attachments 里有它", async () => {
    const client = await connect("zh");
    const conversationId = await persistedConversation(client);

    const asset = await uploadAsset(client, {
      conversationId,
      data: PAYLOAD,
      mime: "image/png",
      name: "probe.png",
      chunkSize: 512,
    });

    // `asset.end` 回的引用：尺寸与摘要都是服务端复核过的那一份
    expect(asset.assetId).not.toBe("");
    expect(asset.mime).toBe("image/png");
    expect(asset.bytes).toBe(PAYLOAD.byteLength);
    expect(asset.name).toBe("probe.png");

    // 真实落盘：`<数据根>/assets/` 下多了一份字节完全一致的文件
    const stored = (await fs.readdir(join(dataRoot, "assets"))).filter(
      (name) => !name.startsWith(".upload-"),
    );
    expect(stored.some((name) => name.startsWith(asset.assetId))).toBe(true);
    const fileName = stored.find((name) => name.startsWith(asset.assetId)) as string;
    const written = await fs.readFile(join(dataRoot, "assets", fileName));
    expect(new Uint8Array(written)).toEqual(PAYLOAD);

    // 带着 assetId 发一轮：`attachments` 里就是这一张的结局
    const accepted = await client.call("conversation.send", {
      conversationId,
      input: { content: "看看这张", assetIds: [asset.assetId] },
    });
    expect(accepted.attachments).toHaveLength(1);
    expect(accepted.attachments[0]?.assetId).toBe(asset.assetId);
    expect(["file_reference", "inline", "text_fallback", "dropped"]).toContain(
      accepted.attachments[0]?.deliveredAs,
    );
    // 没送出去时要带上服务端渲染好的原因（F-H7：不假成功）
    if (accepted.attachments[0]?.deliveredAs === "dropped") {
      expect(accepted.attachments[0]?.problem?.message).toBeTruthy();
    }

    // 这一轮会去连配置里的假端点（必然失败），收摊时把它停掉
    await client.call("conversation.abort", { conversationId }).catch(() => undefined);
  }, 30_000);

  it("超过一张上限：多出来的逐条报告，前 4 张照常上传", async () => {
    const client = await connect("zh");
    const conversationId = await persistedConversation(client);

    // 本地前置校验用的就是这条上限：真服务端的 `hello.limits.maxAssetBytes`
    expect(client.hello?.limits.maxAssetBytes).toBe(DEFAULT_MAX_ASSET_BYTES);

    const result = await uploadAssets(client, {
      conversationId,
      sources: [
        { data: PAYLOAD, mime: "image/png", name: "1.png" },
        { data: PAYLOAD, mime: "image/png", name: "2.png" },
        { data: PAYLOAD, mime: "image/png", name: "3.png" },
        { data: PAYLOAD, mime: "image/png", name: "4.png" },
        { data: PAYLOAD, mime: "image/png", name: "5.png" },
      ],
    });

    expect(result.assets).toHaveLength(4);
    expect(result.failures.map((failure) => failure.name)).toEqual(["5.png"]);
    expect(result.failures[0]?.error.code).toBe("asset_count_exceeded");
  }, 30_000);

  it("草稿对话（R56 还没落库）：上传到 asset.end 被服务端的外键拒掉，不是静默成功", async () => {
    // 这条用例钉的是**服务端的现状**：`assets.conversationId` 外键指向 `conversations`，
    // 而草稿在首次 `send` 之前不在那张表里。服务端哪天补上「上传前先落库」，这条会红，
    // 那时 CLI 里「草稿上不尝试上传」的分支也该一起删
    const client = await connect("zh");
    const cwd = await fs.mkdtemp(join(tmpdir(), "ai-zen-client-draft-"));
    try {
      const { workspace } = await client.call("workspace.create", { cwd });
      const created = await client.call("conversation.create", {
        workspaceId: workspace.id,
        agentId: "default",
      });
      if (!created.conversation) throw new Error("对话没建出来");

      const error = (await uploadAsset(client, {
        conversationId: created.conversation.id,
        data: PAYLOAD,
        mime: "image/png",
      }).catch((caught: unknown) => caught)) as ClientError;

      expect(error.code).toBe("internal");
      // 一个字节都没留下来：临时文件在 `asset.end` 失败时已被服务端删掉
      const leftovers = (await fs.readdir(join(dataRoot, "assets"))).filter((name) =>
        name.startsWith(".upload-"),
      );
      expect(leftovers).toEqual([]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

/** 等这段对话不在跑（`conversation.send` 在跑的时候会 `busy`） */
async function idle(client: Client, conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { state } = await client.call("conversation.state", { conversationId });
    if (state.run.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("这一轮一直没有结算");
}

describe("ensureServer 对真实例", () => {
  it("发现文件里有活实例：直接连上，不拉起（started=false）", async () => {
    let spawned = 0;
    const result = await ensureServer({
      dataRoot,
      clientInfo: CLIENT_INFO,
      settings: { mode: "local", language: "zh" },
      spawnServer: async () => {
        spawned += 1;
      },
    });
    clients.push(result.client);

    expect(spawned).toBe(0);
    expect(result.started).toBe(false);
    expect(result.explicit).toBe(false);
    expect(result.target).toEqual(target);
    expect(result.client.connected).toBe(true);
    expect(result.client.language).toBe("zh");
  });
});

describe("真拉起一个服务端进程（end-to-end）", () => {
  it("没有实例时 spawn `agents-server serve`，轮询到就绪、连上、再让它退出", async () => {
    const freshRoot = await fs.mkdtemp(join(tmpdir(), "ai-zen-client-spawn-"));
    let pid: number | null = null;
    try {
      const result = await ensureServer({
        dataRoot: freshRoot,
        clientInfo: CLIENT_INFO,
        settings: { mode: "local" },
        timeoutMs: 30_000,
        retryIntervalMs: 100,
      });
      clients.push(result.client);

      expect(result.started).toBe(true);
      expect(result.explicit).toBe(false);

      // 发现文件是客户端认地址的唯一来源：这里的 pid 就是被拉起那个进程
      pid = (await readServerFile(freshRoot))?.pid ?? null;
      expect(pid).not.toBeNull();
      const version = await result.client.call("server.version");
      expect(version.pid).toBe(pid);

      // 收摊：用契约里的 server.shutdown（进程随后自己退出），不让测试进程里留下常驻服务端
      await result.client.call("server.shutdown", { reason: "test" });
    } finally {
      if (pid !== null) {
        for (let index = 0; index < 100 && isAlive(pid); index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (isAlive(pid)) process.kill(pid);
      }
      await fs.rm(freshRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

/** 这个 pid 还在不在（`kill(pid, 0)` 只做存在性检查，不发信号） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
