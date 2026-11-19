/**
 * 上传接收器的验收：三段式的状态机、分帧落盘、长度与摘要校验、以及三条清理路径。
 *
 * 这里直接调 `UploadReceiver`（不经 WebSocket）：帧的**编码**是协议的一部分（`encodeChunkFrame`），
 * 用它拼出来的字节与客户端发出来的一致，所以不必为此再走一遍网络。端到端那条路在
 * `WsHub.test.ts` 里，真发二进制帧。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../wire/errors.js";
import {
  MAX_ASSET_BYTES,
  type AssetBeginParams,
  type AssetBeginResult,
  type AssetRef,
} from "../wire/index.js";
import {
  decodeChunkFrame,
  encodeChunkFrame,
  formatBytes,
  UploadReceiver,
  type UploadFinalizeRequest,
} from "./UploadReceiver.js";
import { listDir, makeTempDir, type TempDir } from "./TestSupport.js";

let dir: TempDir;
let assetsDir: string;
let finalized: UploadFinalizeRequest[];
let receiver: UploadReceiver;

const CONNECTION = "conn-1";

/** 一段可校验的字节（内容不重要，只要 sha256 对得上） */
function payload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 取本次 `begin` 的上传句柄。
 *
 * `uploadId` 在契约里可空：命中会话内去重时它没有句柄（客户端不必再传）。这几条用例走的都是
 * 新上传，所以这里要一个非空值；`null` 就说明 behaviour 变了，直接让用例红。
 */
function handleOf(began: AssetBeginResult): string {
  if (began.uploadId === null) throw new Error("新上传没有拿到 uploadId");
  return began.uploadId;
}

/** 收完之后的落定：把临时文件改成正式文件，回一个引用（真实现是 `AssetService.finalizeUpload`） */
async function fakeFinalize(request: UploadFinalizeRequest): Promise<AssetRef> {
  finalized.push(request);
  await fs.rename(request.tempPath, join(assetsDir, `${request.uploadId}.bin`));
  return {
    assetId: request.uploadId,
    mime: request.mime,
    bytes: request.bytes,
    name: request.name,
    width: null,
    height: null,
  };
}

beforeEach(async () => {
  dir = await makeTempDir("upload");
  assetsDir = join(dir.path, "assets");
  finalized = [];
  receiver = new UploadReceiver({ assetsDir, finalize: fakeFinalize });
});

afterEach(async () => {
  await receiver.dispose();
  await dir.remove();
});

