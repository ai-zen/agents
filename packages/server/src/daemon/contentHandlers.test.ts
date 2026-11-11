/**
 * `content.upload` 的接线测试 —— 字节进、内容块出。
 *
 * 这里要证明的只有「接线」和「归属」：参数形状、端点按**这段会话的实发模型名**反查、
 * 上传 / 内联 / 退化三条路各自走到 SDK 的实现上。转换规则本身由 SDK 的
 * `content-blocks.test.ts` 测透，这里不重测一遍 —— 那会变成两份会漂的判据。
 *
 * 字节不真上传：`upload` 是注入点（生产缺省是 OpenAI 兼容的 `POST {baseUrl}/files`）。
 * 用例要断言的是「交给上传的是不是那批原始字节」，而不是 HTTP 本身。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContentHandlers } from "./contentHandlers.js";
import type { ContentHandlerOptions } from "./contentHandlers.js";
import type { Connection } from "./Daemon.js";
import { clearUploadCache } from "@ai-zen/agents-sdk";
import type { AppConfig } from "@ai-zen/agents-sdk";

/** 一条「够用」的连接：`content.upload` 不看连接，但假件按真件写 */
const connection: Connection = {
  id: 1,
  send: () => {},
  close: () => {},
  onClose: () => () => {},
};

/** 端点能力：`filesApi: true` 才走上传，否则内联 */
function configWith(options: { filesApi?: boolean; vision?: boolean } = {}): AppConfig {
  return {
    endpoints: [
      {
        id: "e1",
        name: "E1",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "k",
        ...(options.filesApi ? { capabilities: { filesApi: true } } : {}),
      },
    ],
    models: [
      {
        id: "vision-model",
        // 别名：实发名与配置里的身份不同（端点反查必须按实发名）
        modelName: "vision-model@2026",
        name: "Vision",
        endpointId: "e1",
        // 只有 `vision === true` 才算视觉模型（SDK 的判据），所以缺省就得写 true
        vision: options.vision ?? true,
      },
    ],
  } as unknown as AppConfig;
}

/** 造一组 handler；`snapshot` 只说「这段会话用的实发模型名是什么」 */
function handlersOf(options: {
  config?: AppConfig;
  upload?: ContentHandlerOptions["upload"];
  apiModel?: string;
}) {
  return createContentHandlers({
    manager: {
      snapshot: (async () => ({ apiModel: options.apiModel ?? "vision-model@2026" })) as never,
    },
    config: { get: async () => ({ config: options.config ?? configWith(), path: "/tmp/c.json" }) },
    ...(options.upload ? { upload: options.upload } : {}),
  });
}

/** 调一次（handler 是普通函数，直接调就是它在线上的行为） */
function upload(
  handlers: ReturnType<typeof createContentHandlers>,
  params: unknown,
  payload?: Buffer,
) {
  return handlers["content.upload"]!(params as never, connection, payload);
}

/** PNG 头 + 一段含 `0x0A` 的正文：二进制阶段不许按换行切，这里顺手也钉住这一点 */
const BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from([0x0a, 0x00])]);

const PARAMS = {
  sessionId: "chat_1",
  bytes: BYTES.byteLength,
  mime: "image/png",
  filename: "a.png",
};

// 上传结果按「端点 + 内容哈希」缓存在 SDK 里（同一张图不重复上传），跨用例会串味
beforeEach(() => clearUploadCache());

describe("content.upload", () => {
  it("端点支持 Files API：上传之后回 file_id（字节原样交给上传）", async () => {
    const uploadFn = vi.fn(async (_input: unknown) => "file-123");
    const result = (await upload(
      handlersOf({ config: configWith({ filesApi: true }), upload: uploadFn }),
      PARAMS,
      BYTES,
    )) as any;

    expect(result).toEqual({ section: { type: "file", file_id: "file-123" } });
    expect(uploadFn).toHaveBeenCalledTimes(1);
    const input = uploadFn.mock.calls[0]![0] as any;
    // 交上去的就是那批原始字节（一个都没被解码 / 改过）
    expect(Buffer.from(input.data)).toEqual(BYTES);
    expect(input.filename).toBe("a.png");
    expect(input.endpoint.id).toBe("e1");
  });

  it("端点不支持 Files API：内联成 data URL（图片走 image_url）", async () => {
    const result = (await upload(handlersOf({}), PARAMS, BYTES)) as any;

    expect(result).toEqual({
      section: {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${BYTES.toString("base64")}` },
      },
    });
  });

  it("模型明确不支持视觉：退化成文本提示，说明随结果回到客户端", async () => {
    const result = (await upload(
      handlersOf({ config: configWith({ vision: false }), upload: vi.fn() }),
      PARAMS,
      BYTES,
    )) as any;

    expect(result.section.type).toBe("text");
    expect(result.section.text).toContain("a.png");
    expect(result.warning).toContain("does not support image input");
  });

  it("上传失败：降级为内联，并把原因作为 warning 递出去", async () => {
    const result = (await upload(
      handlersOf({
        config: configWith({ filesApi: true }),
        upload: async () => {
          throw new Error("boom");
        },
      }),
      PARAMS,
      BYTES,
    )) as any;

    expect(result.section.type).toBe("image_url");
    expect(result.warning).toContain("boom");
  });

  it("非图片走 file 块内联（mime 决定通道）", async () => {
    const result = (await upload(
      handlersOf({}),
      { ...PARAMS, mime: "application/pdf", filename: "a.pdf" },
      BYTES,
    )) as any;

    expect(result.section).toEqual({
      type: "file",
      file_data: `data:application/pdf;base64,${BYTES.toString("base64")}`,
      filename: "a.pdf",
    });
  });

  it("参数缺一不可 → bad-params（不猜默认值）", async () => {
    const handlers = handlersOf({});
    for (const params of [
      { bytes: 1, mime: "image/png", filename: "a.png" }, // 无 sessionId
      { sessionId: "s", bytes: 1, filename: "a.png" }, // 无 mime
      { sessionId: "s", bytes: 1, mime: "image/png" }, // 无 filename
    ]) {
      await expect(upload(handlers, params, BYTES)).rejects.toMatchObject({ code: "bad-params" });
    }
  });

  it("没有 payload → bad-params（帧层保证不会发生，但 handler 不靠这条保证活着）", async () => {
    await expect(upload(handlersOf({}), PARAMS)).rejects.toMatchObject({ code: "bad-params" });
  });
});
