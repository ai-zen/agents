/**
 * `WsHub` 的端到端验收：真的起一个 `ws` 服务器（端口 `0`，由系统分配），真的连 `ws` 客户端。
 *
 * 覆盖这几条属于接线层的规矩：
 *   - 首帧必须是 `hello`；未握手时除 `hello` 之外一律 `unauthorized`，错误凭证也进不来；
 *   - 分发走注入的 handler 表，没注册的方法回 `unsupported`；
 *   - 错误出网是「业务码 + 按这条连接语言渲染的句子 + detail」，非业务错误只说 internal；
 *   - 推送是通知帧（无 id），不重放；
 *   - `conversation.send` 这类方法的推送排在回包之后（R47），且按对话分别缓冲；
 *   - 二进制帧四段上传，超限在 `begin` 就拒，断线清掉临时文件。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { render, type Language } from "../i18n/index.js";
import { MAX_ASSET_BYTES, PROTOCOL_VERSION, HostError } from "../wire/index.js";
import type {
  AssetRef,
  ConversationSendResult,
  EventMap,
  EventName,
  WorkspaceCreateResult,
} from "../wire/index.js";
import { UploadReceiver, encodeChunkFrame, type UploadFinalizeRequest } from "./UploadReceiver.js";
import { WsHub, type EventLocalizer, type HandlerTable, type HubLogger, type WsHubOptions } from "./WsHub.js";
import {
  isError,
  isNotification,
  isSuccess,
  listDir,
  makeTempDir,
  TestClient,
  wait,
  type TempDir,
} from "./TestSupport.js";

const TOKEN = "good-token";
const NOW = "2026-11-12T00:00:00.000Z";

let dir: TempDir;
let assetsDir: string;
let hub: WsHub;
let url: string;
let clients: TestClient[];
let finalized: UploadFinalizeRequest[];
let logged: { level: "warn" | "error"; message: string; detail?: unknown }[];
let hubReference: WsHub | null;


beforeEach(async () => {
  dir = await makeTempDir("ws-hub");
  assetsDir = join(dir.path, "assets");
  clients = [];
  finalized = [];
  logged = [];
  hubReference = null;
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await hub?.close();
  await dir.remove();
});

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

function pushFromHandler<E extends EventName>(event: E, payload: EventMap[E]): void {
  if (!hubReference) throw new Error("hub 还没建好");
  hubReference.push(event, payload);
}

/** 假的 handler 表：这里只验分发，不验业务 */
function handlers(): HandlerTable {
  return {
    "workspace.create": (context): WorkspaceCreateResult => ({
      workspace: {
        id: "ws-1",
        name: context.params.name ?? context.params.cwd,
        folder: { cwd: context.params.cwd, exists: true },
        createdAt: NOW,
        updatedAt: NOW,
        conversationCount: 0,
        lastActivityAt: null,
      },
    }),

    // 受理即返回、事件紧跟：R47 要缓冲的正是这种
    "conversation.send": (context): ConversationSendResult => {
      pushFromHandler("message.delta", {
        conversationId: context.params.conversationId,
        messageId: "m-1",
        delta: { content: "hi" },
        at: NOW,
      });
      // 另一段对话的推送不该跟着被拦住
      pushFromHandler("message.delta", {
        conversationId: "another-conversation",
        messageId: "m-2",
        delta: { content: "other" },
        at: NOW,
      });
      return {
        userMessageId: "u-1",
        attachments: [],
      };
    },

    // 业务错误：按连接语言渲染
    "conversation.get": () => {
      throw new HostError("not_found", { params: { entity: "conversation" } });
    },

    // 非业务错误：只许说 internal，细节进日志
    "message.list": () => {
      throw new Error("读 /home/secret/ai-zen.db 的时候炸了");
    },
  };
}

const logger: HubLogger = {
  warn: (message, detail) => {
    logged.push({ level: "warn", message, detail });
  },
  error: (message, detail) => {
    logged.push({ level: "error", message, detail });
  },
};

async function fakeFinalize(request: UploadFinalizeRequest): Promise<AssetRef> {
  finalized.push(request);
  await fs.rename(request.tempPath, join(assetsDir, `${request.uploadId}.png`));
  return {
    assetId: request.uploadId,
    mime: request.mime,
    bytes: request.bytes,
    name: request.name,
    width: null,
    height: null,
  };
}

