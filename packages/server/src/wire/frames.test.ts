import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  FrameDecoder,
  MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  ProtocolError,
  type DecodedItem,
} from "./frames.js";

/**
 * 喂一段字节，取出能取的全部项。
 *
 * `onFrame` 给出「这一帧之后要不要收二进制」的判定 —— 与生产调用方（Daemon）同一个形状：
 * 解码器自己不认识方法名，要不要进二进制阶段由调用方说。
 */
function collect(
  decoder: FrameDecoder,
  chunk?: Buffer,
  onFrame?: (frame: unknown) => number | null,
): DecodedItem[] {
  if (chunk) decoder.push(chunk);
  const items: DecodedItem[] = [];
  for (let item = decoder.next(); item; item = decoder.next()) {
    items.push(item);
    if (item.type === "frame") {
      const length = onFrame?.(item.frame);
      if (typeof length === "number") decoder.expectBytes(length);
    }
  }
  return items;
}

/** 只取解码出的 JSON 帧（payload 项由 `payloadsOf` 单独看） */
function framesOf(items: DecodedItem[]): unknown[] {
  return items
    .filter((item) => item.type === "frame")
    .map((item) => (item.type === "frame" ? item.frame : undefined));
}

/** 只取解码出的二进制 payload（二进制阶段的用例反过来） */
function payloadsOf(items: DecodedItem[]): Buffer[] {
  return items.filter((item) => item.type === "bytes").map((item) => item.bytes);
}

/** 帧里的 `params.bytes` 声明的长度（真实调用方的判据就是这个） */
function declaredLength(frame: unknown): number | null {
  const bytes = (frame as { params?: { bytes?: unknown } } | null)?.params?.bytes;
  return typeof bytes === "number" ? bytes : null;
}

describe("FrameDecoder", () => {
  it("一行一帧：同一段数据里的多个帧按顺序切出来", () => {
    const decoder = new FrameDecoder();
    expect(framesOf(collect(decoder, Buffer.from('{"a":1}\n{"b":2}\n')))).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  it("半帧跨 chunk：收齐之后才吐出来", () => {
    const decoder = new FrameDecoder();
    expect(collect(decoder, Buffer.from('{"he'))).toEqual([]);
    expect(collect(decoder, Buffer.from('llo":true}'))).toEqual([]);
    expect(framesOf(collect(decoder, Buffer.from("\n")))).toEqual([{ hello: true }]);
  });

  it("多字节字符跨 chunk：只在整行上解 UTF-8（不切成半个字）", () => {
    const decoder = new FrameDecoder();
    const line = Buffer.from(encodeFrame({ text: "中文" }), "utf-8");
    // 硬切在「中」的中间字节上
    const cut = line.indexOf(Buffer.from("中", "utf-8")) + 1;
    expect(collect(decoder, line.subarray(0, cut))).toEqual([]);
    expect(framesOf(collect(decoder, line.subarray(cut)))).toEqual([{ text: "中文" }]);
  });

  it("空行忽略（心跳保活 / 粘贴多一个换行）", () => {
    const decoder = new FrameDecoder();
    expect(collect(decoder, Buffer.from("\n\n  \n"))).toEqual([]);
  });

  it("encodeFrame 产出的东西喂回去能还原（含中文与转义的换行）", () => {
    const decoder = new FrameDecoder();
    const payload = { text: "第一行\n第二行", n: 1, nested: { ok: true } };
    expect(framesOf(collect(decoder, Buffer.from(encodeFrame(payload))))).toEqual([payload]);
  });

  it("非 JSON 帧报 bad-frame（不静默丢弃）", () => {
    const decoder = new FrameDecoder();
    expect(() => collect(decoder, Buffer.from("not json\n"))).toThrow(ProtocolError);
    try {
      collect(decoder, Buffer.from("not json\n"));
    } catch (error) {
      expect((error as ProtocolError).code).toBe("bad-frame");
    }
  });

  it("半帧累积超上限报 frame-too-large：一条不发换行的连接不能把内存吃光", () => {
    const decoder = new FrameDecoder();
    expect(() => collect(decoder, Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78))).toThrow(ProtocolError);
  });
});

describe("FrameDecoder：二进制阶段", () => {
  it("payload 与帧在同一个 chunk 里：从自己的缓冲里切出来，后面还能接着按行切帧", () => {
    const decoder = new FrameDecoder();
    const head = '{"id":1,"method":"content.upload","params":{"bytes":4}}';
    const chunk = Buffer.concat([
      Buffer.from(`${head}\n`),
      Buffer.from([0x00, 0x0a, 0xff, 0x41]), // 里面就有 0x0A：二进制阶段不能按它切
      Buffer.from('{"id":2,"method":"next"}\n'),
    ]);

    const items = collect(decoder, chunk, declaredLength);
    // 顺序是「帧 → payload → 下一个帧」，payload 一个字节都没走丢、也没被解码
    expect(items.map((item) => item.type)).toEqual(["frame", "bytes", "frame"]);
    expect(payloadsOf(items)).toEqual([Buffer.from([0x00, 0x0a, 0xff, 0x41])]);
    expect(framesOf(items)).toEqual([
      { id: 1, method: "content.upload", params: { bytes: 4 } },
      { id: 2, method: "next" },
    ]);
  });

  it("payload 跨多个 chunk：收满之前一个字节都不吐，收满之后接着解析下一帧", () => {
    const decoder = new FrameDecoder();
    const frame = '{"id":7,"method":"content.upload","params":{"bytes":6}}';
    expect(payloadsOf(collect(decoder, Buffer.from(`${frame}\nAB`), declaredLength))).toEqual([]);
    expect(payloadsOf(collect(decoder))).toEqual([]);
    expect(payloadsOf(collect(decoder, Buffer.from("CD")))).toEqual([]);

    const items = collect(decoder, Buffer.from('EF\n{"id":8,"method":"next"}\n'), declaredLength);
    expect(items.map((item) => item.type)).toEqual(["bytes", "frame"]);
    expect(payloadsOf(items)).toEqual([Buffer.from("ABCDEF")]);
    expect(framesOf(items)).toEqual([{ id: 8, method: "next" }]);
  });

  it("二进制阶段不把 0x0A 当帧边界：一整块 payload 原样收下", () => {
    const decoder = new FrameDecoder();
    decoder.expectBytes(3);
    expect(payloadsOf(collect(decoder, Buffer.from("\n\n\n")))).toEqual([Buffer.from("\n\n\n")]);
  });

  it("长度非法（非正整数）报 bad-frame", () => {
    for (const length of [0, -1, 1.5, Number.NaN]) {
      const decoder = new FrameDecoder();
      expect(() => decoder.expectBytes(length)).toThrow(ProtocolError);
      try {
        decoder.expectBytes(length);
      } catch (error) {
        expect((error as ProtocolError).code).toBe("bad-frame");
      }
    }
  });

  it("长度超上限报 frame-too-large：在收第一个字节之前就拒", () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.expectBytes(MAX_PAYLOAD_BYTES + 1)).toThrow(ProtocolError);
    try {
      decoder.expectBytes(MAX_PAYLOAD_BYTES + 1);
    } catch (error) {
      expect((error as ProtocolError).code).toBe("frame-too-large");
    }
  });
});
