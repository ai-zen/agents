/**
 * 上传的三段式（`asset.begin` → 二进制帧 → `asset.end`）的验收。
 *
 * 用一个**真 WebSocket 的假服务端**钉住客户端这一半的行为，四件事：
 *
 *   1. **分帧正确**：写出去的二进制帧按 `chunkFrame` 的形状能被原样拆回来，按顺序拼起来就是原文件；
 *   2. **本地先拒**：单张超上限、空文件、认不出类型 —— 这些错不该等到 `asset.begin` 才出现，
 *      更不该把字节传上去再说不行；
 *   3. **摘要不符要如实失败**：`asset.end` 被拒时 `uploadAsset` 抛的是服务端那句 `ClientError`，
 *      不是「上传成功」；
 *   4. **两个上传不串**：同一条连接上并发两个上传，各自的帧只带自己的 `uploadId`，谁也不吃掉谁的字节。
 *
 * 假服务端按方法名答题，二进制帧只记录不处理（这段用例真正要判断的是客户端写出去的字节）。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClientInfo } from "@ai-zen/agents-server";

import { Client } from "./client.js";
import { decodeChunkFrame } from "./chunkFrame.js";
import { ClientError } from "./errors.js";
import {
  DEFAULT_MAX_ASSET_BYTES,
  uploadAsset,
  uploadAssets,
} from "./upload.js";
import {
  FakeMethodError,
  helloResult,
  startFakeServer,
  type FakeServer,
} from "./testSupport/fakeServer.js";

const CLIENT_INFO: ClientInfo = { name: "upload-test", version: "0.0.0-test" };
const CONVERSATION_ID = "conv-upload-1";

/** 造一段可辨认的字节（每片内容不同，串台时一眼能看出来） */
function bytesOf(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + seed) % 251;
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 取下假服务端收到的全部二进制帧（opcode 2） */
function binaryFrames(server: FakeServer): Uint8Array[] {
  return server.messages.filter((message) => message.opcode === 0x2).map((m) => new Uint8Array(m.data));
}