describe("三段式上传", () => {
  it("begin → 两片 → end：落盘、校验、落定", async () => {
    const bytes = payload(4096);
    const began = await receiver.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: bytes.byteLength,
      name: "photo.png",
      sessionId: "c1",
    });
    expect(began.receivedBytes).toBe(0);
    expect(began.maxBytes).toBe(MAX_ASSET_BYTES);
    // 临时文件已经开了，但内容还是空的
    expect(await listDir(assetsDir)).toEqual([`.upload-${handleOf(began)}.part`]);

    await receiver.receiveBinary(CONNECTION, encodeChunkFrame(handleOf(began), bytes.subarray(0, 1024)));
    const received = await receiver.receiveBinary(
      CONNECTION,
      encodeChunkFrame(handleOf(began), bytes.subarray(1024)),
    );
    expect(received).toBe(bytes.byteLength);

    const ended = await receiver.end(CONNECTION, {
      uploadId: handleOf(began),
      sha256: sha256(bytes),
    });

    expect(ended.asset.bytes).toBe(bytes.byteLength);
    expect(ended.asset.mime).toBe("image/png");
    expect(ended.asset.name).toBe("photo.png");
    // 临时文件没了，正式文件在，内容一致
    expect(await listDir(assetsDir)).toEqual([`${handleOf(began)}.bin`]);
    const written = await fs.readFile(join(assetsDir, `${handleOf(began)}.bin`));
    expect(new Uint8Array(written)).toEqual(bytes);
    // 落定时拿到的是校验过的事实
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({
      mime: "image/png",
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      sessionId: "c1",
      purpose: "message_image",
    });
    expect(receiver.pendingCount()).toBe(0);
  });

  it("同一连接上并发两个上传：靠 uploadId 区分，互不串字节", async () => {
    const first = payload(1000);
    const second = payload(2000);

    const beganFirst = await receiver.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: first.byteLength,
      sessionId: "c1",
    });
    const beganSecond = await receiver.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/jpeg",
      bytes: second.byteLength,
      sessionId: "c1",
    });
    expect(handleOf(beganFirst)).not.toBe(handleOf(beganSecond));
    expect(receiver.pendingCount(CONNECTION)).toBe(2);

    // 交错的帧：各回各的上传
    await receiver.receiveBinary(CONNECTION, encodeChunkFrame(handleOf(beganFirst), first.subarray(0, 400)));
    await receiver.receiveBinary(CONNECTION, encodeChunkFrame(handleOf(beganSecond), second.subarray(0, 900)));
    await receiver.receiveBinary(CONNECTION, encodeChunkFrame(handleOf(beganFirst), first.subarray(400)));
    await receiver.receiveBinary(CONNECTION, encodeChunkFrame(handleOf(beganSecond), second.subarray(900)));

    const endedSecond = await receiver.end(CONNECTION, {
      uploadId: handleOf(beganSecond),
      sha256: sha256(second),
    });
    const endedFirst = await receiver.end(CONNECTION, {
      uploadId: handleOf(beganFirst),
      sha256: sha256(first),
    });

    expect(endedFirst.asset.bytes).toBe(1000);
    expect(endedSecond.asset.bytes).toBe(2000);
    expect(endedSecond.asset.mime).toBe("image/jpeg");
  });
});

describe("拒绝与清理", () => {
  it("超限在 begin 就拒（不是收完再说不行）", async () => {
    const error = await receiver
      .begin(CONNECTION, {
        purpose: "message_image",
        mime: "image/png",
        bytes: MAX_ASSET_BYTES + 1,
        sessionId: "c1",
      })
      .catch((caught: unknown) => caught);

    expect(HostError.is(error)).toBe(true);
    expect((error as HostError).code).toBe("payload_too_large");
    // 什么都没建出来
    expect(await listDir(assetsDir)).toEqual([]);
    expect(receiver.pendingCount()).toBe(0);
  });

  it("缺会话归属时拒（库里的素材行要挂在一段会话上）", async () => {
    // 入参是网络上来的 JSON：类型上是必填字段，运行时仍然可能没带（契约不替客户端把关）
    const withoutSession = {
      purpose: "message_image",
      mime: "image/png",
      bytes: 10,
    } as unknown as AssetBeginParams;
    const error = await receiver
      .begin(CONNECTION, withoutSession)
      .catch((caught: unknown) => caught);

    expect((error as HostError).code).toBe("invalid_params");
    expect((error as HostError).detail).toMatchObject({ field: "sessionId" });
  });

  it("总长不符：删临时文件并报错", async () => {
    const bytes = payload(100);
    const began = await receiver.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: bytes.byteLength,
      sessionId: "c1",
    });
    await receiver.receiveBinary(CONNECTION, encodeChunkFrame(handleOf(began), bytes.subarray(0, 60)));

    const error = await receiver
      .end(CONNECTION, { uploadId: handleOf(began), sha256: sha256(bytes) })
      .catch((caught: unknown) => caught);

    expect((error as HostError).code).toBe("invalid_params");
    expect((error as HostError).detail).toMatchObject({
      reason: "size_mismatch",
      declaredBytes: 100,
      receivedBytes: 60,
    });
    expect(await listDir(assetsDir)).toEqual([]);
    expect(finalized).toEqual([]);
  });

  it("摘要不符：删临时文件并报错", async () => {
    const bytes = payload(100);
    const began = await receiver.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: bytes.byteLength,
      sessionId: "c1",
    });
    await receiver.receiveBinary(CONNECTION, encodeChunkFrame(handleOf(began), bytes));

    const error = await receiver
      .end(CONNECTION, { uploadId: handleOf(began), sha256: sha256(payload(99)) })
      .catch((caught: unknown) => caught);

    expect((error as HostError).detail).toMatchObject({ reason: "digest_mismatch" });
    expect(await listDir(assetsDir)).toEqual([]);
  });

  it("分片超过声明总长：立刻删文件并报 payload_too_large", async () => {
    const began = await receiver.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: 10,
      sessionId: "c1",
    });

    const error = await receiver
      .receiveBinary(CONNECTION, encodeChunkFrame(handleOf(began), payload(11)))
      .catch((caught: unknown) => caught);

    expect((error as HostError).code).toBe("payload_too_large");
    expect((error as HostError).detail).toMatchObject({ reason: "exceeds_declared_bytes" });
    expect(await listDir(assetsDir)).toEqual([]);
  });

  it("连接断开：这条连接名下未完成的上传连临时文件一起清掉", async () => {
    const began = await receiver.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: 100,
      sessionId: "c1",
    });
    await receiver.receiveBinary(CONNECTION, encodeChunkFrame(handleOf(began), payload(50)));
    expect((await listDir(assetsDir)).length).toBe(1);

    await receiver.abortConnection(CONNECTION);

    expect(await listDir(assetsDir)).toEqual([]);
    expect(receiver.pendingCount()).toBe(0);
    // 断了之后再 end：按「没有这个上传」处理
    const error = await receiver
      .end(CONNECTION, { uploadId: handleOf(began), sha256: sha256(payload(100)) })
      .catch((caught: unknown) => caught);
    expect((error as HostError).code).toBe("not_found");
  });

  it("落定失败：临时文件也清掉", async () => {
    const failing = new UploadReceiver({
      assetsDir,
      finalize: async () => {
        throw new Error("登记失败");
      },
    });
    const bytes = payload(32);
    const began = await failing.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: bytes.byteLength,
      sessionId: "c1",
    });
    await failing.receiveBinary(CONNECTION, encodeChunkFrame(handleOf(began), bytes));

    await expect(
      failing.end(CONNECTION, { uploadId: handleOf(began), sha256: sha256(bytes) }),
    ).rejects.toThrow("登记失败");
    expect(await listDir(assetsDir)).toEqual([]);
  });
});

