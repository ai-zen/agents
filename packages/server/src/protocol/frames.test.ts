import { describe, it, expect } from "vitest";
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES, ProtocolError } from "./frames.js";

/** 一次喂多帧：验证切分与顺序 */
describe("FrameDecoder", () => {
  it("一行一帧：同一段数据里的多个帧按顺序切出来", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("半帧跨 chunk：收齐之后才吐出来", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push('{"he')).toEqual([]);
    expect(decoder.push('llo":true}')).toEqual([]);
    expect(decoder.push("\n")).toEqual([{ hello: true }]);
  });

  it("空行忽略（心跳保活 / 粘贴多一个换行）", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push("\n\n  \n")).toEqual([]);
  });

  it("encodeFrame 产出的东西喂回去能还原（含中文与转义的换行）", () => {
    const decoder = new FrameDecoder();
    const payload = { text: "第一行\n第二行", n: 1, nested: { ok: true } };
    expect(decoder.push(encodeFrame(payload))).toEqual([payload]);
  });

  it("非 JSON 帧报 bad-frame（不静默丢弃）", () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push("not json\n")).toThrow(ProtocolError);
    try {
      decoder.push("not json\n");
    } catch (error) {
      expect((error as ProtocolError).code).toBe("bad-frame");
    }
  });

  it("半帧累积超上限报 frame-too-large：一条不发换行的连接不能把内存吃光", () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push("x".repeat(MAX_FRAME_BYTES + 1))).toThrow(ProtocolError);
  });
});
