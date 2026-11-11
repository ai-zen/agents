/**
 * `session/errors.ts` 的用例：「这段会话还在不在」这一个判断的两半（码 / 文案）与一条退路。
 *
 * 为什么值得单独立一组：这条判据决定「重连还要不要再试三次」。判错的方向有两个，都很难在
 * 真链路上看见 —— 只认一个码时，服务端重启之后一半的场景会白试三次；把「连接断了」误判成
 * 「会话没了」则会让本可以接回来的会话直接以失败告终。两个方向都是纯字符串判断，直接喂
 * 错误对象最快。
 *
 * 数据用 `codedError`（本包 `wire/errors.ts` 里那个**真的**造码错误的函数）而不是手挂 `code`：`codeOf` 靠
 * 结构判定 + 码表校验，手挂一个不在表里的字符串会被判成「没有码」，那样用例验的就不是本
 * 文件的逻辑了。
 */

import { describe, expect, it } from "vitest";
import type { ErrorCode } from "@ai-zen/agents-server/protocol";
import { ERROR_CODES, codedError } from "../wire/errors.js";
import { connectionLostError, isSessionGone, isSessionGoneCode } from "./errors.js";

describe("isSessionGone：服务端说这段会话没了", () => {
  it("`session-missing`（`attach` 的答案）算「没了」", () => {
    expect(isSessionGoneCode("session-missing")).toBe(true);
    expect(isSessionGone(codedError("session-missing", "这段会话不在盘上"))).toBe(true);
  });

  it("`unknown-session`（其余会话方法的答案）**同样**算「没了」", () => {
    // 两个码说的是同一件事，只认一个就会漏掉一半 —— 这正是审计发现桌面端踩的那条：
    // 服务端重启之后 TUI 会重连、桌面端不会
    expect(isSessionGoneCode("unknown-session")).toBe(true);
    expect(isSessionGone(codedError("unknown-session", "没有这段活会话"))).toBe(true);
  });

  it("别的码（这一轮太忙 / 参数不对 / 模型不存在）不叫「没了」：那是该改请求或该等，不是该放弃", () => {
    const NOT_GONE: ErrorCode[] = [
      "turn-busy",
      "turn-in-flight",
      "bad-params",
      "unknown-model",
      "no-handoff",
    ];
    for (const code of NOT_GONE) {
      expect(isSessionGoneCode(code)).toBe(false);
      expect(isSessionGone(codedError(code, "别的原因"))).toBe(false);
    }
  });

  it("没有结构化 `code` 时退回看 message 前缀（自造错误只带得了文案）", () => {
    expect(isSessionGone(new Error(`${"session-missing"}: chat_1`))).toBe(true);
    expect(isSessionGone(new Error(`${"unknown-session"}: chat_1`))).toBe(true);
    // 只是「文案里提到过」不算：前缀对不上就不该放弃重连
    expect(isSessionGone(new Error("failed to attach: session-missing?"))).toBe(false);
    expect(isSessionGone(new Error("boom"))).toBe(false);
  });

  it("非 Error 值按字符串看；`connectionLostError` 的文案形状随有没有地址而变", () => {
    // 没有结构化 code、也不是 Error：退回 `String(value)`（抛出物可能是字符串/对象）
    expect(isSessionGone(`${"unknown-session"}: chat_1`)).toBe(true);
    expect(isSessionGone(undefined)).toBe(false);
    expect(isSessionGone({ code: "session-missing" })).toBe(false);

    // 知道连到哪：沿用 socket 断开的形状（主机 + 端口），排查时能直接看出是哪一条
    expect(connectionLostError({ host: "127.0.0.1", port: 4321 }).message).toBe(
      "connection closed (127.0.0.1:4321), reconnect failed",
    );
    // 连接从未建起来（`this.client` 还是 null）：不带端口那一段，不能印出 `(:0)`
    expect(connectionLostError().message).toBe("connection closed, reconnect failed");
    // 它不带码：这是客户端造的句子，不是线上事实 —— 所以不该被当成「会话没了」
    expect(isSessionGone(connectionLostError())).toBe(false);
  });
});