async function startHub(overrides: Partial<WsHubOptions> = {}): Promise<void> {
  const uploads = new UploadReceiver({ assetsDir, finalize: fakeFinalize });
  hub = new WsHub({
    host: "127.0.0.1",
    port: 0,
    verifyToken: {
      verify: async (token) => (token === TOKEN ? { id: "cred-1", note: "test" } : null),
    },
    handlers: handlers(),
    uploads,
    hostVersion: "0.1.0-alpha.0",
    startedAt: NOW,
    logger,
    ...overrides,
  });
  hubReference = hub;
  const address = await hub.listen();
  url = `ws://127.0.0.1:${address.port}`;
}

async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(url);
  clients.push(client);
  return client;
}

/** 连上并握手 */
async function connectAuthorized(language?: Language): Promise<TestClient> {
  const client = await connect();
  await client.hello(TOKEN, { language });
  return client;
}

// ---------------------------------------------------------------------------
// 握手与鉴权
// ---------------------------------------------------------------------------

describe("握手与鉴权（PLAN A5 / D8）", () => {
  it("没有 hello 的请求一律 unauthorized，握手之后才放行", async () => {
    await startHub();
    const client = await connect();

    client.request("workspace.list", {});
    const rejected = await client.queue.next();
    expect(isError(rejected)).toBe(true);
    expect(isError(rejected) && rejected.error.data.code).toBe("unauthorized");

    // 连接没被踢掉：补上握手就能继续用
    const hello = await client.hello(TOKEN);
    expect((hello.result as { language: Language }).language).toBe("en");
    expect(hub.connectionInfos()[0]?.credentialId).toBe("cred-1");
  });

  it("未握手时连未知方法名也不透露（仍是 unauthorized）", async () => {
    await startHub();
    const client = await connect();

    client.request("no.such.method", {});
    const frame = await client.queue.next();
    expect(isError(frame) && frame.error.data.code).toBe("unauthorized");
  });

  it("凭证不对被拒，之后仍然不能调别的方法", async () => {
    await startHub();
    const client = await connect();

    client.request("host.hello", {
      token: "wrong-token",
      clientInfo: { name: "test", version: "0.0.0" },
    });
    const rejected = await client.queue.next();
    expect(isError(rejected) && rejected.error.data.code).toBe("unauthorized");
    expect(isError(rejected) && rejected.error.data.detail).toMatchObject({
      reason: "token_rejected",
    });

    client.request("workspace.list", {});
    const stillRejected = await client.queue.next();
    expect(isError(stillRejected) && stillRejected.error.data.code).toBe("unauthorized");
    expect(hub.connectionInfos().every((info) => info.credentialId === null)).toBe(true);
  });

  it("hello 的出参带语言、版本、能力 id 与上限（R57）", async () => {
    await startHub();
    const client = await connect();

    const { result } = await client.hello(TOKEN, { language: "zh-CN" });
    expect(result).toMatchObject({
      language: "zh",
      hostVersion: "0.1.0-alpha.0",
      protocolVersion: PROTOCOL_VERSION,
      startedAt: NOW,
      limits: { maxAssetBytes: MAX_ASSET_BYTES, maxAssetsPerMessage: 4 },
    });
  });

  it("认不出的语言回落英文", async () => {
    await startHub();
    const client = await connect();
    const { result } = await client.hello(TOKEN, { language: "kl-GL" });
    expect((result as { language: Language }).language).toBe("en");
  });

  it("host.setLanguage 改的是这条连接的语言", async () => {
    await startHub();
    const first = await connectAuthorized("en");
    const second = await connectAuthorized("en");

    const { result } = await first.call("host.setLanguage", { language: "zh" });
    expect(result).toEqual({ language: "zh" });
    expect(hub.connectionInfos().filter((info) => info.language === "zh")).toHaveLength(1);

    // 另一条连接的语言不受影响：同一次错误的文案各不相同
    first.request("conversation.get", { conversationId: "c-1" });
    second.request("conversation.get", { conversationId: "c-1" });
    const firstError = await first.queue.next();
    const secondError = await second.queue.next();
    expect(isError(firstError) && firstError.error.data.message).toBe(
      render("zh", "error.notFound", { entity: "conversation" }),
    );
    expect(isError(secondError) && secondError.error.data.message).toBe(
      render("en", "error.notFound", { entity: "conversation" }),
    );
  });
});