describe("草稿会话的落库（R56）", () => {
  it("begin 先让归属的会话落库、再开临时文件，语言跟着连接走", async () => {
    const ensured: [string, string][] = [];
    const withHook = new UploadReceiver({
      assetsDir,
      finalize: fakeFinalize,
      ensureSession: async (sessionId, language) => {
        ensured.push([sessionId, language]);
        // 落库先于开临时文件：这一刻 assets/ 里什么都不该有
        expect(await listDir(assetsDir)).toEqual([]);
      },
    });

    const began = await withHook.begin(
      CONNECTION,
      { purpose: "message_image", mime: "image/png", bytes: 4, sessionId: "draft-1" },
      "zh",
    );

    expect(ensured).toEqual([["draft-1", "zh"]]);
    expect(await listDir(assetsDir)).toEqual([`.upload-${handleOf(began)}.part`]);
    await withHook.dispose();
  });

  it("连接没声明语言时用缺省语言", async () => {
    const ensured: string[] = [];
    const withHook = new UploadReceiver({
      assetsDir,
      finalize: fakeFinalize,
      ensureSession: async (_sessionId, language) => {
        ensured.push(language);
      },
    });

    await withHook.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: 4,
      sessionId: "draft-1",
    });

    expect(ensured).toEqual(["en"]);
    await withHook.dispose();
  });

  it("会话不存在：业务码原样出网，不建临时文件、不占上传句柄", async () => {
    const withHook = new UploadReceiver({
      assetsDir,
      finalize: fakeFinalize,
      ensureSession: async (sessionId) => {
        throw new HostError("not_found", {
          params: { entity: "session" },
          detail: { sessionId },
        });
      },
    });

    const error = await withHook
      .begin(CONNECTION, {
        purpose: "message_image",
        mime: "image/png",
        bytes: 4,
        sessionId: "no-such-session",
      })
      .catch((caught: unknown) => caught);

    expect(HostError.is(error)).toBe(true);
    expect((error as HostError).code).toBe("not_found");
    expect((error as HostError).detail).toMatchObject({
      sessionId: "no-such-session",
    });
    expect(await listDir(assetsDir)).toEqual([]);
    expect(withHook.pendingCount()).toBe(0);
    await withHook.dispose();
  });

  it("落库时的非业务异常收敛成 internal（不是一句裸错误）", async () => {
    const reported: string[] = [];
    const withHook = new UploadReceiver({
      assetsDir,
      finalize: fakeFinalize,
      ensureSession: async () => {
        throw new Error("disk I/O error");
      },
      onError: (_error, context) => {
        reported.push(context);
      },
    });

    const error = await withHook
      .begin(CONNECTION, {
        purpose: "message_image",
        mime: "image/png",
        bytes: 4,
        sessionId: "draft-1",
      })
      .catch((caught: unknown) => caught);

    expect(HostError.is(error)).toBe(true);
    expect((error as HostError).code).toBe("internal");
    expect((error as HostError).detail).toMatchObject({
      reason: "session_persist_failed",
      sessionId: "draft-1",
    });
    // 原始错误也进了日志口子
    expect(reported).toEqual(["让会话落库失败"]);
    expect(await listDir(assetsDir)).toEqual([]);
    await withHook.dispose();
  });
});