/** 把某一个 `uploadId` 的帧按到达顺序拼回原字节 */
function bytesOfUpload(server: FakeServer, uploadId: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const frame of binaryFrames(server)) {
    const decoded = decodeChunkFrame(frame);
    if (decoded.uploadId === uploadId) chunks.push(decoded.chunk);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** 每次 `asset.begin` 发一个不同的句柄，`asset.end` 回一条引用 */
function uploadMethods(counter: { begins: number }) {
  return {
    "asset.begin": (params: unknown) => {
      counter.begins += 1;
      return {
        uploadId: `upload-${counter.begins}`,
        maxBytes: DEFAULT_MAX_ASSET_BYTES,
        receivedBytes: 0,
      };
    },
    "asset.end": (params: unknown) => {
      const { uploadId, sha256: digest } = params as { uploadId: string; sha256: string };
      return {
        asset: {
          assetId: `asset-${uploadId}`,
          mime: "image/png",
          bytes: 0,
          name: null,
          width: null,
          height: null,
        },
        digest,
      };
    },
    // 上传之后要能继续走 JSON-RPC：二进制帧不应该把文本通道弄坏
    "server.version": () => ({
      version: "0.0.0-test",
      protocolVersion: "1",
      startedAt: "2026-01-01T00:00:00.000Z",
      pid: 4242,
    }),
  };
}

let server: FakeServer;
let client: Client;

beforeAll(async () => {
  const counter = { begins: 0 };
  server = await startFakeServer({
    methods: {
      ...uploadMethods(counter),
      ...helloLimits(),
    },
  });
  client = await Client.connect({
    target: server.address,
    token: "test-token",
    clientInfo: CLIENT_INFO,
    language: "zh",
  });
});

afterAll(async () => {
  await client.close();
  await server.close();
});

/** 握手里的上限改成小值：这样超限用例不必真的分配 20MB */
function helloLimits() {
  return {
    "server.hello": () =>
      helloResult({ limits: { maxAssetBytes: 1024, maxAssetsPerMessage: 4 } }),
  };
}

describe("分帧", () => {
  it("按 chunkSize 切片、按顺序写帧，拼回来就是原字节，摘要也对得上", async () => {
    const payload = bytesOf(1000, 7);
    const before = binaryFrames(server).length;

    const asset = await uploadAsset(client, {
      conversationId: CONVERSATION_ID,
      data: payload,
      mime: "image/png",
      name: "shot.png",
      chunkSize: 300,
    });

    const frames = binaryFrames(server).slice(before);
    // 1000 字节按 300 切：300 + 300 + 300 + 100
    expect(frames.map((frame) => decodeChunkFrame(frame).chunk.byteLength)).toEqual([
      300, 300, 300, 100,
    ]);
    // 每一帧都带着同一个上传句柄（同一条连接上并发多个上传时靠它区分）
    const uploadIds = new Set(frames.map((frame) => decodeChunkFrame(frame).uploadId));
    expect(uploadIds.size).toBe(1);

    expect(asset.assetId).toBe("asset-upload-1");
    expect(bytesOfUpload(server, "upload-1")).toEqual(payload);

    // `asset.begin` 声明的是真实尺寸与类型，`asset.end` 给的是真摘要
    const begin = server.frames.find((frame) => frame.method === "asset.begin");
    expect(begin?.params).toEqual({
      purpose: "message_image",
      mime: "image/png",
      bytes: 1000,
      name: "shot.png",
      conversationId: CONVERSATION_ID,
    });
    const end = server.frames.filter((frame) => frame.method === "asset.end").at(-1);
    expect(end?.params).toEqual({ uploadId: "upload-1", sha256: sha256(payload) });
  });

  it("文本帧与二进制帧在同一条连接上互不影响（JSON-RPC 照常收发）", async () => {
    const before = server.frames.length;
    await uploadAsset(client, {
      conversationId: CONVERSATION_ID,
      data: bytesOf(10, 1),
      mime: "image/png",
    });
    // 上传之后这条连接仍然能正常调方法（二进制帧没有被当成坏 JSON 处理掉）
    const version = await client.call("server.version");
    expect(version.protocolVersion).toBe("1");
    expect(server.frames.length).toBeGreaterThan(before);
  });
});

describe("本地前置校验", () => {
  it("单张超过握手给的上限：本地就拒，一个字节都不发", async () => {
    const beforeFrames = server.messages.length;
    const error = (await uploadAsset(client, {
      conversationId: CONVERSATION_ID,
      data: bytesOf(2048, 3),
      mime: "image/png",
    }).catch((caught: unknown) => caught)) as ClientError;

    expect(error).toBeInstanceOf(ClientError);
    expect(error.code).toBe("asset_too_large");
    expect(error.fromServer).toBe(false);
    // 上限与尺寸都在那句话里（1 KB / 2 KB），用户不必猜
    expect(error.message).toContain("2 KB");
    expect(error.message).toContain("1 KB");
    expect(server.messages.length).toBe(beforeFrames);
  });

  it("空文件：本地拒（没有可上传的内容）", async () => {
    const error = (await uploadAsset(client, {
      conversationId: CONVERSATION_ID,
      data: new Uint8Array(0),
      mime: "image/png",
    }).catch((caught: unknown) => caught)) as ClientError;
    expect(error.code).toBe("asset_empty");
  });

  it("读不了的文件：给的是路径与原因，不是一句 unexpected", async () => {
    const error = (await uploadAsset(client, {
      conversationId: CONVERSATION_ID,
      path: join(tmpdir(), "ai-zen-does-not-exist.png"),
    }).catch((caught: unknown) => caught)) as ClientError;

    expect(error.code).toBe("asset_unreadable");
    expect(error.message).toContain("ai-zen-does-not-exist.png");
  });

  it("从文件路径上传：类型按扩展名认，名字取文件名", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ai-zen-upload-"));
    const file = join(dir, "picture.png");
    const payload = bytesOf(120, 5);
    await fs.writeFile(file, payload);
    try {
      await uploadAsset(client, { conversationId: CONVERSATION_ID, path: file });
      const begin = server.frames.filter((frame) => frame.method === "asset.begin").at(-1);
      expect(begin?.params).toMatchObject({
        mime: "image/png",
        name: "picture.png",
        bytes: 120,
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("服务端的拒", () => {
  it("摘要不符：`asset.end` 的失败原样抛出来（不假成功）", async () => {
    // 一个把收到的字节改掉一个位的服务端：它算出的摘要必然与客户端给的不同
    const strict = await startFakeServer({
      methods: {
        "asset.begin": () => ({ uploadId: "up-x", maxBytes: DEFAULT_MAX_ASSET_BYTES, receivedBytes: 0 }),
        "asset.end": () => {
          throw new FakeMethodError({
            code: "invalid_params",
            message: "上传的字节与摘要对不上",
            detail: { reason: "digest_mismatch" },
          });
        },
      },
    });
    const strictClient = await Client.connect({
      target: strict.address,
      token: "test-token",
      clientInfo: CLIENT_INFO,
      language: "zh",
    });
    try {
      const error = (await uploadAsset(strictClient, {
        conversationId: CONVERSATION_ID,
        data: bytesOf(64, 9),
        mime: "image/png",
      }).catch((caught: unknown) => caught)) as ClientError;

      expect(error.code).toBe("invalid_params");
      expect(error.fromServer).toBe(true);
      // 文案是服务端渲染的那句，客户端不另写一份
      expect(error.message).toBe("上传的字节与摘要对不上");
      expect(error.detail).toEqual({ reason: "digest_mismatch" });
    } finally {
      await strictClient.close();
      await strict.close();
    }
  });

  it("`asset.begin` 就拒（超过服务端上限）：字节一个都没出去", async () => {
    const strict = await startFakeServer({
      methods: {
        "asset.begin": () => {
          throw new FakeMethodError({
            code: "payload_too_large",
            message: "图片太大（30 MB），上限 20 MB",
            detail: { reason: "over_asset_limit" },
          });
        },
      },
    });
    const strictClient = await Client.connect({
      target: strict.address,
      token: "test-token",
      clientInfo: CLIENT_INFO,
      language: "zh",
    });
    try {
      const error = (await uploadAsset(strictClient, {
        conversationId: CONVERSATION_ID,
        data: bytesOf(64, 11),
        mime: "image/png",
      }).catch((caught: unknown) => caught)) as ClientError;

      expect(error.code).toBe("payload_too_large");
      expect(error.message).toBe("图片太大（30 MB），上限 20 MB");
      expect(strict.messages.filter((message) => message.opcode === 0x2)).toEqual([]);
    } finally {
      await strictClient.close();
      await strict.close();
    }
  });
});

describe("并发", () => {
  it("同一条连接上并发两个上传：各自的帧只带自己的 uploadId，字节不串", async () => {
    const first = bytesOf(700, 21);
    const second = bytesOf(500, 22);

    const [a, b] = await Promise.all([
      uploadAsset(client, {
        conversationId: CONVERSATION_ID,
        data: first,
        mime: "image/png",
        chunkSize: 128,
      }),
      uploadAsset(client, {
        conversationId: CONVERSATION_ID,
        data: second,
        mime: "image/jpeg",
        chunkSize: 128,
      }),
    ]);

    expect(a.assetId).not.toBe(b.assetId);
    const uploadIdA = a.assetId.replace("asset-", "");
    const uploadIdB = b.assetId.replace("asset-", "");

    // 两条上传的字节各自完整，且互不污染（拼错一个字节这里的比较就会失败）
    expect(bytesOfUpload(server, uploadIdA)).toEqual(first);
    expect(bytesOfUpload(server, uploadIdB)).toEqual(second);

    // 每个 `asset.end` 用的都是自己那条上传的摘要
    const ends = server.frames.filter((frame) => frame.method === "asset.end").slice(-2);
    const digests = ends.map((frame) => (frame.params as { sha256: string }).sha256);
    expect(digests.slice().sort()).toEqual([sha256(first), sha256(second)].sort());
  });

  it("一次给多份：前 N 张照常上传，超出的逐条报告（不静默丢）", async () => {
    const sources = [0, 1, 2, 3, 4, 5].map((index) => ({
      data: bytesOf(16, index),
      mime: "image/png",
      name: `${index}.png`,
    }));

    const result = await uploadAssets(client, { conversationId: CONVERSATION_ID, sources });

    // 握手说一条消息最多 4 张：前 4 张成了，第 5、6 张各有一条明确的失败
    expect(result.assets).toHaveLength(4);
    expect(result.failures.map((failure) => failure.index)).toEqual([4, 5]);
    expect(result.failures.map((failure) => failure.name)).toEqual(["4.png", "5.png"]);
    for (const failure of result.failures) {
      expect(failure.error.code).toBe("asset_count_exceeded");
      expect(failure.error.message).toContain("4");
    }
  });

  it("批量里有一份坏的：它进 failures，其余照常上传", async () => {
    const result = await uploadAssets(client, {
      conversationId: CONVERSATION_ID,
      sources: [
        { data: bytesOf(8, 31), mime: "image/png" },
        { data: new Uint8Array(0), mime: "image/png", name: "empty.png" },
        { data: bytesOf(8, 32), mime: "image/png" },
      ],
    });

    expect(result.assets).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.name).toBe("empty.png");
    expect(result.failures[0]?.error.code).toBe("asset_empty");
  });
});

describe("连接状态", () => {
  it("连接已关：第一步就本地拒，不写到一条不存在的连接上", async () => {
    const closed = await Client.connect({
      target: server.address,
      token: "test-token",
      clientInfo: CLIENT_INFO,
      language: "zh",
    });
    await closed.close();

    // 关掉之后 `asset.begin` 发不出去：本地上游就把这一趟上传结束了
    const error = (await uploadAsset(closed, {
      conversationId: CONVERSATION_ID,
      data: bytesOf(8, 41),
      mime: "image/png",
    }).catch((caught: unknown) => caught)) as ClientError;
    expect(error.code).toBe("closed");
  });
});