// ---------------------------------------------------------------------------
// 分发与错误
// ---------------------------------------------------------------------------

describe("分发与错误（PLAN §6）", () => {
  it("正确凭证可以调到注入的 handler", async () => {
    await startHub();
    const client = await connectAuthorized();

    const { result } = await client.call("workspace.create", { cwd: "/tmp/proj", name: "项目一" });
    expect(result).toEqual({
      workspace: {
        id: "ws-1",
        name: "项目一",
        folder: { cwd: "/tmp/proj", exists: true },
        createdAt: NOW,
        updatedAt: NOW,
        conversationCount: 0,
        lastActivityAt: null,
      },
    });
  });

  it("没注册的方法回 unsupported（W4 会补的那些域现在就是这样）", async () => {
    await startHub();
    const client = await connectAuthorized();

    client.request("config.get", {});
    const frame = await client.queue.next();
    expect(isError(frame) && frame.error.data.code).toBe("unsupported");
    expect(isError(frame) && frame.error.data.detail).toMatchObject({
      reason: "handler_not_registered",
    });
  });

  it("未知方法名回 unsupported", async () => {
    await startHub();
    const client = await connectAuthorized();

    client.request("nothing.here", {});
    const frame = await client.queue.next();
    expect(isError(frame) && frame.error.data.code).toBe("unsupported");
    expect(isError(frame) && frame.error.data.detail).toMatchObject({ reason: "unknown_method" });
  });

  it("业务错误出网是「码 + 渲染好的句子 + detail」", async () => {
    await startHub();
    const client = await connectAuthorized("zh");

    client.request("conversation.get", { conversationId: "c-1" });
    const frame = await client.queue.next();
    expect(isError(frame)).toBe(true);
    if (!isError(frame)) return;
    expect(frame.error.data.code).toBe("not_found");
    expect(frame.error.data.message).toBe(render("zh", "error.notFound", { entity: "conversation" }));
    // JSON-RPC 的 message 与 data.message 是同一句人话
    expect(frame.error.message).toBe(frame.error.data.message);
    expect(frame.error.code).toBe(-32004);
  });

  it("非业务错误收敛成 internal：栈与内部路径都不出网", async () => {
    await startHub();
    const client = await connectAuthorized();

    client.request("message.list", { conversationId: "c-1" });
    const frame = await client.queue.next();
    expect(isError(frame) && frame.error.data.code).toBe("internal");
    const wire = JSON.stringify(frame);
    expect(wire).not.toContain("/home/secret");
    expect(wire).not.toContain("at ");
    // 细节进了日志
    expect(logged.some((entry) => entry.level === "error")).toBe(true);
  });

  it("坏 JSON 帧回 invalid_params，并尽量对上请求 id", async () => {
    await startHub();
    const client = await connectAuthorized();

    client.sendText('{"jsonrpc":"2.0","id":77,"method":"workspace.list","params":');
    const frame = await client.queue.next();
    expect(isError(frame)).toBe(true);
    if (!isError(frame)) return;
    // id 能挡出来就对上，客户端才知道是哪个请求坏了
    expect(frame.id).toBe(77);
    expect(frame.error.data.code).toBe("invalid_params");
    expect(frame.error.data.detail).toMatchObject({ reason: "not_json" });
  });

  it("批量请求（数组）被拒：unsupported（R11）", async () => {
    await startHub();
    const client = await connectAuthorized();

    client.sendText('[{"jsonrpc":"2.0","id":1,"method":"workspace.list","params":{}}]');
    const frame = await client.queue.next();
    expect(isError(frame) && frame.error.data.code).toBe("unsupported");
    expect(isError(frame) && frame.error.data.detail).toMatchObject({
      reason: "batch_not_supported",
      count: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// 推送
// ---------------------------------------------------------------------------

describe("推送（PRD L5 / R47）", () => {
  it("推送是通知帧（无 id），载荷就是事件本体", async () => {
    await startHub();
    const client = await connectAuthorized();

    hub.push("notice", {
      notice: {
        id: "n-1",
        level: "info",
        duration: 2,
        text: { code: "notice.settingsApplied", messageKey: "notice.settingsApplied", params: {}, message: "" },
        conversationId: null,
        createdAt: NOW,
      },
      at: NOW,
    });

    const frame = await client.queue.next();
    expect(isNotification(frame)).toBe(true);
    if (!isNotification(frame)) return;
    expect(frame.method).toBe("notice");
    expect(frame.params).toMatchObject({ notice: { id: "n-1" } });
    expect("id" in frame).toBe(false);
  });

  it("推送不重放：断线期间的事件不会补给后来的连接", async () => {
    await startHub();
    const first = await connectAuthorized();
    first.request("workspace.list", {});
    await first.queue.next();

    hub.push("state", {
      conversationId: "c-1",
      status: "busy",
      at: NOW,
    });
    expect(isNotification(await first.queue.next())).toBe(true);

    await first.close();
    const second = await connectAuthorized();
    // 断线期间/重连之后都没有补偿：连接上应该什么都没有
    await wait(120);
    expect(second.queue.size()).toBe(0);

    // 在线时照推
    hub.push("conversation.changed", {
      conversationId: "c-1",
      workspaceId: "ws-1",
      change: "renamed",
      at: NOW,
    });
    const frame = await second.queue.next();
    expect(isNotification(frame) && frame.method).toBe("conversation.changed");
  });

  it("推送可按连接语言渲染（D8：语言挂在连接上）", async () => {
    // 注入口的形状是泛型的（按事件名各不相同），用例里只处理 notice，其余原样返回
    const localizeNotice = ((
      event: EventName,
      payload: EventMap[EventName],
      language: Language,
    ): EventMap[EventName] => {
      if (event !== "notice") return payload;
      const notice = (payload as EventMap["notice"]).notice;
      return {
        ...(payload as EventMap["notice"]),
        notice: {
          ...notice,
          text: { ...notice.text, message: `[${language}] ${notice.text.messageKey}` },
        },
      };
    }) as EventLocalizer;

    await startHub({ localizeEvent: localizeNotice });
    const zh = await connectAuthorized("zh");
    const en = await connectAuthorized("en");

    hub.push("notice", {
      notice: {
        id: "n-2",
        level: "info",
        duration: null,
        text: {
          code: "notice.settingsApplied",
          messageKey: "notice.settingsApplied",
          params: {},
          message: "（产生现场渲染的那份）",
        },
        conversationId: null,
        createdAt: NOW,
      },
      at: NOW,
    });

    const zhFrame = await zh.queue.next();
    const enFrame = await en.queue.next();
    const textOf = (frame: typeof zhFrame): string =>
      (frame as { params: { notice: { text: { message: string } } } }).params.notice.text.message;
    expect(textOf(zhFrame)).toBe("[zh] notice.settingsApplied");
    expect(textOf(enFrame)).toBe("[en] notice.settingsApplied");
  });

  it("未握手的连接收不到推送", async () => {
    await startHub();
    const client = await connect();

    hub.push("conversation.changed", {
      conversationId: "c-1",
      workspaceId: "ws-1",
      change: "renamed",
      at: NOW,
    });

    await wait(80);
    expect(client.queue.size()).toBe(0);
  });

  it("conversation.send 的推送排在回包之后，另一段对话的推送不受影响", async () => {
    await startHub();
    const client = await connectAuthorized();

    client.request("conversation.send", { conversationId: "c-1", input: { content: "hi" } });

    // 1) 另一段对话的增量先到（它没被缓冲）
    const other = await client.queue.next();
    expect(isNotification(other) && other.method).toBe("message.delta");
    expect(isNotification(other) && (other.params as { conversationId: string }).conversationId).toBe(
      "another-conversation",
    );

    // 2) 然后是回包（受理即返回，客户端据此拿到那条用户消息的 id）
    const response = await client.queue.next();
    expect(isSuccess(response)).toBe(true);
    expect((response as { result: ConversationSendResult }).result).toMatchObject({
      userMessageId: "u-1",
      attachments: [],
    });

    // 3) 最后才是这段对话被缓冲的增量
    const buffered = await client.queue.next();
    expect(isNotification(buffered) && buffered.method).toBe("message.delta");
    expect((buffered as { params: { conversationId: string } }).params.conversationId).toBe("c-1");

    // 缓冲队列已经放空
    await wait(50);
    expect(client.queue.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

describe("二进制上传（A11 / PRD D5、F-H8）", () => {
  it("begin → chunk → chunk → end 四段走通", async () => {
    await startHub();
    const client = await connectAuthorized();

    const bytes = new Uint8Array(3000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;

    const began = await client.call("asset.begin", {
      purpose: "message_image",
      mime: "image/png",
      bytes: bytes.byteLength,
      name: "photo.png",
      conversationId: "c-1",
    });
    const { uploadId, receivedBytes } = began.result as { uploadId: string; receivedBytes: number };
    expect(receivedBytes).toBe(0);

    client.sendBinary(encodeChunkFrame(uploadId, bytes.subarray(0, 1000)));
    client.sendBinary(encodeChunkFrame(uploadId, bytes.subarray(1000)));
    // 二进制帧不回包，用一次请求当「栅栏」确认它们已经被处理
    await client.call("host.setLanguage", { language: "en" });

    const ended = await client.call("asset.end", {
      uploadId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const asset = (ended.result as { asset: AssetRef }).asset;
    expect(asset.bytes).toBe(3000);
    expect(asset.mime).toBe("image/png");
    expect(asset.name).toBe("photo.png");

    // 临时文件没了，正式文件在、内容一致
    expect(await listDir(assetsDir)).toEqual([`${uploadId}.png`]);
    const written = await fs.readFile(join(assetsDir, `${uploadId}.png`));
    expect(new Uint8Array(written)).toEqual(bytes);
    expect(finalized[0]).toMatchObject({ conversationId: "c-1", purpose: "message_image" });
  });

  it("超限在 begin 就拒（payload_too_large），不建临时文件", async () => {
    await startHub();
    const client = await connectAuthorized();

    client.request("asset.begin", {
      purpose: "message_image",
      mime: "image/png",
      bytes: MAX_ASSET_BYTES + 1,
      conversationId: "c-1",
    });
    const frame = await client.queue.next();
    expect(isError(frame) && frame.error.data.code).toBe("payload_too_large");
    expect(await listDir(assetsDir)).toEqual([]);
  });

  it("摘要对不上：报错并删掉临时文件", async () => {
    await startHub();
    const client = await connectAuthorized();

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const began = await client.call("asset.begin", {
      purpose: "message_image",
      mime: "image/png",
      bytes: bytes.byteLength,
      conversationId: "c-1",
    });
    const uploadId = (began.result as { uploadId: string }).uploadId;
    client.sendBinary(encodeChunkFrame(uploadId, bytes));
    await client.call("host.setLanguage", { language: "en" });

    client.request("asset.end", { uploadId, sha256: "0".repeat(64) });
    const frame = await client.queue.next();
    expect(isError(frame) && frame.error.data.code).toBe("invalid_params");
    expect(isError(frame) && frame.error.data.detail).toMatchObject({ reason: "digest_mismatch" });
    expect(await listDir(assetsDir)).toEqual([]);
  });

  it("断线时清掉这条连接名下未完成的上传", async () => {
    await startHub();
    const client = await connectAuthorized();

    const began = await client.call("asset.begin", {
      purpose: "message_image",
      mime: "image/png",
      bytes: 100,
      conversationId: "c-1",
    });
    const uploadId = (began.result as { uploadId: string }).uploadId;
    client.sendBinary(encodeChunkFrame(uploadId, new Uint8Array(10)));
    await client.call("host.setLanguage", { language: "en" });
    expect((await listDir(assetsDir)).length).toBe(1);

    await client.close();
    await wait(120);

    expect(await listDir(assetsDir)).toEqual([]);
    // 断线清理之后 hub 里也不留这条连接
    expect(hub.connectionInfos()).toHaveLength(0);
  });

  it("未握手的二进制帧被拒，且不落盘", async () => {
    await startHub();
    const client = await connect();

    client.sendBinary(encodeChunkFrame("some-upload", new Uint8Array([1, 2, 3])));
    const frame = await client.queue.next();
    expect(isError(frame) && frame.error.data.code).toBe("unauthorized");
    expect(await listDir(assetsDir)).toEqual([]);
  });

  it("分片被拒时错误帧带 uploadId（二进制帧没有 id，只能靠 detail 认出是哪一趟）", async () => {
    await startHub();
    const client = await connectAuthorized();

    // 一个不存在的 uploadId：分片本身是好的，只是这趟上传不在这条连接上
    client.sendBinary(encodeChunkFrame("no-such-upload", new Uint8Array([1, 2, 3])));
    const frame = await client.queue.next();
    expect(isError(frame)).toBe(true);
    if (!isError(frame)) return;
    expect(frame.id).toBeNull();
    expect(frame.error.data.code).toBe("not_found");
    expect(frame.error.data.detail).toMatchObject({
      uploadId: "no-such-upload",
      reason: "unknown_upload_id",
    });
  });

  it("分片超过声明总长：错误帧的码与 uploadId 都能对上", async () => {
    await startHub();
    const client = await connectAuthorized();

    const began = await client.call("asset.begin", {
      purpose: "message_image",
      mime: "image/png",
      bytes: 4,
      conversationId: "c-1",
    });
    const uploadId = (began.result as { uploadId: string }).uploadId;
    client.sendBinary(encodeChunkFrame(uploadId, new Uint8Array(5)));

    const frame = await client.queue.next();
    expect(isError(frame)).toBe(true);
    if (!isError(frame)) return;
    expect(frame.error.data.code).toBe("payload_too_large");
    expect(frame.error.data.detail).toMatchObject({
      uploadId,
      reason: "exceeds_declared_bytes",
    });
  });

  it("坏帧解不出 uploadId 时不硬编造一个", async () => {
    await startHub();
    const client = await connectAuthorized();

    client.sendBinary(new Uint8Array([0, 0]));
    const frame = await client.queue.next();
    expect(isError(frame)).toBe(true);
    if (!isError(frame)) return;
    expect(frame.error.data.code).toBe("invalid_params");
    expect(frame.error.data.detail).toMatchObject({ reason: "frame_too_short" });
    expect((frame.error.data.detail as { uploadId?: unknown }).uploadId).toBeUndefined();
  });

  it("`asset.begin` 把这条连接的语言交给落库那一步（cwd 消息的渲染语言）", async () => {
    const ensured: [string, Language][] = [];
    const uploads = new UploadReceiver({
      assetsDir,
      finalize: fakeFinalize,
      ensureConversation: async (conversationId, language) => {
        ensured.push([conversationId, language]);
      },
    });
    await startHub({ uploads });
    const client = await connectAuthorized("zh");

    await client.call("asset.begin", {
      purpose: "message_image",
      mime: "image/png",
      bytes: 4,
      conversationId: "draft-1",
    });

    expect(ensured).toEqual([["draft-1", "zh"]]);
  });

  it("对话不存在的错误是业务码，不是 internal", async () => {
    const uploads = new UploadReceiver({
      assetsDir,
      finalize: fakeFinalize,
      ensureConversation: async (conversationId) => {
        throw new HostError("not_found", {
          params: { entity: "conversation" },
          detail: { conversationId },
        });
      },
    });
    await startHub({ uploads });
    const client = await connectAuthorized("zh");

    client.request("asset.begin", {
      purpose: "message_image",
      mime: "image/png",
      bytes: 4,
      conversationId: "no-such-conversation",
    });
    const frame = await client.queue.next();
    expect(isError(frame)).toBe(true);
    if (!isError(frame)) return;
    expect(frame.error.data.code).toBe("not_found");
    expect(frame.error.data.detail).toMatchObject({ conversationId: "no-such-conversation" });
    // 句子按这条连接的语言渲染
    expect(frame.error.data.message).toBe(render("zh", "error.notFound", { entity: "conversation" }));
    expect(await listDir(assetsDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

describe("收尾", () => {
  it("close 之后所有连接都断开", async () => {
    await startHub();
    const client = await connectAuthorized();

    await hub.close();
    await client.closed();
    expect(hub.connectionInfos()).toHaveLength(0);
  });
});