describe("二进制帧", () => {
  it("编码/解码往返，片段字节原样取回", () => {
    const chunk = payload(17);
    const frame = encodeChunkFrame("upload-1", chunk);
    const decoded = decodeChunkFrame(frame);
    expect(decoded.uploadId).toBe("upload-1");
    expect(decoded.chunk).toEqual(chunk);
  });

  it("片段为空也合法（只是没字节）", () => {
    const decoded = decodeChunkFrame(encodeChunkFrame("upload-1", new Uint8Array(0)));
    expect(decoded.chunk.byteLength).toBe(0);
  });

  it("坏帧给出可读的原因", () => {
    const cases: [string, Uint8Array, string][] = [
      ["太短", new Uint8Array([0, 0]), "frame_too_short"],
      ["头长度越界", Uint8Array.from([0x7f, 0xff, 0xff, 0xff]), "bad_header_length"],
      ["头被截断", Uint8Array.from([0, 0, 0, 40, 123]), "truncated_header"],
    ];
    for (const [, frame, reason] of cases) {
      const error = captureError(() => decodeChunkFrame(frame));
      expect(HostError.is(error)).toBe(true);
      expect((error as HostError).detail).toMatchObject({ reason });
    }

    const headerOf = (json: string): Uint8Array => {
      const header = new TextEncoder().encode(json);
      const frame = new Uint8Array(4 + header.byteLength);
      new DataView(frame.buffer).setUint32(0, header.byteLength, false);
      frame.set(header, 4);
      return frame;
    };
    expect((captureError(() => decodeChunkFrame(headerOf("不是 JSON"))) as HostError).detail).toMatchObject({
      reason: "header_not_json",
    });
    expect((captureError(() => decodeChunkFrame(headerOf("{}"))) as HostError).detail).toMatchObject({
      reason: "header_without_upload_id",
    });
  });
});

describe("formatBytes", () => {
  it("按 1024 进制、最多一位小数", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(MAX_ASSET_BYTES)).toBe("20 MB");
  });
});

