import { describe, it, expect } from "vitest";
import { encodeFrame, MAX_PAYLOAD_BYTES, MAX_TEXT_BYTES } from "./frames.js";

/**
 * 这一版 `wire/frames.ts` 里只剩「编码 + 两个上限」：分帧交给 WebSocket 了，所以这里没有解码器
 * 可测 —— 上一版那批用例（半帧跨 chunk / 二进制阶段 / `expectBytes` 的上限）随 `FrameDecoder`
 * 一起删掉了，测它已经没有对应的实现（A3）。
 *
 * 剩下的三条都是**与对端逐字同构**的那部分：服务端发回来的 `\n` 约定、以及两个上限的取值。
 * 它们跑错的话症状在线上（一条 JSON 多一个尾字节、或者一条消息被误判成超限），不在类型里。
 */
describe("encodeFrame", () => {
  it("就是 JSON.stringify：没有结尾换行（边界只有 WebSocket 一个来源）", () => {
    const text = encodeFrame({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(text).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(text.endsWith("\n")).toBe(false);
  });

  it("编出来的东西解回去与原来相等（含中文与字符串里的换行）", () => {
    const frame = { text: "第一行\n第二行", n: 1, nested: { ok: true }, 中文: "值" };
    expect(JSON.parse(encodeFrame(frame))).toEqual(frame);
  });

  it("`params` 为 undefined 时整键消失（不是 `null`）", () => {
    expect(encodeFrame({ jsonrpc: "2.0", id: 1, method: "status", params: undefined })).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"status"}',
    );
  });
});

describe("体积上限", () => {
  it("单条消息 64 MiB（交给 WS 的 maxPayload）；文本另卡 8 MiB", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_TEXT_BYTES).toBe(8 * 1024 * 1024);
    // 两档各管一侧：文本的那一档必须更小，否则它等于不存在
    expect(MAX_TEXT_BYTES).toBeLessThan(MAX_PAYLOAD_BYTES);
  });
});
