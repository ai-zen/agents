/**
 * 帧解码器的**二进制阶段** —— 客户端这一侧的那一份（与服务端 `wire/frames.ts` 逐字相同，
 * 所以这几条用例在两边跑的是同一段判据）。
 *
 * 题目只有三件：payload 与帧在同一个 chunk 里到达、payload 跨 chunk、以及收满之后还能接着
 * 按行切帧。客户端目前只**发** payload（服务端不推二进制），但解码器是两侧共用的一份实现 ——
 * 它坏一半，下一次「服务端也要推字节」时坏的就是线上。
 */

import { describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD_BYTES,
  ProtocolError,
  FrameDecoder,
  encodeFrame,
  type DecodedItem,
} from "./frames.js";

/** 喂一段字节并取出全部项；`onFrame` 是「这一帧后面要不要收二进制」的判定（与调用方同形） */
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

/** 帧里的 `params.bytes` 声明的长度 */
function declaredLength(frame: unknown): number | null {
  const bytes = (frame as { params?: { bytes?: unknown } } | null)?.params?.bytes;
  return typeof bytes === "number" ? bytes : null;
}

describe("FrameDecoder：二进制阶段", () => {
  it("payload 与帧在同一个 chunk 里：先出帧、再出 payload，然后回到按行切帧", () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([
      Buffer.from(`${encodeFrame({ id: 1, method: "content.upload", params: { bytes: 3 } })}`),
      Buffer.from([0x0a, 0x00, 0xff]),
      Buffer.from(encodeFrame({ id: 2, method: "next" })),
    ]);

    const items = collect(decoder, chunk, declaredLength);
    expect(items.map((item) => item.type)).toEqual(["frame", "bytes", "frame"]);
    expect(items[1]).toEqual({ type: "bytes", bytes: Buffer.from([0x0a, 0x00, 0xff]) });
  });

  it("payload 跨 chunk：没收满不出项，收满之后接上下一帧", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ id: 9, method: "content.upload", params: { bytes: 4 } });
    expect(collect(decoder, Buffer.from(`${frame}A`), declaredLength)).toHaveLength(1);
    expect(collect(decoder, Buffer.from("B"))).toHaveLength(0);

    const items = collect(decoder, Buffer.from(`CD${encodeFrame({ id: 10, method: "next" })}`));
    expect(items.map((item) => item.type)).toEqual(["bytes", "frame"]);
    expect(items[0]).toEqual({ type: "bytes", bytes: Buffer.from("ABCD") });
  });

  it("长度非法（非正整数 / 超上限）当场抛：收第一个字节之前就拒", () => {
    for (const length of [0, -1, 2.5]) {
      expect(() => new FrameDecoder().expectBytes(length)).toThrow(ProtocolError);
    }
    try {
      new FrameDecoder().expectBytes(MAX_PAYLOAD_BYTES + 1);
    } catch (error) {
      expect((error as ProtocolError).code).toBe("frame-too-large");
    }
  });
});