function captureError(run: () => void): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("全局去重（begin 命中即结束）", () => {
  const EXISTING: AssetRef = {
    assetId: "asset-existing",
    mime: "image/png",
    bytes: 1024,
    name: "photo.png",
    width: null,
    height: null,
  };

  it("带 sha256 且库里已有同一份：直接回既有引用，不建临时文件、不分配 uploadId", async () => {
    const looked: Array<{ sha256: string; bytes: number }> = [];
    const deduping = new UploadReceiver({
      assetsDir,
      finalize: fakeFinalize,
      findExisting: async (input) => {
        looked.push(input);
        return EXISTING;
      },
    });

    const began = await deduping.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: EXISTING.bytes,
      name: "photo.png",
      sha256: "a".repeat(64),
      sessionId: "c1",
    });

    expect(began).toEqual({
      deduped: true,
      uploadId: null,
      maxBytes: MAX_ASSET_BYTES,
      receivedBytes: 0,
      asset: EXISTING,
    });
    expect(looked).toEqual([{ sha256: "a".repeat(64), bytes: EXISTING.bytes }]);
    // 一个字节都不收：没有临时文件，也没有挂着的上传
    expect(await listDir(assetsDir)).toEqual([]);
    expect(deduping.pendingCount()).toBe(0);
    // 落定根本没发生（没有新素材）
    expect(finalized).toEqual([]);
    await deduping.dispose();
  });

  it("去重命中也要先确认会话存在（不存在的会话一个字节也不收）", async () => {
    const ensured: string[] = [];
    const deduping = new UploadReceiver({
      assetsDir,
      finalize: fakeFinalize,
      ensureSession: async (sessionId) => {
        ensured.push(sessionId);
      },
      findExisting: async () => EXISTING,
    });

    const began = await deduping.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: EXISTING.bytes,
      sha256: "a".repeat(64),
      sessionId: "draft-1",
    });

    expect(began.deduped).toBe(true);
    // 去重是全局的（按内容摘要），命中并不证明这段会话存在，所以落库这一步不能跳过
    expect(ensured).toEqual(["draft-1"]);
    expect(await listDir(assetsDir)).toEqual([]);
    await deduping.dispose();
  });

  it("去重命中且会话不存在：仍然报 not_found（不静默回一份别人的素材）", async () => {
    const deduping = new UploadReceiver({
      assetsDir,
      finalize: fakeFinalize,
      ensureSession: async (sessionId) => {
        throw new HostError("not_found", {
          params: { entity: "session" },
          detail: { sessionId },
        });
      },
      findExisting: async () => EXISTING,
    });

    await expect(
      deduping.begin(CONNECTION, {
        purpose: "message_image",
        mime: "image/png",
        bytes: EXISTING.bytes,
        sha256: "a".repeat(64),
        sessionId: "no-such-session",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await deduping.dispose();
  });

  it("没命中（或没带 sha256）：照常开临时文件，deduped=false", async () => {
    const deduping = new UploadReceiver({
      assetsDir,
      finalize: fakeFinalize,
      findExisting: async () => null,
    });
    const bytes = payload(64);

    const missed = await deduping.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      sessionId: "c1",
    });
    expect(missed.deduped).toBe(false);
    expect(missed.asset).toBeNull();
    expect(await listDir(assetsDir)).toEqual([`.upload-${handleOf(missed)}.part`]);

    // 没带 sha256 的上传不问去重（客户端没算，宿主不猜）
    const noDigest = await deduping.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: bytes.byteLength,
      sessionId: "c1",
    });
    expect(noDigest.deduped).toBe(false);
    expect(deduping.pendingCount(CONNECTION)).toBe(2);
    await deduping.dispose();
  });

  it("sha256 格式不对：按参数错拒（不是静默当成没带）", async () => {
    const deduping = new UploadReceiver({
      assetsDir,
      finalize: fakeFinalize,
      findExisting: async () => EXISTING,
    });

    await expect(
      deduping.begin(CONNECTION, {
        purpose: "message_image",
        mime: "image/png",
        bytes: 4,
        sha256: "not-a-digest",
        sessionId: "c1",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await deduping.dispose();
  });

  it("去重查询本身炸了：按没命中继续（去重是优化，不是上传的前提）", async () => {
    const deduping = new UploadReceiver({
      assetsDir,
      finalize: fakeFinalize,
      findExisting: async () => {
        throw new Error("db down");
      },
      onError: () => undefined,
    });

    const began = await deduping.begin(CONNECTION, {
      purpose: "message_image",
      mime: "image/png",
      bytes: 4,
      sha256: "b".repeat(64),
      sessionId: "c1",
    });
    expect(began.deduped).toBe(false);
    expect(deduping.pendingCount(CONNECTION)).toBe(1);
    await deduping.dispose();
  });
});
