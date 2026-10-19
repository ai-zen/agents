import { describe, it, expect, vi } from "vitest";
import { ContextGuardPlugin } from "./ContextGuardPlugin.js";
import { ContextOverflowError } from "../shared/errors.js";

function mockAgent(opts: { lastUsage?: { prompt_tokens?: number } }) {
  return {
    lastUsage: opts.lastUsage,
  };
}

function buildCtx(agent: any): any {
  return { agent, content: "hello", messages: [] };
}

describe("ContextGuardPlugin", () => {
  it("返回一个 AgentPlugin（有 onInnerLoopStart）", () => {
    const plugin = new ContextGuardPlugin({ maxTokens: 250_000 });
    expect(typeof plugin.onInnerLoopStart).toBe("function");
  });

  it("默认 ratio 为 1.5（+50%）", async () => {
    const agent = mockAgent({ lastUsage: { prompt_tokens: 250_001 } });
    const plugin = new ContextGuardPlugin({ maxTokens: 250_000 });
    // 250001 > 250000*1.5(375000)？否 → 不抛
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("lastUsage 为 undefined（首轮请求前）时不抛错", async () => {
    const agent = mockAgent({ lastUsage: undefined });
    const plugin = new ContextGuardPlugin({ maxTokens: 250_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("用量未达到硬上限时不抛错", async () => {
    const agent = mockAgent({ lastUsage: { prompt_tokens: 200_000 } });
    const plugin = new ContextGuardPlugin({ maxTokens: 250_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  it("用量超过硬上限（maxTokens*ratio）时抛出 ContextOverflowError", async () => {
    const agent = mockAgent({ lastUsage: { prompt_tokens: 400_000 } });
    const plugin = new ContextGuardPlugin({ maxTokens: 250_000 });
    const ctx = buildCtx(agent);

    try {
      await plugin.onInnerLoopStart!(ctx);
      expect.unreachable("应当抛出异常");
    } catch (err) {
      expect(err).toBeInstanceOf(ContextOverflowError);
      const e = err as ContextOverflowError;
      expect(e.promptTokens).toBe(400_000);
      expect(e.maxTokens).toBe(250_000);
      expect(e.ratio).toBe(1.5);
      expect(e.threshold).toBe(375_000);
    }
  });

  it("支持自定义 ratio", async () => {
    // ratio=1.5，硬上限 250000*1.5=375000
    const agent = mockAgent({ lastUsage: { prompt_tokens: 380_000 } });
    const plugin = new ContextGuardPlugin({ maxTokens: 250_000, ratio: 1.5 });
    const ctx = buildCtx(agent);

    await expect(plugin.onInnerLoopStart!(ctx)).rejects.toBeInstanceOf(ContextOverflowError);
  });

  it("等于硬上限的边界值不抛错（> 而非 >=）", async () => {
    const agent = mockAgent({ lastUsage: { prompt_tokens: 375_000 } });
    const plugin = new ContextGuardPlugin({ maxTokens: 250_000 });
    await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
  });

  describe("isSuspended（交接回合放宽）", () => {
    it("处于交接回合时改用 suspendedRatio（默认 2.0）→ 1.5 倍用量不再报错", async () => {
      // 400_000 > 250_000*1.5=375_000（正常会抛），但 < 250_000*2=500_000
      const agent = mockAgent({ lastUsage: { prompt_tokens: 400_000 } });
      const plugin = new ContextGuardPlugin({
        maxTokens: 250_000,
        isSuspended: () => true,
      });

      await expect(plugin.onInnerLoopStart!(buildCtx(agent))).resolves.toBeUndefined();
    });

    it("交接回合仍保留熔断：超过 suspendedRatio 依旧报错", async () => {
      const agent = mockAgent({ lastUsage: { prompt_tokens: 600_000 } });
      const plugin = new ContextGuardPlugin({
        maxTokens: 250_000,
        isSuspended: () => true,
      });

      try {
        await plugin.onInnerLoopStart!(buildCtx(agent));
        expect.unreachable("应当抛出异常");
      } catch (err) {
        expect(err).toBeInstanceOf(ContextOverflowError);
        expect((err as ContextOverflowError).ratio).toBe(2);
        expect((err as ContextOverflowError).threshold).toBe(500_000);
      }
    });

    it("支持自定义 suspendedRatio", async () => {
      const agent = mockAgent({ lastUsage: { prompt_tokens: 450_000 } });
      const plugin = new ContextGuardPlugin({
        maxTokens: 250_000,
        isSuspended: () => true,
        suspendedRatio: 1.6,
      });

      await expect(plugin.onInnerLoopStart!(buildCtx(agent))).rejects.toBeInstanceOf(
        ContextOverflowError,
      );
    });

    it("未处于交接回合时保持原 ratio", async () => {
      const agent = mockAgent({ lastUsage: { prompt_tokens: 400_000 } });
      const plugin = new ContextGuardPlugin({
        maxTokens: 250_000,
        isSuspended: () => false,
      });

      await expect(plugin.onInnerLoopStart!(buildCtx(agent))).rejects.toBeInstanceOf(
        ContextOverflowError,
      );
    });
  });
});
